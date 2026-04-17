// ---------------------------------------------------------------------------
// Feature handle — scoped defaults for a specific AI feature.
//
// Apps with multiple AI features (summarizer, chat, code-gen) use feature()
// to avoid repeating prompt_id, model, user_id on every generation() call.
// The feature name becomes the default prompt_id.
//
//   const summarizer = litmus.feature("summarizer", { model: "gpt-4o" });
//   const gen = summarizer.generation(sessionId, { user_id: userId });
//   gen.event("$accept");
// ---------------------------------------------------------------------------

import type { Generation } from "./generation.js";
import type { FeatureDefaults, TrackEvent } from "./types.js";

/**
 * Interface for the client methods that Feature needs.
 * Avoids importing LitmusClient directly (breaks circular dependency).
 */
export interface FeatureHost {
  track(event: TrackEvent): void;
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
  ): Generation;
}

export class Feature {
  private host: FeatureHost;
  private defaults: FeatureDefaults;
  readonly name: string;

  /** @internal — created by LitmusClient.feature(). */
  constructor(host: FeatureHost, name: string, defaults: FeatureDefaults) {
    this.host = host;
    this.name = name;
    this.defaults = { ...defaults, prompt_id: defaults.prompt_id ?? name };
  }

  /**
   * Create a generation scoped to this feature.
   *
   * Per-call wire fields (model, provider, tokens, latency, cost) win over
   * the feature's defaults and land at the top of the event payload — the
   * ingest server writes them to typed Postgres columns, NOT into metadata.
   */
  generation(
    sessionId: string,
    opts?: {
      user_id?: string;
      prompt_version?: string;
      metadata?: Record<string, unknown>;
      model?: string;
      provider?: string;
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      duration_ms?: number;
      ttft_ms?: number;
      cost?: number;
    },
  ): Generation {
    return this.host.generation(sessionId, {
      ...this.defaults,
      user_id: opts?.user_id ?? this.defaults.user_id,
      prompt_version: opts?.prompt_version ?? this.defaults.prompt_version,
      model: opts?.model ?? this.defaults.model,
      provider: opts?.provider ?? this.defaults.provider,
      input_tokens: opts?.input_tokens,
      output_tokens: opts?.output_tokens,
      total_tokens: opts?.total_tokens,
      duration_ms: opts?.duration_ms,
      ttft_ms: opts?.ttft_ms,
      cost: opts?.cost,
      metadata: { feature: this.name, ...this.defaults.metadata, ...opts?.metadata },
    });
  }

  track(event: Omit<TrackEvent, "prompt_id"> & { prompt_id?: string }) {
    this.host.track({
      ...event,
      prompt_id: event.prompt_id ?? this.defaults.prompt_id,
      user_id: event.user_id ?? this.defaults.user_id,
      model: event.model ?? this.defaults.model,
      provider: event.provider ?? this.defaults.provider,
      metadata: { ...this.defaults.metadata, feature: this.name, ...event.metadata },
    });
  }
}
