// ---------------------------------------------------------------------------
// Generation handle.
//
// Returned by LitmusClient.generation() and LitmusClient.attach().
// Lets you record behavioral signals against a specific AI output without
// re-threading IDs everywhere.
//
// The API surface is deliberately small: event() and edit(). Everything
// else goes through event() with the appropriate $-prefixed type string.
// This keeps the SDK explicit — the developer always sees which system
// event they're firing, and there's no hidden magic in convenience wrappers.
//
//   const gen = litmus.generation(sessionId, { prompt_id: "chat" });
//   gen.event("$accept");                          // user used the output as-is
//   gen.edit({ before: original, after: modified }); // user modified then used
//   gen.event("$copy");                            // user copied the output
//   gen.event("$regenerate");                      // user asked for a new one
//   gen.event("$view");                            // passive view (won't cancel auto-abandon)
//
// ---------------------------------------------------------------------------

import type { SystemEvent, FeatureDefaults, GenerationHost } from "./types.js";

export class Generation {
  readonly id: string;
  private sessionId: string;
  private defaults: FeatureDefaults;
  private host: GenerationHost;

  /** @internal — created by LitmusClient.generation() and LitmusClient.attach(). */
  constructor(host: GenerationHost, sessionId: string, generationId: string, defaults: FeatureDefaults) {
    this.host = host;
    this.sessionId = sessionId;
    this.id = generationId;
    this.defaults = defaults;
  }

  /**
   * Record a behavioral signal against this generation.
   *
   * Resolves the generation from auto-abandon tracking — any signal means
   * the developer is actively managing this generation's lifecycle.
   *
   * The one exception is `$view`: viewing is passive observation, not user
   * action. A user might view the output and still walk away, so $view
   * does NOT cancel auto-abandon. This matches the standard distinction
   * between active sources (mouse, keyboard, scroll) and passive sources
   * (DOM mutations, style changes) in their recording idle detection.
   *
   *   gen.event("$accept");
   *   gen.event("$copy");
   *   gen.event("$flag", { reason: "hallucination" });
   *   gen.event("$rate", { value: 4, scale: "5-star" });
   *   gen.event("$view");  // passive — won't cancel auto-abandon
   */
  event(type: SystemEvent | (string & {}), metadata?: Record<string, unknown>) {
    // $view is passive observation — doesn't resolve auto-abandon.
    // Everything else indicates the user interacted with the output.
    if (type !== "$view") {
      this.host._resolveGeneration(this.id);
    }

    this.host.track({
      type,
      session_id: this.sessionId,
      user_id: this.defaults.user_id,
      prompt_id: this.defaults.prompt_id,
      prompt_version: this.defaults.prompt_version,
      generation_id: this.id,
      metadata: { ...this.defaults.metadata, ...metadata },
    });
  }

  /**
   * Record that the user modified the output before using it.
   *
   * Send the raw before/after text — the backend computes edit distance,
   * diff classification, and any other derived metrics. This keeps the SDK
   * thin and lets the backend evolve its analysis without SDK updates.
   *
   *   gen.edit({ before: aiOutput, after: whatTheUserActuallyUsed });
   */
  edit(opts: { before: string; after: string; metadata?: Record<string, unknown> }) {
    this.event("$edit", { ...opts.metadata, before: opts.before, after: opts.after });
  }

  /** User used the output as-is. */
  accept(metadata?: Record<string, unknown>) {
    this.event("$accept", metadata);
  }

  /** User copied the output. */
  copy(metadata?: Record<string, unknown>) {
    this.event("$copy", metadata);
  }

  /** User requested a new output. Fire BEFORE creating the next generation. */
  regenerate(metadata?: Record<string, unknown>) {
    this.event("$regenerate", metadata);
  }

  /** User shared the output. */
  share(opts?: { channel?: string; metadata?: Record<string, unknown> }) {
    this.event("$share", { ...opts?.metadata, channel: opts?.channel });
  }
}
