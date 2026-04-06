// ---------------------------------------------------------------------------
// HTTP transport for the Litmus SDK.
//
// Two send paths:
//   1. fetch (normal flushes) — async, supports retry, respects keepalive budget
//   2. sendBeacon (page unload) — fire-and-forget, best-effort, synchronous call
//
// The ingest server accepts the API key in two places:
//   - Authorization: Bearer <key>  (used by fetch)
//   - ?token=<key> query param     (used by sendBeacon, which can't set headers)
//
// Compression:
//   Uses the native CompressionStream API (gzip) when available. Async and
//   non-blocking, no wasm or bundled codec needed. We skip sync fallback
//   since our payloads are lightweight JSON. sendBeacon always sends
//   uncompressed (async compression isn't safe during page unload).
//
// Timeout:
//   Every fetch has a 30s timeout via AbortSignal.timeout(). Without this, a
//   hung server blocks the flush pipeline forever (this.flushing = true, events
//   pile up, nothing ever sends again). analytics SDK uses 60s browser / 10s node.
//
//   In cross-realm environments (jsdom on vitest), Node's AbortSignal is
//   incompatible with jsdom's fetch. We detect this on first use, cache the
//   result, and skip the signal for all subsequent requests. This only affects
//   test environments, never real browsers.
// ---------------------------------------------------------------------------

import type { BufferedEvent } from "./types.js";

/** The 64KB fetch keepalive budget, with 80% safety margin like analytics SDK. */
const FETCH_KEEPALIVE_LIMIT = 51_200;

/**
 * Request timeout in ms. analytics SDK uses 60s for browser, 10s for node.
 * 30s is a reasonable middle ground.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Minimum payload size (bytes) worth compressing. Below this, gzip overhead
 * can actually increase the size. 1KB is a safe threshold for JSON.
 */
const MIN_COMPRESSION_SIZE = 1024;

/**
 * Cached result of AbortSignal.timeout() compatibility test.
 * Starts true (optimistic). Set to false on first TypeError from fetch.
 * Once false, never retested — the environment won't change mid-session.
 */
let signalTimeoutSupported = true;

export interface SendResult {
  ok: boolean;
  status: number;
  retryAfter?: number;
}

export function buildPayload(
  events: BufferedEvent[],
  apiKey: string,
): { url_suffix: string; body: string; headers: Record<string, string> } {
  const body = JSON.stringify({ events });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  return { url_suffix: "/v1/events", body, headers };
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

/** Check if the native CompressionStream API is available. */
function isCompressionSupported(): boolean {
  return typeof globalThis.CompressionStream === "function";
}

/**
 * Gzip compress a string using the native CompressionStream API.
 * Returns null if compression fails. Copied from analytics SDK's approach
 * (packages/core/src/gzip.ts) — stream the string through a gzip
 * CompressionStream and collect the result as a Blob.
 */
async function gzipCompress(input: string): Promise<Blob | null> {
  try {
    const stream = new Blob([input], { type: "text/plain" }).stream();
    const compressed = stream.pipeThrough(new CompressionStream("gzip"));
    return await new Response(compressed).blob();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fetch transport
// ---------------------------------------------------------------------------

/**
 * Send via fetch. Used for normal flushes.
 * Sets keepalive: true when the payload is small enough (helps during page transitions).
 * Aborts after REQUEST_TIMEOUT_MS to prevent a hung server from blocking the
 * flush pipeline forever.
 *
 * Optionally compresses the payload with gzip via CompressionStream.
 */
export async function sendFetch(
  endpoint: string,
  events: BufferedEvent[],
  apiKey: string,
  compress: boolean = false,
): Promise<SendResult> {
  const { url_suffix, body, headers } = buildPayload(events, apiKey);
  const url = `${endpoint}${url_suffix}`;

  // Optionally compress. Only worth it for larger payloads.
  let finalBody: string | Blob = body;
  if (compress && isCompressionSupported() && body.length > MIN_COMPRESSION_SIZE) {
    const compressed = await gzipCompress(body);
    // Only use compressed version if it's actually smaller.
    if (compressed && compressed.size < body.length) {
      finalBody = compressed;
      headers["Content-Encoding"] = "gzip";
    }
  }

  const useKeepalive = (typeof finalBody === "string" ? finalBody.length : finalBody.size) < FETCH_KEEPALIVE_LIMIT;

  const opts: RequestInit = {
    method: "POST",
    headers,
    body: finalBody,
    keepalive: useKeepalive,
  };

  // Add timeout signal. Cached flag avoids per-request overhead after the
  // first cross-realm failure (jsdom). In production browsers this always works.
  if (signalTimeoutSupported && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    opts.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  }

  let res: Response;
  try {
    res = await globalThis.fetch(url, opts);
  } catch (e) {
    // Cross-realm AbortSignal: Node's AbortSignal is incompatible with jsdom's fetch.
    // Disable signal for all future requests and retry this one without it.
    if (opts.signal && e instanceof TypeError) {
      signalTimeoutSupported = false;
      delete opts.signal;
      res = await globalThis.fetch(url, opts);
    } else {
      throw e;
    }
  }

  const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
  return { ok: res.ok, status: res.status, retryAfter };
}

// ---------------------------------------------------------------------------
// Beacon transport
// ---------------------------------------------------------------------------

/**
 * Send via navigator.sendBeacon. Used during page unload.
 * sendBeacon is fire-and-forget, best-effort. Returns true if the browser accepted it.
 * Always sends uncompressed — async compression isn't safe during unload.
 */
export function sendBeacon(endpoint: string, events: BufferedEvent[], apiKey: string): boolean {
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

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return undefined;
}
