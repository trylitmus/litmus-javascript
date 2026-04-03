// System event type literals for type safety.
// v1: core behavioral signals
// v2: user-initiated + auto-captured
export type SystemEvent =
  | "$generation" | "$regenerate" | "$copy" | "$edit" | "$abandon" | "$accept"
  | "$view" | "$partial_copy" | "$refine" | "$followup" | "$rephrase" | "$undo"
  | "$share" | "$flag" | "$rate" | "$escalate" | "$switch_model" | "$retry_context"
  | "$post_accept_edit"
  | "$blur" | "$return" | "$scroll_regression" | "$navigate" | "$interrupt";

/** What the user passes to `track()`. */
export interface TrackEvent {
  type: SystemEvent | (string & {});
  session_id: string;
  user_id?: string;
  prompt_id?: string;
  prompt_version?: string;
  generation_id?: string;
  metadata?: Record<string, unknown>;
}

/** Internal representation with a stable ID and timestamp assigned at track() time. */
interface BufferedEvent extends TrackEvent {
  id: string;
  timestamp: string;
}

export interface LitmusConfig {
  /** Base URL of the ingest service */
  endpoint: string;
  /** API key (ltm_pk_live_... or ltm_pk_test_...) */
  apiKey: string;
  /** How often to flush buffered events (ms). Default: 5000 */
  flushInterval?: number;
  /** Max events before auto-flush. Default: 50 */
  maxBatchSize?: number;
  /** Max events to hold in the buffer. Oldest dropped when exceeded. Default: 10000 */
  maxQueueSize?: number;
  /** Disable page lifecycle hooks (pagehide/visibilitychange). Default: false */
  disablePageLifecycle?: boolean;
}

interface ResolvedConfig {
  endpoint: string;
  apiKey: string;
  flushInterval: number;
  maxBatchSize: number;
  maxQueueSize: number;
  disablePageLifecycle: boolean;
}

/** Defaults that a Feature or Generation carries so callers don't repeat themselves. */
export interface FeatureDefaults {
  prompt_id?: string;
  prompt_version?: string;
  model?: string;
  user_id?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Handle returned by generation(). Lets you record behavioral signals
 * against a specific generation without re-threading IDs everywhere.
 *
 *   const gen = litmus.generation(sessionId);
 *   gen.accept();
 *   gen.edit({ edit_distance: 0.3 });
 *   gen.share({ channel: "slack" });
 */
export class Generation {
  readonly id: string;
  private sessionId: string;
  private defaults: FeatureDefaults;
  private client: LitmusClient;

  /** @internal */
  constructor(client: LitmusClient, sessionId: string, generationId: string, defaults: FeatureDefaults) {
    this.client = client;
    this.sessionId = sessionId;
    this.id = generationId;
    this.defaults = defaults;
  }

  /**
   * Record a behavioral signal against this generation.
   *
   *   gen.event("$accept");
   *   gen.event("$edit", { edit_distance: 0.3 });
   *   gen.event("my_custom_signal", { whatever: true });
   */
  event(type: SystemEvent | (string & {}), metadata?: Record<string, unknown>) {
    this.client.track({
      type,
      session_id: this.sessionId,
      user_id: this.defaults.user_id,
      prompt_id: this.defaults.prompt_id,
      prompt_version: this.defaults.prompt_version,
      generation_id: this.id,
      metadata: { ...this.defaults.metadata, ...metadata },
    });
  }
}

/**
 * Scoped handle for a specific AI feature. Carries defaults (prompt_id, model, etc.)
 * so individual generation() and track() calls don't need to repeat them.
 *
 *   const contentGen = litmus.feature("content_gen", { model: "gpt-4o" });
 *   const gen = contentGen.generation(sessionId, { user_id: userId });
 *   gen.accept();
 */
export class Feature {
  private client: LitmusClient;
  private defaults: FeatureDefaults;
  readonly name: string;

  /** @internal */
  constructor(client: LitmusClient, name: string, defaults: FeatureDefaults) {
    this.client = client;
    this.name = name;
    this.defaults = { ...defaults, prompt_id: defaults.prompt_id ?? name };
  }

  generation(sessionId: string, opts?: {
    user_id?: string;
    prompt_version?: string;
    metadata?: Record<string, unknown>;
  }): Generation {
    const baseMetadata: Record<string, unknown> = { feature: this.name };
    if (this.defaults.model) baseMetadata.model = this.defaults.model;
    const merged: FeatureDefaults = {
      ...this.defaults,
      user_id: opts?.user_id ?? this.defaults.user_id,
      prompt_version: opts?.prompt_version ?? this.defaults.prompt_version,
      metadata: { ...baseMetadata, ...this.defaults.metadata, ...opts?.metadata },
    };
    return this.client.generation(sessionId, merged);
  }

  track(event: Omit<TrackEvent, "prompt_id"> & { prompt_id?: string }) {
    this.client.track({
      ...event,
      prompt_id: event.prompt_id ?? this.defaults.prompt_id,
      user_id: event.user_id ?? this.defaults.user_id,
      metadata: { ...this.defaults.metadata, feature: this.name, ...event.metadata },
    });
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** The 64KB fetch keepalive budget, with 80% safety margin like PostHog. */
const FETCH_KEEPALIVE_LIMIT = 51_200;

interface SendResult {
  ok: boolean;
  status: number;
  retryAfter?: number;
}

function buildPayload(events: BufferedEvent[], apiKey: string): { url_suffix: string; body: string; headers: Record<string, string> } {
  const body = JSON.stringify({ events });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  return { url_suffix: "/v1/events", body, headers };
}

/**
 * Send via fetch. Used for normal flushes.
 * Sets keepalive: true when the payload is small enough (helps during page transitions).
 */
async function sendFetch(endpoint: string, events: BufferedEvent[], apiKey: string): Promise<SendResult> {
  const { url_suffix, body, headers } = buildPayload(events, apiKey);
  const useKeepalive = body.length < FETCH_KEEPALIVE_LIMIT;

  const res = await globalThis.fetch(`${endpoint}${url_suffix}`, {
    method: "POST",
    headers,
    body,
    keepalive: useKeepalive,
  });

  const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
  return { ok: res.ok, status: res.status, retryAfter };
}

/**
 * Send via navigator.sendBeacon. Used during page unload.
 * sendBeacon is fire-and-forget, best-effort. Returns true if the browser accepted it.
 */
function sendBeacon(endpoint: string, events: BufferedEvent[], apiKey: string): boolean {
  if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") {
    return false;
  }

  const { url_suffix, body } = buildPayload(events, apiKey);
  // sendBeacon can't set custom headers, so we pass the API key as ?token=.
  // The ingest server accepts this as an alternative to Authorization: Bearer.
  // Blob wrapping is required for sendBeacon to set Content-Type correctly.
  const blob = new Blob([body], { type: "application/json" });
  try {
    return navigator.sendBeacon(`${endpoint}${url_suffix}?token=${encodeURIComponent(apiKey)}`, blob);
  } catch {
    return false;
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return undefined;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const MAX_RETRIES = 10;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const DEFAULT_FLUSH_INTERVAL = 5000;
const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_MAX_QUEUE_SIZE = 10_000;

export class LitmusClient {
  private config: ResolvedConfig;
  private buffer: BufferedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures: number = 0;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private online: boolean = true;
  private destroyed: boolean = false;
  private flushing: boolean = false;

  // Bound listeners so we can remove them on destroy.
  private boundPageHide: (() => void) | null = null;
  private boundVisibilityChange: (() => void) | null = null;
  private boundOnline: (() => void) | null = null;
  private boundOffline: (() => void) | null = null;

  constructor(config: LitmusConfig) {
    this.config = {
      flushInterval: config.flushInterval ?? DEFAULT_FLUSH_INTERVAL,
      maxBatchSize: config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      maxQueueSize: config.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
      disablePageLifecycle: config.disablePageLifecycle ?? false,
      endpoint: config.endpoint,
      apiKey: config.apiKey,
    };

    this.online = typeof navigator !== "undefined" ? (navigator.onLine ?? true) : true;
    this.startInterval();

    if (!this.config.disablePageLifecycle && typeof window !== "undefined") {
      this.registerLifecycleListeners();
    }
  }

  // -----------------------------------------------------------------------
  // Page lifecycle
  // -----------------------------------------------------------------------

  private registerLifecycleListeners() {
    // Prefer pagehide over unload (better bfcache compat, fires more reliably on mobile).
    const unloadEvent = "onpagehide" in globalThis ? "pagehide" : "unload";
    this.boundPageHide = () => this.handleUnload();
    window.addEventListener(unloadEvent, this.boundPageHide, { passive: false } as AddEventListenerOptions);

    this.boundVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        this.flush();
      }
    };
    document.addEventListener("visibilitychange", this.boundVisibilityChange);

    // Online/offline awareness.
    this.boundOnline = () => {
      this.online = true;
      // Back online, flush anything that piled up.
      this.flush();
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
   * Uses sendBeacon (fire-and-forget) since async fetch won't complete.
   */
  private handleUnload() {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    sendBeacon(this.config.endpoint, batch, this.config.apiKey);
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
    const delay = delayOverride ??
      Math.min(BASE_DELAY_MS * Math.pow(2, this.consecutiveFailures - 1), MAX_DELAY_MS) +
      Math.floor(Math.random() * 1000);

    this.backoffTimer = setTimeout(async () => {
      this.backoffTimer = null;
      await this.flush();
      if (!this.timer && !this.destroyed) {
        this.startInterval();
      }
    }, delay);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  track(event: TrackEvent) {
    if (this.destroyed) return;

    this.buffer.push({
      ...event,
      id: crypto.randomUUID(),
      // Timestamp at track time, not flush time. If the user accepts a generation
      // and the flush fires 5s later, we want the accept timestamp, not the flush timestamp.
      timestamp: new Date().toISOString(),
    });

    // Evict oldest events if we've exceeded the queue cap.
    if (this.buffer.length > this.config.maxQueueSize) {
      const overflow = this.buffer.length - this.config.maxQueueSize;
      this.buffer.splice(0, overflow);
      console.warn(`[litmus] queue full, dropped ${overflow} oldest event(s)`);
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
   * Track a generation event and return a fluent handle for subsequent signals.
   */
  generation(sessionId: string, opts?: FeatureDefaults & {
    prompt_version?: string;
    metadata?: Record<string, unknown>;
  }): Generation {
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
    });

    return new Generation(this, sessionId, generationId, defaults);
  }

  /**
   * Attach to an existing generation created by a backend SDK.
   * Returns a Generation handle for recording behavioral signals
   * without re-emitting the $generation event.
   *
   * The backend owns prompt_id, prompt_version, model, and other generation
   * context. The frontend only needs the generation_id and session_id to
   * record what the user did with the output. Everything joins on
   * generation_id server-side.
   *
   *   const gen = litmus.attach(response.generation_id, sessionId);
   *   gen.accept();
   */
  attach(generationId: string, sessionId: string, opts?: {
    user_id?: string;
    metadata?: Record<string, unknown>;
  }): Generation {
    return new Generation(this, sessionId, generationId, {
      user_id: opts?.user_id,
      metadata: opts?.metadata,
    });
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    if (this.destroyed) return;
    if (!this.online) return;

    // Prevent concurrent flushes from racing. If two failures both unshift
    // their batches back, the order depends on which resolves first.
    if (this.flushing) return;
    this.flushing = true;

    // Take at most maxBatchSize events. This is important for the 413 split
    // path: after splitting a batch and putting halves back, the next flush
    // should only grab one half, not the entire buffer again.
    const batch = this.buffer.splice(0, this.config.maxBatchSize);

    try {
      const result = await sendFetch(this.config.endpoint, batch, this.config.apiKey);

      if (result.ok) {
        this.consecutiveFailures = 0;
        return;
      }

      this.handleFailure(batch, result.status, result.retryAfter);
    } catch {
      // Network error (offline, DNS failure, etc.)
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
  //   413 = payload too large        -> halve batch and retry immediately
  //   429 = rate limited             -> retry after Retry-After header
  //   5xx / network error (0)        -> retry with exponential backoff
  // -----------------------------------------------------------------------

  private handleFailure(batch: BufferedEvent[], status: number, retryAfterMs?: number) {
    // Client errors (except 413/429): the request is malformed, retrying won't help.
    if (status >= 400 && status < 500 && status !== 413 && status !== 429) {
      console.error(`[litmus] batch permanently rejected (${status}), ${batch.length} event(s) dropped`);
      return;
    }

    // 413: payload too large. Halve the batch and retry both halves on the next tick.
    // We use setTimeout(0) instead of a direct this.flush() call to avoid a tight
    // recursive loop if the server keeps returning 413 on the smaller batches.
    if (status === 413) {
      if (batch.length <= 1) {
        console.error("[litmus] single event too large for ingest, dropped");
        return;
      }
      const mid = Math.ceil(batch.length / 2);
      // Put both halves back at the front, they'll flush in subsequent cycles.
      this.buffer.unshift(...batch.slice(0, mid), ...batch.slice(mid));
      console.warn(`[litmus] batch too large, splitting into chunks of ~${mid}`);
      setTimeout(() => this.flush(), 0);
      return;
    }

    this.consecutiveFailures++;

    if (this.consecutiveFailures > MAX_RETRIES) {
      console.warn(`[litmus] batch dropped after ${MAX_RETRIES} retries`);
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

  destroy() {
    this.destroyed = true;
    this.clearInterval();
    this.clearBackoffTimer();
    this.removeLifecycleListeners();

    // Best-effort synchronous flush via sendBeacon if there's anything left.
    if (this.buffer.length > 0) {
      const batch = this.buffer.splice(0);
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        sendBeacon(this.config.endpoint, batch, this.config.apiKey);
      } else {
        // Server-side or test env: fire-and-forget fetch.
        sendFetch(this.config.endpoint, batch, this.config.apiKey).catch(() => {});
      }
    }
  }
}
