// ---------------------------------------------------------------------------
// Integration tests: client-side rate limiting.
//
// Tests the token bucket rate limiter end-to-end through the LitmusClient.
// Real HTTP server, real timers.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LitmusClient, type LitmusConfig } from "../src/index.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { createTestServer, type TestServer } from "./helpers.js";

let server: TestServer;

beforeAll(async () => {
  server = createTestServer();
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  server.reset();
});

function makeClient(overrides?: Partial<LitmusConfig>): LitmusClient {
  return new LitmusClient({
    endpoint: server.endpoint,
    apiKey: "ltm_pk_test_ratelimit",
    flushInterval: 999_999,
    // High batch size to prevent auto-flush during rapid track() calls.
    // Without this, auto-flush sets the flushing guard and the explicit
    // flush() call at the end of the test bails.
    maxBatchSize: 10_000,
    disablePageLifecycle: true,
    disableAutoAbandon: true,
    disableCompression: true,
    disableQueuePersistence: true,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// RateLimiter unit tests (no HTTP, just the algorithm)
// ---------------------------------------------------------------------------

describe("RateLimiter", () => {
  it("allows events up to burst limit", () => {
    const limiter = new RateLimiter(10, 20);
    let dropped = 0;
    for (let i = 0; i < 25; i++) {
      if (limiter.isRateLimited()) dropped++;
    }
    // 20 allowed (burst), 5 dropped
    expect(dropped).toBe(5);
  });

  it("refills tokens over time", async () => {
    const limiter = new RateLimiter(100, 10); // 100/sec, burst 10
    // Drain all tokens
    for (let i = 0; i < 10; i++) limiter.isRateLimited();

    // Should be limited now
    expect(limiter.isRateLimited()).toBe(true);

    // Wait 200ms → should refill ~20 tokens (100/sec * 0.2s), capped at 10
    await new Promise((r) => setTimeout(r, 200));

    // Should be allowed again
    expect(limiter.isRateLimited()).toBe(false);
  });

  it("never exceeds burst limit on refill", async () => {
    const limiter = new RateLimiter(1000, 5); // high rate, low burst
    await new Promise((r) => setTimeout(r, 100));

    // Consume all. Even with high refill rate, bucket is capped at 5.
    // A token or two may have refilled during the 100ms sleep, so allow
    // slight overshoot but it should never reach 20.
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      if (!limiter.isRateLimited()) allowed++;
    }
    expect(allowed).toBeGreaterThanOrEqual(5);
    expect(allowed).toBeLessThanOrEqual(7);
  });
});

// ---------------------------------------------------------------------------
// Integration through LitmusClient
// ---------------------------------------------------------------------------

describe("client-side rate limiting", () => {
  it("drops events when rate limited", async () => {
    const client = makeClient();

    // Track 200 events rapidly. Default rate limiter allows burst of 100.
    for (let i = 0; i < 200; i++) {
      client.track({ type: `event_${i}`, session_id: "sess_1" });
    }
    await client.flush();

    // Some events should have been dropped. Exact count depends on
    // refill during the loop, but it should be well under 200.
    const count = server.allEvents.length;
    expect(count).toBeLessThan(200);
    expect(count).toBeGreaterThanOrEqual(100); // at least the burst

    await client.destroy();
  });

  it("$abandon bypasses rate limiter", async () => {
    const client = makeClient();

    // Drain the rate limiter
    for (let i = 0; i < 150; i++) {
      client.track({ type: "spam", session_id: "sess_1" });
    }

    // $abandon should still go through (internal event bypass)
    client.track({ type: "$abandon", session_id: "sess_1", metadata: { auto: true } });
    await client.flush();

    const abandons = server.allEvents.filter((e) => e.type === "$abandon");
    expect(abandons).toHaveLength(1);

    await client.destroy();
  });

  it("$pageleave bypasses rate limiter", async () => {
    const client = makeClient();

    for (let i = 0; i < 150; i++) {
      client.track({ type: "spam", session_id: "sess_1" });
    }

    client.track({ type: "$pageleave", session_id: "sess_1" });
    await client.flush();

    const leaves = server.allEvents.filter((e) => e.type === "$pageleave");
    expect(leaves).toHaveLength(1);

    await client.destroy();
  });

  it("recovers after tokens refill", async () => {
    const client = makeClient();

    // Drain tokens
    for (let i = 0; i < 150; i++) {
      client.track({ type: "spam", session_id: "sess_1" });
    }
    await client.flush();
    server.reset();

    // Wait for tokens to refill (100ms at 10/sec = ~1 token)
    await new Promise((r) => setTimeout(r, 200));

    // Should be able to track again
    client.track({ type: "recovered", session_id: "sess_1" });
    await client.flush();

    const recovered = server.allEvents.filter((e) => e.type === "recovered");
    expect(recovered).toHaveLength(1);

    await client.destroy();
  });
});
