// ---------------------------------------------------------------------------
// LitmusClient — the main entry point for the Litmus SDK.
//
// Responsibilities:
//   - Event buffering with configurable batch size and queue cap
//   - Periodic flushing at a configurable interval
//   - Page lifecycle handling (pagehide, visibilitychange, online/offline)
//   - Automatic abandon detection for unresolved generations
//   - Generation and feature handle creation
//   - Retry with exponential backoff, batch splitting on 413, rate limit on 429
//   - Consent management (opt-in/opt-out)
//   - SDK identification ($lib, $lib_version on every event)
//   - Optional gzip compression via CompressionStream
//   - Client-side rate limiting (token bucket)
//   - Queue persistence to sessionStorage
//   - Debug logging
//
// The client implements GenerationHost so Generation objects can call back
// into it for track() and _resolveGeneration() without a circular import.
// ---------------------------------------------------------------------------

import { AbandonDetector, DEFAULT_ABANDON_THRESHOLD_MS } from "./abandon.js";
import { ConsentManager } from "./consent.js";
import { collectStartupMetadata } from "./environment.js";
import { Feature } from "./feature.js";
import { Generation } from "./generation.js";
import { createLogger, type Logger } from "./logger.js";
import { QueueStore } from "./queue-store.js";
import { RateLimiter } from "./rate-limiter.js";
import { sendBeacon, sendFetch } from "./transport.js";
import type {
  BufferedEvent,
  FeatureDefaults,
  GenerationHost,
  LitmusConfig,
  ResolvedConfig,
  TrackEvent,
} from "./types.js";
import { SDK_NAME, SDK_VERSION } from "./version.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 10;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const DEFAULT_FLUSH_INTERVAL = 1000;
const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_MAX_QUEUE_SIZE = 10_000;

/**
 * Max recursive splits for a 413 response. Without this cap, a server that
 * always returns 413 causes an unbounded setTimeout chain. 6 splits covers
 * a batch of 50 down to single events (50 -> 25 -> 13 -> 7 -> 4 -> 2 -> 1).
 */
const MAX_413_SPLITS = 6;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class LitmusClient implements GenerationHost {
  private config: ResolvedConfig;
  private buffer: BufferedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures: number = 0;
  private consecutiveSplits: number = 0;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private online: boolean = true;
  private destroyed: boolean = false;
  private flushing: boolean = false;
  private log: Logger;

  // Bound listeners so we can remove them on destroy.
  private boundPageHide: (() => void) | null = null;
  private boundVisibilityChange: (() => void) | null = null;
  private boundOnline: (() => void) | null = null;
  private boundOffline: (() => void) | null = null;

  private abandonDetector: AbandonDetector;
  private consent: ConsentManager;
  private rateLimiter: RateLimiter;
  private queueStore: QueueStore;
  /** Last session_id seen via generation() or attach(). Used for $pageleave. */
  private lastSessionId: string | null = null;

  constructor(config: LitmusConfig) {
    this.config = {
      flushInterval: config.flushInterval ?? DEFAULT_FLUSH_INTERVAL,
      maxBatchSize: config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      maxQueueSize: config.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
      disablePageLifecycle: config.disablePageLifecycle ?? false,
      abandonThreshold: config.abandonThreshold ?? DEFAULT_ABANDON_THRESHOLD_MS,
      disableAutoAbandon: config.disableAutoAbandon ?? false,
      abandonCheckInterval: config.abandonCheckInterval ?? 10_000,
      defaultOptOut: config.defaultOptOut ?? false,
      disableCompression: config.disableCompression ?? false,
      debug: config.debug ?? false,
      disableQueuePersistence: config.disableQueuePersistence ?? false,
      disableTelemetry: config.disableTelemetry ?? false,
      endpoint: config.endpoint ?? "https://ingest.trylitmus.app",
      apiKey: config.apiKey,
    };

    this.log = createLogger(this.config.debug);
    this.consent = new ConsentManager(this.config.apiKey, this.config.defaultOptOut);
    this.rateLimiter = new RateLimiter();
    this.abandonDetector = new AbandonDetector(this.config.abandonThreshold, this.config.abandonCheckInterval);

    // Load any events persisted from a previous page load (page refresh recovery).
    this.queueStore = new QueueStore(this.config.apiKey);
    if (!this.config.disableQueuePersistence) {
      const restored = this.queueStore.load();
      if (restored.length > 0) {
        this.buffer = restored;
        this.log.debug(`restored ${restored.length} event(s) from sessionStorage`);
      }
    }

    this.online = typeof navigator !== "undefined" ? (navigator.onLine ?? true) : true;
    this.startInterval();

    if (typeof window !== "undefined") {
      if (!this.config.disablePageLifecycle) {
        this.registerLifecycleListeners();
      }
      if (!this.config.disableAutoAbandon && this.config.abandonThreshold > 0) {
        this.abandonDetector.start();
      }
    }

    if (this.consent.isOptedOut()) {
      this.log.debug(
        "tracking is disabled — user opted out or browser Do Not Track is enabled. All events will be" +
          " silently dropped.",
      );
    }

    // Fire $startup so the ingest server knows the SDK initialized.
    // This doubles as the fastest possible signal for the setup wizard
    // (no user interaction required) and carries environment metadata
    // useful for debugging.
    if (!this.config.disableTelemetry) {
      this.track({
        type: "$startup",
        session_id: "",
        metadata: collectStartupMetadata(),
      });
    }

    this.log.debug("initialized", { endpoint: this.config.endpoint, version: SDK_VERSION });
  }

  // -----------------------------------------------------------------------
  // Page lifecycle
  //
  // Prefer pagehide over unload — better bfcache compat, fires more
  // reliably on mobile. visibilitychange fires on tab switch, which is
  // a good time to flush (the tab might get killed while backgrounded).
  // Online/offline awareness prevents wasted fetch calls while offline
  // and triggers a catch-up flush when connectivity returns.
  // -----------------------------------------------------------------------

  private registerLifecycleListeners() {
    const unloadEvent = "onpagehide" in globalThis ? "pagehide" : "unload";
    // All lifecycle handlers are wrapped in try/catch. A throw here is
    // invisible to the caller and silently kills the SDK.
    this.boundPageHide = () => {
      try {
        this.handleUnload();
      } catch (e) {
        this.log.error("unload handler failed", e);
      }
    };
    window.addEventListener(unloadEvent, this.boundPageHide, { passive: false } as AddEventListenerOptions);

    this.boundVisibilityChange = () => {
      try {
        if (document.visibilityState === "hidden") {
          this.flush();
          // Persist queue when tab goes hidden — it might get killed while backgrounded.
          this.persistQueue();
        }
      } catch (e) {
        this.log.error("visibilitychange handler failed", e);
      }
    };
    document.addEventListener("visibilitychange", this.boundVisibilityChange);

    this.boundOnline = () => {
      try {
        this.online = true;
        this.flush();
      } catch (e) {
        this.log.error("online handler failed", e);
      }
    };
    this.boundOffline = () => {
      this.online = false;
    };
    window.addEventListener("online", this.boundOnline);
    window.addEventListener("offline", this.boundOffline);
  }

  private removeLifecycleListeners() {
    if (this.boundPageHide) {
      const unloadEvent = "onpagehide" in globalThis ? "pagehide" : "unload";
      window.removeEventListener(unloadEvent, this.boundPageHide);
      this.boundPageHide = null;
    }
    if (this.boundVisibilityChange) {
      document.removeEventListener("visibilitychange", this.boundVisibilityChange);
      this.boundVisibilityChange = null;
    }
    if (this.boundOnline) {
      window.removeEventListener("online", this.boundOnline);
      this.boundOnline = null;
    }
    if (this.boundOffline) {
      window.removeEventListener("offline", this.boundOffline);
      this.boundOffline = null;
    }
  }

  /**
   * Last-ditch flush during page unload.
   * Fires $pageleave (explicit session boundary), then $sessionend for all
   * unresolved generations, then sends everything via sendBeacon.
   *
   * NOTE: We intentionally do NOT fire $abandon here. $abandon means the
   * user explicitly rejected a generation (closed an editor without copying,
   * clicked "stop", etc.). Tab close is not a quality signal. For session
   * boundary marking we emit $sessionend on each still-open generation.
   */
  private handleUnload() {
    // $pageleave is a session-level boundary event; $sessionend is the
    // per-generation flavor. Both are session boundaries, neither is a
    // quality signal.
    // Only fire if we have a session context (at least one generation was created/attached).
    if (this.lastSessionId) {
      this.track({ type: "$pageleave", session_id: this.lastSessionId });
    }

    // Emit $sessionend for all unresolved generations (routed via AbandonDetector).
    this.abandonDetector.abandonAll({ reason: "page_unload" });

    // Persist whatever's in the buffer (sendBeacon is best-effort, might fail).
    this.persistQueue();

    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    sendBeacon(this.config.endpoint, batch, this.config.apiKey);
  }

  // -----------------------------------------------------------------------
  // Queue persistence
  // -----------------------------------------------------------------------

  /** Save current buffer to sessionStorage. */
  private persistQueue(): void {
    if (this.config.disableQueuePersistence) return;
    this.queueStore.save(this.buffer);
  }

  // -----------------------------------------------------------------------
  // Timer management
  // -----------------------------------------------------------------------

  private startInterval() {
    this.timer = setInterval(() => this.flush(), this.config.flushInterval);
  }

  private clearInterval() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private clearBackoffTimer() {
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
  }

  private scheduleBackoffRetry(delayOverride?: number) {
    this.clearInterval();
    this.clearBackoffTimer();
    const delay =
      delayOverride ??
      Math.min(BASE_DELAY_MS * 2 ** (this.consecutiveFailures - 1), MAX_DELAY_MS) + Math.floor(Math.random() * 1000);

    this.backoffTimer = setTimeout(async () => {
      this.backoffTimer = null;
      await this.flush();
      if (!this.timer && !this.destroyed) {
        this.startInterval();
      }
    }, delay);
  }

  // -----------------------------------------------------------------------
  // Consent
  // -----------------------------------------------------------------------

  /** Disable tracking. Persists to localStorage. */
  optOut(): void {
    this.consent.optOut();
  }

  /** Enable tracking. Persists to localStorage. */
  optIn(): void {
    this.consent.optIn();
  }

  /** Returns true if the user has opted out of tracking. */
  hasOptedOut(): boolean {
    return this.consent.isOptedOut();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  track(event: TrackEvent) {
    if (this.destroyed) return;
    if (this.consent.isOptedOut()) return;

    // Client-side rate limiting. Auto-generated events ($sessionend, $pageleave, $startup)
    // bypass the limiter since they're SDK-internal, not caller-driven.
    const isInternal = event.type === "$sessionend" || event.type === "$pageleave" || event.type === "$startup";
    if (!isInternal && this.rateLimiter.isRateLimited()) {
      this.log.debug("event dropped by rate limiter", event.type);
      return;
    }

    // Sanitize numeric fields. NaN/Infinity would cause Postgres NUMERIC
    // columns to reject the entire batch insert.
    const sanitized = { ...event };
    for (const key of ["cost", "input_tokens", "output_tokens", "total_tokens", "duration_ms", "ttft_ms"] as const) {
      if (key in sanitized && typeof sanitized[key] === "number" && !Number.isFinite(sanitized[key])) {
        delete sanitized[key];
      }
    }

    this.buffer.push({
      ...sanitized,
      id: crypto.randomUUID(),
      // Timestamp at track time, not flush time. If the user accepts a generation
      // and the flush fires 5s later, we want the accept timestamp, not the flush timestamp.
      timestamp: new Date().toISOString(),
      // SDK identification — so the server knows which SDK version sent this event.
      metadata: { $lib: SDK_NAME, $lib_version: SDK_VERSION, ...sanitized.metadata },
    });

    this.log.debug("tracked", event.type, event.generation_id ?? "");

    // Evict oldest events if we've exceeded the queue cap.
    if (this.buffer.length > this.config.maxQueueSize) {
      const overflow = this.buffer.length - this.config.maxQueueSize;
      this.buffer.splice(0, overflow);
      this.log.warn(`queue full, dropped ${overflow} oldest event(s)`);
    }

    if (this.buffer.length >= this.config.maxBatchSize) {
      this.flush();
    }
  }

  /**
   * Create a scoped feature handle. Carries defaults so you don't
   * repeat prompt_id, model, etc. on every call.
   */
  feature(name: string, defaults?: Omit<FeatureDefaults, "prompt_id">): Feature {
    return new Feature(this, name, { ...defaults, prompt_id: name });
  }

  /**
   * Track a generation event and return a handle for subsequent signals.
   *
   * Call this AFTER the LLM call returns so you can include latency_ms,
   * token_count, and other response metadata. The $generation event is
   * a record of what was produced, not a request to produce it.
   */
  generation(
    sessionId: string,
    opts?: FeatureDefaults & {
      prompt_version?: string;
      metadata?: Record<string, unknown>;
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      duration_ms?: number;
      ttft_ms?: number;
      cost?: number;
    },
  ): Generation {
    const generationId = crypto.randomUUID();
    const defaults: FeatureDefaults = {
      user_id: opts?.user_id,
      prompt_id: opts?.prompt_id,
      prompt_version: opts?.prompt_version,
      model: opts?.model,
      metadata: opts?.metadata,
    };

    this.track({
      type: "$generation",
      session_id: sessionId,
      user_id: defaults.user_id,
      generation_id: generationId,
      prompt_id: defaults.prompt_id,
      prompt_version: defaults.prompt_version,
      metadata: defaults.metadata,
      model: opts?.model,
      provider: opts?.provider,
      input_tokens: opts?.input_tokens,
      output_tokens: opts?.output_tokens,
      total_tokens: opts?.total_tokens,
      duration_ms: opts?.duration_ms,
      ttft_ms: opts?.ttft_ms,
      cost: opts?.cost,
    });

    const gen = new Generation(this, sessionId, generationId, defaults);
    this.lastSessionId = sessionId;

    if (!this.config.disableAutoAbandon) {
      // Auto-emitted session boundary, NOT a quality signal.
      // See abandon.ts header and generation.ts docs on the $abandon vs $sessionend split.
      this.abandonDetector.register(generationId, (metadata) => {
        gen.event("$sessionend", metadata);
      });
    }

    this.log.debug("generation created", generationId);
    return gen;
  }

  /**
   * Attach to an existing generation created by a backend SDK.
   * Returns a Generation handle for recording behavioral signals
   * without re-emitting the $generation event.
   */
  attach(
    generationId: string,
    sessionId: string,
    opts?: {
      user_id?: string;
      prompt_id?: string;
      prompt_version?: string;
      metadata?: Record<string, unknown>;
    },
  ): Generation {
    const gen = new Generation(this, sessionId, generationId, {
      user_id: opts?.user_id,
      prompt_id: opts?.prompt_id,
      prompt_version: opts?.prompt_version,
      metadata: opts?.metadata,
    });
    this.lastSessionId = sessionId;

    if (!this.config.disableAutoAbandon) {
      // Auto-emitted session boundary, NOT a quality signal.
      // See abandon.ts header and generation.ts docs on the $abandon vs $sessionend split.
      this.abandonDetector.register(generationId, (metadata) => {
        gen.event("$sessionend", metadata);
      });
    }

    return gen;
  }

  /**
   * Remove a generation from auto-abandon tracking.
   * Called by Generation.event() when any behavioral signal is recorded
   * (except $view, which is passive and doesn't resolve).
   * @internal
   */
  _resolveGeneration(id: string) {
    this.abandonDetector.resolve(id);
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    if (this.destroyed) return;
    if (!this.online) return;
    if (this.flushing) return;
    this.flushing = true;

    const batch = this.buffer.splice(0, this.config.maxBatchSize);
    const compress = !this.config.disableCompression;

    try {
      const result = await sendFetch(this.config.endpoint, batch, this.config.apiKey, compress);

      if (result.ok) {
        this.consecutiveFailures = 0;
        this.consecutiveSplits = 0;
        this.log.debug(`flushed ${batch.length} event(s)`);
        // Persist remaining buffer after successful send.
        this.persistQueue();
        return;
      }

      this.handleFailure(batch, result.status, result.retryAfter);
    } catch {
      this.handleFailure(batch, 0);
    } finally {
      this.flushing = false;
    }
  }

  // -----------------------------------------------------------------------
  // Failure handling
  //
  // Match the ingest server's status codes:
  //   400 = bad JSON / validation    -> never retry, client bug
  //   401 = unauthorized             -> never retry, bad API key
  //   403 = insufficient scope       -> never retry, wrong key type
  //   408 = request timeout          -> retry (server was slow, not a client error)
  //   413 = payload too large        -> halve batch and retry, capped at MAX_413_SPLITS
  //   429 = rate limited             -> retry after Retry-After header
  //   5xx / network error (0)        -> retry with exponential backoff
  // -----------------------------------------------------------------------

  private handleFailure(batch: BufferedEvent[], status: number, retryAfterMs?: number) {
    if (status >= 400 && status < 500 && status !== 408 && status !== 413 && status !== 429) {
      this.log.error(`batch permanently rejected (${status}), ${batch.length} event(s) dropped`);
      return;
    }

    if (status === 413) {
      if (batch.length <= 1 || this.consecutiveSplits >= MAX_413_SPLITS) {
        this.log.error(`event(s) too large for ingest after ${this.consecutiveSplits} splits, dropped`);
        this.consecutiveSplits = 0;
        return;
      }
      this.consecutiveSplits++;
      const mid = Math.ceil(batch.length / 2);
      this.buffer.unshift(...batch.slice(0, mid), ...batch.slice(mid));
      this.log.warn(`batch too large, splitting into chunks of ~${mid}`);
      setTimeout(() => this.flush(), 0);
      return;
    }

    this.consecutiveFailures++;

    if (this.consecutiveFailures > MAX_RETRIES) {
      this.log.warn(`batch dropped after ${MAX_RETRIES} retries`);
      this.consecutiveFailures = 0;
      return;
    }

    // Put events back at the front so order is preserved.
    this.buffer.unshift(...batch);

    // 429: respect the server's Retry-After.
    if (status === 429 && retryAfterMs) {
      this.scheduleBackoffRetry(retryAfterMs);
      return;
    }

    this.scheduleBackoffRetry();
  }

  /**
   * Shut down the client. Fires $sessionend for unresolved generations,
   * persists the queue, and does a final best-effort flush.
   *
   * Returns a Promise so callers can await completion of the final flush.
   */
  async destroy(): Promise<void> {
    this.abandonDetector.abandonAll({ reason: "destroy" });
    this.abandonDetector.stop();

    this.destroyed = true;
    this.clearInterval();
    this.clearBackoffTimer();
    this.removeLifecycleListeners();

    // Persist queue before final flush attempt.
    this.persistQueue();

    if (this.buffer.length > 0) {
      const batch = this.buffer.splice(0);
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        sendBeacon(this.config.endpoint, batch, this.config.apiKey);
      } else {
        // Await the final flush so callers have a real synchronization point.
        try {
          await sendFetch(this.config.endpoint, batch, this.config.apiKey);
        } catch (e) {
          this.log.warn("final flush failed", e);
        }
      }
    }

    this.log.debug("destroyed");
  }
}
