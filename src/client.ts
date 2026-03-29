// System event type literals for type safety.
// v1: core behavioral signals
// v2: user-initiated + auto-captured
type SystemEvent =
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

/** Internal representation with a stable ID assigned at track() time. */
interface BufferedEvent extends TrackEvent {
  id: string;
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
}

interface ResolvedConfig {
  endpoint: string;
  apiKey: string;
  flushInterval: number;
  maxBatchSize: number;
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

  private emit(type: SystemEvent, metadata?: Record<string, unknown>) {
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

  accept(metadata?: Record<string, unknown>) { this.emit("$accept", metadata); }
  edit(opts?: { edit_distance?: number; metadata?: Record<string, unknown> }) {
    this.emit("$edit", { edit_distance: opts?.edit_distance, ...opts?.metadata });
  }
  regenerate(metadata?: Record<string, unknown>) { this.emit("$regenerate", metadata); }
  copy(metadata?: Record<string, unknown>) { this.emit("$copy", metadata); }
  abandon(metadata?: Record<string, unknown>) { this.emit("$abandon", metadata); }
  view(metadata?: Record<string, unknown>) { this.emit("$view", metadata); }
  refine(opts?: { refinement_type?: string; metadata?: Record<string, unknown> }) {
    this.emit("$refine", { refinement_type: opts?.refinement_type, ...opts?.metadata });
  }
  followup(metadata?: Record<string, unknown>) { this.emit("$followup", metadata); }
  rephrase(metadata?: Record<string, unknown>) { this.emit("$rephrase", metadata); }
  undo(metadata?: Record<string, unknown>) { this.emit("$undo", metadata); }
  share(opts?: { channel?: string; edited_before_share?: boolean; metadata?: Record<string, unknown> }) {
    this.emit("$share", { channel: opts?.channel, edited_before_share: opts?.edited_before_share, ...opts?.metadata });
  }
  flag(opts?: { reason?: string; metadata?: Record<string, unknown> }) {
    this.emit("$flag", { reason: opts?.reason, ...opts?.metadata });
  }
  rate(value: number, opts?: { scale?: "binary" | "5-star" | "10-point"; metadata?: Record<string, unknown> }) {
    this.emit("$rate", { value, scale: opts?.scale ?? "binary", ...opts?.metadata });
  }
  escalate(metadata?: Record<string, unknown>) { this.emit("$escalate", metadata); }
  postAcceptEdit(opts?: { edit_distance?: number; time_since_accept_ms?: number; metadata?: Record<string, unknown> }) {
    this.emit("$post_accept_edit", {
      edit_distance: opts?.edit_distance,
      time_since_accept_ms: opts?.time_since_accept_ms,
      ...opts?.metadata,
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

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

export class LitmusClient {
  private config: ResolvedConfig;
  private buffer: BufferedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures: number = 0;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: LitmusConfig) {
    this.config = {
      flushInterval: 5000,
      maxBatchSize: 50,
      ...config,
    };
    this.startInterval();
  }

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

  private scheduleBackoffRetry() {
    this.clearInterval();
    const delay =
      Math.min(BASE_DELAY_MS * Math.pow(2, this.consecutiveFailures - 1), MAX_DELAY_MS) +
      Math.floor(Math.random() * 1000);

    this.backoffTimer = setTimeout(async () => {
      this.backoffTimer = null;
      await this.flush();
      // After the backoff flush completes (success or final drop), restart the interval
      if (!this.timer) {
        this.startInterval();
      }
    }, delay);
  }

  track(event: TrackEvent) {
    // ID is assigned here, not at flush time. This means retries
    // resend the same event with the same UUID, enabling server-side
    // idempotent ingestion via ON CONFLICT (id) DO NOTHING.
    this.buffer.push({ ...event, id: crypto.randomUUID() });
    if (this.buffer.length >= this.config.maxBatchSize) {
      this.flush();
    }
  }

  /**
   * Create a scoped feature handle. Carries defaults so you don't
   * repeat prompt_id, model, etc. on every call.
   *
   *   const contentGen = litmus.feature("content_gen", { model: "gpt-4o" });
   */
  feature(name: string, defaults?: Omit<FeatureDefaults, "prompt_id">): Feature {
    return new Feature(this, name, { ...defaults, prompt_id: name });
  }

  /**
   * Track a generation event and return a fluent handle for subsequent signals.
   *
   *   const gen = litmus.generation(sessionId);
   *   gen.accept();
   *   gen.edit({ edit_distance: 0.3 });
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

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);
    const events = batch.map((e) => ({
      ...e,
      timestamp: new Date().toISOString(),
    }));

    try {
      const res = await fetch(`${this.config.endpoint}/v1/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({ events }),
      });

      if (!res.ok) {
        console.error(`[litmus] flush failed: ${res.status}`);
        this.handleFailure(batch);
        return;
      }
    } catch (err) {
      console.error("[litmus] flush error:", err);
      this.handleFailure(batch);
      return;
    }

    this.consecutiveFailures = 0;
  }

  private handleFailure(batch: BufferedEvent[]) {
    this.consecutiveFailures++;

    if (this.consecutiveFailures > MAX_RETRIES) {
      console.warn("[litmus] batch dropped after 3 retries");
      return;
    }

    this.buffer.unshift(...batch);
    this.scheduleBackoffRetry();
  }

  destroy() {
    this.clearInterval();
    this.clearBackoffTimer();
    // Best-effort final flush, no backoff
    this.flush();
  }
}
