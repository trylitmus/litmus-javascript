// ---------------------------------------------------------------------------
// Integration tests: auto-abandon detection.
//
// Uses jsdom for DOM event dispatching (mousemove, etc.) and REAL timers
// with short thresholds. No fake timers — they corrupt Node's HTTP stack
// (fetch uses timers internally), causing flushes to silently hang.
//
// Instead we use:
//   abandonThreshold: 200ms   (detect idle after 200ms)
//   abandonCheckInterval: 50ms (check every 50ms)
//
// This means tests take ~300-500ms each but test fully real behavior.
//
// @vitest-environment jsdom
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LitmusClient, type LitmusConfig } from "../src";
import { createTestServer, type TestServer } from "./helpers.js";

let server: TestServer;

beforeAll(async () => {
  server = createTestServer();
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

beforeEach(() => {
  server.reset();
});

// Short thresholds for fast tests. Real timers, real HTTP, real abandon detection.
// The check interval must be well under the threshold, and the activity dispatch
// interval (THRESHOLD / 3) must be under the 1s activity throttle AND frequent
// enough to reliably reset the timer between checks.
const THRESHOLD = 500;
const CHECK_INTERVAL = 100;

function makeClient(overrides?: Partial<LitmusConfig>): LitmusClient {
  return new LitmusClient({
    endpoint: server.endpoint,
    apiKey: "ltm_pk_test_abandon",
    flushInterval: 999_999,
    disablePageLifecycle: true,
    disableTelemetry: true,
    disableAutoAbandon: false,
    abandonThreshold: THRESHOLD,
    abandonCheckInterval: CHECK_INTERVAL,
    ...overrides,
  });
}

/** Wait long enough for the idle check to fire after the threshold. */
function waitForAbandon(): Promise<void> {
  // threshold + check interval + buffer
  return new Promise((r) => setTimeout(r, THRESHOLD + CHECK_INTERVAL * 2 + 100));
}

// ---------------------------------------------------------------------------
// Basic abandon detection
// ---------------------------------------------------------------------------

describe("auto-abandon", () => {
  it("fires $abandon after idle threshold with no interaction", async () => {
    const client = makeClient();
    const gen = client.generation(crypto.randomUUID());

    await waitForAbandon();
    await client.flush();

    const abandons = server.allEvents.filter((e) => e.type === "$abandon");
    expect(abandons).toHaveLength(1);
    expect(abandons[0].generation_id).toBe(gen.id);
    expect(abandons[0].metadata).toMatchObject({ auto: true });
    expect(abandons[0].metadata?.idle_ms).toBeGreaterThanOrEqual(THRESHOLD);
    expect(abandons[0].metadata?.time_to_abandon_ms).toBeDefined();

    await client.destroy();
  });

  it("does NOT fire $abandon if a behavioral signal was tracked", async () => {
    const client = makeClient();
    const gen = client.generation(crypto.randomUUID());

    // User accepts — resolves from abandon tracking.
    gen.event("$accept");

    await waitForAbandon();
    await client.flush();

    const abandons = server.allEvents.filter((e) => e.type === "$abandon");
    expect(abandons).toHaveLength(0);

    await client.destroy();
  });

  it("$view does NOT resolve from auto-abandon", async () => {
    const client = makeClient();
    const gen = client.generation(crypto.randomUUID());

    // View is passive — should NOT prevent abandon.
    gen.event("$view");

    await waitForAbandon();
    await client.flush();

    const abandons = server.allEvents.filter((e) => e.type === "$abandon");
    expect(abandons).toHaveLength(1);
    expect(abandons[0].generation_id).toBe(gen.id);

    await client.destroy();
  });

  it("gen.edit() resolves from auto-abandon", async () => {
    const client = makeClient();
    const gen = client.generation(crypto.randomUUID());

    gen.edit({ before: "original", after: "modified" });

    await waitForAbandon();
    await client.flush();

    const abandons = server.allEvents.filter((e) => e.type === "$abandon");
    expect(abandons).toHaveLength(0);

    await client.destroy();
  });
});

// ---------------------------------------------------------------------------
// Activity detection
// ---------------------------------------------------------------------------

describe("activity detection", () => {
  it("mouse activity resets the idle timer", async () => {
    const client = makeClient();
    client.generation(crypto.randomUUID());

    // Keep dispatching activity to prevent abandon.
    const keepAlive = setInterval(() => {
      window.dispatchEvent(new Event("mousemove"));
    }, THRESHOLD / 3);

    // Wait past the threshold — activity should prevent abandon.
    await waitForAbandon();
    clearInterval(keepAlive);
    await client.flush();

    const abandons = server.allEvents.filter((e) => e.type === "$abandon");
    expect(abandons).toHaveLength(0);

    await client.destroy();
  });

  it("keyboard activity resets the idle timer", async () => {
    const client = makeClient();
    const gen = client.generation(crypto.randomUUID());

    const keepAlive = setInterval(() => {
      window.dispatchEvent(new Event("keydown"));
    }, THRESHOLD / 3);

    await waitForAbandon();
    clearInterval(keepAlive);
    await client.flush();

    // Filter by this test's generation to avoid cross-test pollution from
    // fire-and-forget fetches in destroy().
    const abandons = server.allEvents.filter((e) => e.type === "$abandon" && e.generation_id === gen.id);
    expect(abandons).toHaveLength(0);

    await client.destroy();
  });

  it("scroll activity resets the idle timer", async () => {
    const client = makeClient();
    const gen = client.generation(crypto.randomUUID());

    const keepAlive = setInterval(() => {
      window.dispatchEvent(new Event("scroll"));
    }, THRESHOLD / 3);

    await waitForAbandon();
    clearInterval(keepAlive);
    await client.flush();

    const abandons = server.allEvents.filter((e) => e.type === "$abandon" && e.generation_id === gen.id);
    expect(abandons).toHaveLength(0);

    await client.destroy();
  });

  it("activity stops then idle triggers abandon", async () => {
    const client = makeClient();
    const gen = client.generation(crypto.randomUUID());

    // Keep alive for a bit, then stop.
    const keepAlive = setInterval(() => {
      window.dispatchEvent(new Event("mousemove"));
    }, THRESHOLD / 3);

    await new Promise((r) => setTimeout(r, THRESHOLD + 50));
    clearInterval(keepAlive);

    // Now go idle — abandon should fire.
    await waitForAbandon();
    await client.flush();

    const abandons = server.allEvents.filter((e) => e.type === "$abandon" && e.generation_id === gen.id);
    expect(abandons).toHaveLength(1);

    await client.destroy();
  });
});

// ---------------------------------------------------------------------------
// Multiple generations
// ---------------------------------------------------------------------------

describe("multiple open generations", () => {
  it("abandons all unresolved generations when user goes idle", async () => {
    const client = makeClient();
    const gen1 = client.generation(crypto.randomUUID());
    const gen2 = client.generation(crypto.randomUUID());
    const gen3 = client.generation(crypto.randomUUID());

    // Resolve gen2 only.
    gen2.event("$accept");

    await waitForAbandon();
    await client.flush();

    const abandons = server.allEvents.filter((e) => e.type === "$abandon");
    expect(abandons).toHaveLength(2);

    const abandonedIds = abandons.map((e) => e.generation_id);
    expect(abandonedIds).toContain(gen1.id);
    expect(abandonedIds).toContain(gen3.id);
    expect(abandonedIds).not.toContain(gen2.id);

    await client.destroy();
  });
});

// ---------------------------------------------------------------------------
// destroy() fires abandon
// ---------------------------------------------------------------------------

describe("destroy()", () => {
  it("fires $abandon for all open generations with reason=destroy", async () => {
    const client = makeClient();
    const gen = client.generation(crypto.randomUUID());

    // Flush the $generation event, then reset so we only see $abandon.
    await client.flush();
    server.reset();

    // destroy() is async — await it for proper synchronization.
    await client.destroy();

    const abandons = server.allEvents.filter((e) => e.type === "$abandon");
    expect(abandons).toHaveLength(1);
    expect(abandons[0].generation_id).toBe(gen.id);
    expect(abandons[0].metadata).toMatchObject({ auto: true, reason: "destroy" });
  });
});

// ---------------------------------------------------------------------------
// disableAutoAbandon
// ---------------------------------------------------------------------------

describe("disableAutoAbandon", () => {
  it("prevents all auto-abandon behavior", async () => {
    const client = makeClient({ disableAutoAbandon: true });
    const gen = client.generation(crypto.randomUUID());

    await waitForAbandon();
    await client.flush();

    const abandons = server.allEvents.filter((e) => e.type === "$abandon" && e.generation_id === gen.id);
    expect(abandons).toHaveLength(0);

    await client.destroy();
  });
});
