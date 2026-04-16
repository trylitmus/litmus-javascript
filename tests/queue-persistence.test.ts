// ---------------------------------------------------------------------------
// Integration tests: queue persistence to localStorage.
//
// Uses jsdom for localStorage. Tests that events survive page refresh
// (simulated by creating a new client that loads from the same storage key).
//
// @vitest-environment jsdom
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LitmusClient, type LitmusConfig } from "../src";
import { QueueStore } from "../src/queue-store.js";
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
  // Node 25 ships a global localStorage stub without standard methods.
  // jsdom should override it, but guard just in case.
  if (typeof localStorage.clear === "function") {
    localStorage.clear();
  }
});

function makeClient(overrides?: Partial<LitmusConfig>): LitmusClient {
  return new LitmusClient({
    endpoint: server.endpoint,
    apiKey: "ltm_pk_test_persist",
    flushInterval: 999_999,
    disablePageLifecycle: true,
    disableTelemetry: true,
    disableAutoAbandon: true,
    disableCompression: true,
    disableQueuePersistence: false, // enable persistence
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// QueueStore unit tests
// ---------------------------------------------------------------------------

describe("QueueStore", () => {
  it("save and load round-trips events", () => {
    const store = new QueueStore("test_key");
    const events = [
      { type: "a", session_id: "s", id: "1", timestamp: "t" },
      { type: "b", session_id: "s", id: "2", timestamp: "t" },
    ];
    store.save(events as never[]);

    const loaded = new QueueStore("test_key").load();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].type).toBe("a");
    expect(loaded[1].type).toBe("b");
  });

  it("load clears storage after reading", () => {
    const store = new QueueStore("test_key");
    store.save([{ type: "a", session_id: "s", id: "1", timestamp: "t" }] as never[]);

    new QueueStore("test_key").load();

    // Second load should return empty (cleared after first load)
    const secondLoad = new QueueStore("test_key").load();
    expect(secondLoad).toHaveLength(0);
  });

  it("save with empty array clears storage", () => {
    const store = new QueueStore("test_key");
    store.save([{ type: "a", session_id: "s", id: "1", timestamp: "t" }] as never[]);
    store.save([]);

    const loaded = new QueueStore("test_key").load();
    expect(loaded).toHaveLength(0);
  });

  it("different API keys use different storage keys", () => {
    const store1 = new QueueStore("key_aaaa");
    const store2 = new QueueStore("key_bbbb");

    store1.save([{ type: "from_1", session_id: "s", id: "1", timestamp: "t" }] as never[]);
    store2.save([{ type: "from_2", session_id: "s", id: "2", timestamp: "t" }] as never[]);

    expect(new QueueStore("key_aaaa").load()[0].type).toBe("from_1");
    expect(new QueueStore("key_bbbb").load()[0].type).toBe("from_2");
  });
});

// ---------------------------------------------------------------------------
// Integration through LitmusClient
// ---------------------------------------------------------------------------

describe("queue persistence", () => {
  it("restores events from localStorage on construction", async () => {
    // Simulate: client 1 tracks events, doesn't flush, gets destroyed.
    const client1 = makeClient();
    client1.track({ type: "survived", session_id: "sess_1" });
    // destroy() persists the queue to localStorage. Await it for sync.
    await client1.destroy();
    server.reset();

    // Client 2 (same API key) should restore the event.
    const client2 = makeClient();
    await client2.flush();

    // The "survived" event plus $generation/$sessionend from destroy should appear.
    const survived = server.allEvents.filter((e) => e.type === "survived");
    expect(survived.length).toBeGreaterThanOrEqual(1);

    await client2.destroy();
  });

  it("clears localStorage after successful flush", async () => {
    const client = makeClient();
    client.track({ type: "will_flush", session_id: "sess_1" });
    await client.flush();

    // After successful flush, localStorage should be cleared.
    const store = new QueueStore("ltm_pk_t"); // same prefix
    const remaining = store.load();
    expect(remaining).toHaveLength(0);

    await client.destroy();
  });

  it("disableQueuePersistence prevents storage", async () => {
    const client = makeClient({ disableQueuePersistence: true });
    client.track({ type: "ephemeral", session_id: "sess_1" });
    await client.destroy();

    // Nothing should be in localStorage.
    const store = new QueueStore("ltm_pk_t");
    const loaded = store.load();
    expect(loaded).toHaveLength(0);
  });
});
