// ---------------------------------------------------------------------------
// Logger — debug-gated console output.
//
// Three ways to enable debug logging:
//   1. Config: new LitmusClient({ debug: true })
//   2. Runtime: window.__LITMUS_DEBUG = true (toggle without redeploying)
//   3. URL param: ?__litmus_debug=true (for one-off debugging in browser)
//
// Critical distinction:
//   - debug(): only logs when debug mode is on. Use for "event tracked",
//     "flush completed", "generation created" — stuff developers need
//     when integrating but don't want in production.
//   - warn(): always logs. Use for degraded behavior that isn't an error
//     (dropped events, rate limiting, queue overflow).
//   - error(): always logs. Use for failures (auth rejected, SDK crash).
// ---------------------------------------------------------------------------

/** Check if debug is enabled via window.__LITMUS_DEBUG or URL param. */
function isRuntimeDebug(): boolean {
  if (typeof window === "undefined") return false;
  // Runtime toggle: set window.__LITMUS_DEBUG = true in console
  if ((window as Record<string, unknown>).__LITMUS_DEBUG) return true;
  // URL param: ?__litmus_debug=true
  try {
    return new URL(window.location.href).searchParams.get("__litmus_debug") === "true";
  } catch {
    return false;
  }
}

export interface Logger {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(configDebug: boolean): Logger {
  return {
    // Check runtime toggle on every call so it can be enabled mid-session.
    debug(...args: unknown[]) {
      if (configDebug || isRuntimeDebug()) {
        console.debug("[litmus]", ...args);
      }
    },
    // warn and error always log regardless of debug flag.
    warn: (...args: unknown[]) => console.warn("[litmus]", ...args),
    error: (...args: unknown[]) => console.error("[litmus]", ...args),
  };
}