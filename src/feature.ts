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

import type { TrackEvent, FeatureDefaults } from "./types.js";
import type { Generation } from "./generation.js";

/**
 * Interface for the client methods that Feature needs.
 * Avoids importing LitmusClient directly (breaks circular dependency).
 */
export interface FeatureHost {
  track(event: TrackEvent): void;
  generation(sessionId: string, opts?: FeatureDefaults & {
    prompt_version?: string;
    metadata?: Record<string, unknown>;
  }): Generation;
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
    return this.host.generation(sessionId, merged);
  }

  track(event: Omit<TrackEvent, "prompt_id"> & { prompt_id?: string }) {
    this.host.track({
      ...event,
      prompt_id: event.prompt_id ?? this.defaults.prompt_id,
      user_id: event.user_id ?? this.defaults.user_id,
      metadata: { ...this.defaults.metadata, feature: this.name, ...event.metadata },
    });
  }
}
