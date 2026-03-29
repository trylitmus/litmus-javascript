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

  generation(
    sessionId: string,
    opts?: {
      user_id?: string;
      prompt_id?: string;
      prompt_version?: string;
      metadata?: Record<string, unknown>;
    },
  ): { id: string } {
    const generationId = crypto.randomUUID();
    this.track({
      type: "$generation",
      session_id: sessionId,
      user_id: opts?.user_id,
      generation_id: generationId,
      prompt_id: opts?.prompt_id,
      prompt_version: opts?.prompt_version,
      metadata: opts?.metadata,
    });
    return { id: generationId };
  }

  /** User explicitly shared AI output. Strongest organic endorsement. */
  share(sessionId: string, generationId: string, opts?: {
    user_id?: string;
    channel?: string;
    edited_before_share?: boolean;
    metadata?: Record<string, unknown>;
  }) {
    this.track({
      type: "$share",
      session_id: sessionId,
      user_id: opts?.user_id,
      generation_id: generationId,
      metadata: { channel: opts?.channel, edited_before_share: opts?.edited_before_share, ...opts?.metadata },
    });
  }

  /** User reported output as problematic. Highest-severity negative signal. */
  flag(sessionId: string, generationId: string, opts?: {
    user_id?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  }) {
    this.track({
      type: "$flag",
      session_id: sessionId,
      user_id: opts?.user_id,
      generation_id: generationId,
      metadata: { reason: opts?.reason, ...opts?.metadata },
    });
  }

  /** User gave explicit feedback (thumbs, stars). Ground truth for calibrating implicit signals. */
  rate(sessionId: string, generationId: string, value: number, opts?: {
    user_id?: string;
    scale?: "binary" | "5-star" | "10-point";
    metadata?: Record<string, unknown>;
  }) {
    this.track({
      type: "$rate",
      session_id: sessionId,
      user_id: opts?.user_id,
      generation_id: generationId,
      metadata: { value, scale: opts?.scale ?? "binary", ...opts?.metadata },
    });
  }

  /** User came back and edited AFTER accepting. Worse than immediate edit: trust was specifically betrayed. */
  postAcceptEdit(sessionId: string, generationId: string, opts?: {
    user_id?: string;
    edit_distance?: number;
    time_since_accept_ms?: number;
    metadata?: Record<string, unknown>;
  }) {
    this.track({
      type: "$post_accept_edit",
      session_id: sessionId,
      user_id: opts?.user_id,
      generation_id: generationId,
      metadata: {
        edit_distance: opts?.edit_distance,
        time_since_accept_ms: opts?.time_since_accept_ms,
        ...opts?.metadata,
      },
    });
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
