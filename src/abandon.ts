// ---------------------------------------------------------------------------
// Session-end detection — automatic $sessionend for generations nobody
// interacted with.
//
// IMPORTANT: This fires $sessionend, NOT $abandon. $abandon is reserved for
// explicit user-initiated abandons (e.g. gen.event("$abandon") when the
// user closes an editor without copying). $sessionend is a session boundary
// marker: "the tab closed or the user walked away", not a quality signal.
//
// Two-layer idle detection approach:
//
//   Layer 1 (broad): Session-level idle timeout (e.g. 30 min → rotate session).
//     We don't manage sessions, so this layer is the caller's responsibility.
//
//   Layer 2 (granular): Per-generation idle timeout (5 min default).
//     A generation is "open" from creation until any behavioral signal
//     resolves it (except $view). When the user goes idle for
//     abandonThreshold ms, all open generations fire $sessionend with
//     { auto: true } metadata.
//
// Activity sources (raw DOM events that indicate a human is present):
//   mousemove, mousedown, click  — mouse users
//   keydown                      — keyboard activity
//   scroll                       — reading / browsing
//   touchstart, touchmove        — mobile users
//   resize                       — viewport changes
//
// NOT considered active (these are programmatic, not user-driven):
//   DOM mutations, style changes, canvas updates, font loads, console logs
// ---------------------------------------------------------------------------

// Raw DOM events that indicate a human is at the keyboard/mouse/screen.
const ACTIVITY_EVENTS = [
  "mousemove",
  "mousedown",
  "click",
  "keydown",
  "scroll",
  "touchstart",
  "touchmove",
  "resize",
] as const;

/**
 * Don't update lastActivityAt more than once per 100ms. Cheap alternative to debounce.
 * We throttle because raw DOM events like mousemove can fire 60+ times/sec.
 * 100ms means at most 10 updates/sec, which is negligible.
 */
const ACTIVITY_THROTTLE_MS = 100;

/** How often to scan for abandoned generations (ms). */
const IDLE_CHECK_INTERVAL_MS = 10_000;

/** Default: 5 minutes. */
export const DEFAULT_ABANDON_THRESHOLD_MS = 5 * 60 * 1_000;

/**
 * Minimal interface for a generation that the detector can mark as session-ended.
 * Avoids importing the Generation class (which would create a cycle).
 */
interface AbandonableGeneration {
  createdAt: number;
  /**
   * Fire $sessionend on this generation. Called by the detector when the
   * idle threshold is exceeded or when the page is unloading.
   *
   * This is NOT $abandon — $abandon is reserved for explicit user action
   * (e.g. closing an editor without copying). $sessionend means "the tab
   * closed or the user walked away," which is a session boundary, not a
   * quality signal.
   */
  fireSessionEnd: (metadata: Record<string, unknown>) => void;
}

/**
 * Tracks open generations and fires $sessionend when the user goes idle or
 * the page unloads.
 *
 * Lifecycle:
 *   1. Client creates AbandonDetector in constructor
 *   2. Client calls start() to register DOM activity listeners
 *   3. Client calls register() when a generation is created
 *   4. Client calls resolve() when a behavioral signal is tracked
 *   5. Detector calls fireSessionEnd() on open generations after idle threshold
 *   6. Client calls stop() on destroy/cleanup
 */
export class AbandonDetector {
  private openGenerations = new Map<string, AbandonableGeneration>();
  private lastActivityAt: number = Date.now();
  private lastCheckAt: number = Date.now();
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private activityHandler: (() => void) | null = null;
  private threshold: number;

  private checkInterval: number;

  constructor(threshold: number, checkInterval: number = IDLE_CHECK_INTERVAL_MS) {
    this.threshold = threshold;
    this.checkInterval = checkInterval;
  }

  /** Number of generations currently tracked for potential session-end emission. */
  get openCount(): number {
    return this.openGenerations.size;
  }

  /**
   * Start listening for user activity on the page.
   * Registers event listeners on window + starts the periodic idle check.
   * Only call this in browser environments (guard with typeof window check).
   */
  start() {
    // Throttled activity handler. Instead of a real debounce (which allocates
    // a timer per event), we just skip updates that happen within ACTIVITY_THROTTLE_MS
    // of the last one. This is cheaper for high-frequency events like mousemove.
    this.activityHandler = () => {
      const now = Date.now();
      if (now - this.lastActivityAt > ACTIVITY_THROTTLE_MS) {
        this.lastActivityAt = now;
      }
    };

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, this.activityHandler, { passive: true, capture: true });
    }

    // Wrap in try/catch — a throw here would kill the interval silently.
    this.idleCheckTimer = setInterval(() => {
      try {
        this.checkForAbandoned();
      } catch (e) {
        console.error("[litmus] idle check failed", e);
      }
    }, this.checkInterval);
  }

  /** Stop listening for activity and clear the idle check timer. */
  stop() {
    if (this.activityHandler) {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, this.activityHandler, { capture: true });
      }
      this.activityHandler = null;
    }
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
  }

  /** Track a new generation for potential auto-emitted $sessionend. */
  register(id: string, fireSessionEnd: (metadata: Record<string, unknown>) => void) {
    this.openGenerations.set(id, { createdAt: Date.now(), fireSessionEnd });
  }

  /** Remove a generation from tracking (it received a behavioral signal). */
  resolve(id: string) {
    this.openGenerations.delete(id);
  }

  /**
   * Check if the user has been idle long enough to emit $sessionend.
   * Called periodically by the idle check timer.
   *
   * Includes frozen tab detection: mobile browsers can freeze backgrounded
   * tabs, suspending all JS timers. When the tab unfreezes, setInterval
   * fires immediately with a massive time gap. Without this guard, every
   * open generation would falsely get $sessionend.
   *
   * Some SDKs solve this by re-reading timestamps from persistence (not
   * in-memory state). We take a simpler approach: if the elapsed time
   * since the last check is wildly larger than IDLE_CHECK_INTERVAL_MS,
   * the tab was frozen. Reset the activity timestamp and skip this cycle.
   */
  checkForAbandoned() {
    if (this.openGenerations.size === 0) return;

    const now = Date.now();

    // Frozen tab detection: if the gap since our last check is 3x+ the
    // expected interval, the tab was almost certainly frozen/suspended.
    // Don't trust lastActivityAt, it wasn't updated while frozen.
    // Reset and let the next cycle evaluate with fresh data.
    const elapsedSinceLastCheck = now - this.lastCheckAt;
    this.lastCheckAt = now;
    if (elapsedSinceLastCheck > this.checkInterval * 3) {
      this.lastActivityAt = now;
      return;
    }

    const idleMs = now - this.lastActivityAt;
    if (idleMs < this.threshold) return;

    // Snapshot entries before iterating — fireSessionEnd() calls back into resolve()
    // which modifies the map. Iterating a snapshot avoids mutation-during-iteration.
    const entries = [...this.openGenerations.entries()];
    for (const [, { createdAt, fireSessionEnd }] of entries) {
      fireSessionEnd({ auto: true, reason: "idle", idle_ms: idleMs, open_ms: now - createdAt });
    }
  }

  /**
   * Fire $sessionend for all open generations with a given reason.
   * Used during page unload and destroy().
   */
  abandonAll(extraMetadata: Record<string, unknown>) {
    if (this.openGenerations.size === 0) return;

    const entries = [...this.openGenerations.entries()];
    const now = Date.now();
    for (const [, { createdAt, fireSessionEnd }] of entries) {
      fireSessionEnd({ auto: true, open_ms: now - createdAt, ...extraMetadata });
    }
  }
}
