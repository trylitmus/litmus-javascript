// ---------------------------------------------------------------------------
// Shared type definitions for the Litmus SDK.
//
// This file is the dependency root — nothing in src/ should import from
// files that import from here (no cycles). Internal types used across
// modules live here alongside the public API surface.
// ---------------------------------------------------------------------------

// System event type literals for type safety.
// v1: core behavioral signals
// v2: user-initiated + auto-captured
export type SystemEvent =
  | "$generation"
  | "$regenerate"
  | "$copy"
  | "$edit"
  | "$abandon"
  | "$accept"
  | "$view"
  | "$partial_copy"
  | "$refine"
  | "$followup"
  | "$rephrase"
  | "$undo"
  | "$share"
  | "$flag"
  | "$rate"
  | "$escalate"
  | "$switch_model"
  | "$retry_context"
  | "$post_accept_edit"
  | "$pageleave"
  | "$sessionend"
  | "$blur"
  | "$return"
  | "$scroll_regression"
  | "$navigate"
  | "$interrupt"
  | "$startup";

/** What the user passes to `track()`. */
export interface TrackEvent {
  type: SystemEvent | (string & {});
  session_id: string;
  user_id?: string;
  prompt_id?: string;
  prompt_version?: string;
  generation_id?: string;
  metadata?: Record<string, unknown>;
  model?: string;
  provider?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  duration_ms?: number;
  ttft_ms?: number;
  cost?: number;
}

/** Internal representation with a stable ID and timestamp assigned at track() time. */
export interface BufferedEvent extends TrackEvent {
  id: string;
  timestamp: string;
}

export interface LitmusConfig {
  /** Base URL of the ingest service. Default: https://ingest.trylitmus.app */
  endpoint?: string;
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
  /**
   * Time in ms of user inactivity before unresolved generations auto-fire $sessionend.
   * Default: 300000 (5 minutes).
   * Set to 0 or use disableAutoAbandon to disable.
   *
   * Note: the name is historical — this controls $sessionend (session boundary),
   * not $abandon (user-initiated quality signal). See docs/020-abandon-fix.md.
   */
  abandonThreshold?: number;
  /**
   * Disable automatic $sessionend detection entirely. Default: false.
   * Note: the name is historical, see abandonThreshold docstring.
   */
  disableAutoAbandon?: boolean;
  /** How often to check for idle generations (ms). Default: 10000. Lower values
   *  detect idle faster but use more CPU. */
  abandonCheckInterval?: number;
  /** Start with tracking disabled. Call optIn() to enable. Default: false */
  defaultOptOut?: boolean;
  /** Disable gzip compression via CompressionStream. Default: false */
  disableCompression?: boolean;
  /** Enable verbose debug logging. Default: false */
  debug?: boolean;
  /** Disable queue persistence to sessionStorage. Default: false */
  disableQueuePersistence?: boolean;
  /** Disable SDK-internal telemetry events ($startup, etc.). Default: false.
   *  These events help with debugging and environment detection but
   *  are not required for core functionality. */
  disableTelemetry?: boolean;
}

export interface ResolvedConfig {
  endpoint: string;
  apiKey: string;
  flushInterval: number;
  maxBatchSize: number;
  maxQueueSize: number;
  disablePageLifecycle: boolean;
  abandonThreshold: number;
  disableAutoAbandon: boolean;
  abandonCheckInterval: number;
  defaultOptOut: boolean;
  disableCompression: boolean;
  debug: boolean;
  disableQueuePersistence: boolean;
  disableTelemetry: boolean;
}

/** Defaults that a Feature or Generation carries so callers don't repeat themselves. */
export interface FeatureDefaults {
  prompt_id?: string;
  prompt_version?: string;
  model?: string;
  provider?: string;
  user_id?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Minimal interface that Generation needs from its host (the LitmusClient).
 * Defined here to break the circular dependency between generation.ts and client.ts.
 */
export interface GenerationHost {
  track(event: TrackEvent): void;
  /** Remove a generation from auto-abandon tracking. */
  _resolveGeneration(id: string): void;
}
