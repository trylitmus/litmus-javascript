import type { components } from "./types/api.gen.js";

type EventType = components["schemas"]["EventType"];

/** What the user passes to `track()`. */
export interface TrackEvent {
  type: EventType;
  session_id: string;
  prompt_id?: string;
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

export class LitmusClient {
  private config: ResolvedConfig;
  private buffer: BufferedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: LitmusConfig) {
    this.config = {
      flushInterval: 5000,
      maxBatchSize: 50,
      ...config,
    };
    this.timer = setInterval(() => this.flush(), this.config.flushInterval);
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
        this.buffer.unshift(...batch);
      }
    } catch (err) {
      console.error("[litmus] flush error:", err);
      this.buffer.unshift(...batch);
    }
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
    this.flush();
  }
}
