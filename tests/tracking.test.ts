// ---------------------------------------------------------------------------
// Integration tests: event tracking pipeline.
//
// Real HTTP server, real LitmusClient, real fetch. No mocks.
// Tests the full path: SDK call → buffer → flush → HTTP → server capture.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LitmusClient, type LitmusConfig } from "../src/index.js";
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

/** Create a client pointed at the test server with lifecycle/abandon/startup disabled. */
function makeClient(overrides?: Partial<LitmusConfig>): LitmusClient {
  return new LitmusClient({
    endpoint: server.endpoint,
    apiKey: "ltm_pk_test_integration",
    // Disable timers and browser-specific stuff for clean test isolation.
    flushInterval: 999_999,
    disablePageLifecycle: true,
    disableAutoAbandon: true,
    disableCompression: true,
    disableTelemetry: true,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// generation()
// ---------------------------------------------------------------------------

describe("generation()", () => {
  it("emits a $generation event with correct fields", async () => {
    const client = makeClient();

    const gen = client.generation("sess_1", {
      prompt_id: "chat",
      prompt_version: "v2.3",
      user_id: "user_42",
      metadata: { model: "gpt-4o", temperature: 0.7 },
    });

    await client.flush();

    expect(server.allEvents).toHaveLength(1);
    const event = server.allEvents[0];
    expect(event.type).toBe("$generation");
    expect(event.session_id).toBe("sess_1");
    expect(event.prompt_id).toBe("chat");
    expect(event.prompt_version).toBe("v2.3");
    expect(event.user_id).toBe("user_42");
    expect(event.generation_id).toBe(gen.id);
    expect(event.metadata).toMatchObject({ model: "gpt-4o", temperature: 0.7 });

    // Must have a UUID id and ISO timestamp.
    expect(event.id).toMatch(/^[0-9a-f]{8}-/);
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await client.destroy();
  });

  it("returns a handle with a stable UUID id", async () => {
    const client = makeClient();
    const gen = client.generation("sess_1");

    expect(gen.id).toMatch(/^[0-9a-f]{8}-/);
    expect(gen.id).toBe(gen.id); // same reference

    await client.destroy();
  });

  // Regression guard: in v0.4.0 these kwargs were accepted but silently
  // dropped before the wire payload was built, so the server stored
  // everything in metadata and the dedicated model/provider/cost columns
  // were always NULL. These must ride as top-level fields.
  it("emits model, provider, tokens, cost as top-level wire fields", async () => {
    const client = makeClient();

    client.generation("sess_1", {
      prompt_id: "chat",
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
      input_tokens: 120,
      output_tokens: 340,
      total_tokens: 460,
      duration_ms: 1850,
      ttft_ms: 240,
      cost: 0.0042,
    });

    await client.flush();

    const event = server.allEvents[0];
    expect(event.type).toBe("$generation");
    expect(event.model).toBe("claude-sonnet-4-20250514");
    expect(event.provider).toBe("anthropic");
    expect(event.input_tokens).toBe(120);
    expect(event.output_tokens).toBe(340);
    expect(event.total_tokens).toBe(460);
    expect(event.duration_ms).toBe(1850);
    expect(event.ttft_ms).toBe(240);
    expect(event.cost).toBe(0.0042);

    // Sanity: metadata still carries $lib/$lib_version but NOT the promoted fields.
    expect(event.metadata?.model).toBeUndefined();
    expect(event.metadata?.cost).toBeUndefined();

    await client.destroy();
  });

  it("omits top-level fields when not provided", async () => {
    const client = makeClient();
    client.generation("sess_1", { prompt_id: "chat" });
    await client.flush();

    const event = server.allEvents[0];
    for (const key of [
      "model",
      "provider",
      "input_tokens",
      "output_tokens",
      "total_tokens",
      "duration_ms",
      "ttft_ms",
      "cost",
    ] as const) {
      expect(event[key as keyof typeof event]).toBeUndefined();
    }

    await client.destroy();
  });
});

// ---------------------------------------------------------------------------
// gen.event()
// ---------------------------------------------------------------------------

describe("gen.event()", () => {
  it("tracks a behavioral signal with correct fields", async () => {
    const client = makeClient();
    const gen = client.generation("sess_1", {
      prompt_id: "summarize",
      prompt_version: "v1.0",
      user_id: "user_7",
    });

    gen.event("$accept");
    await client.flush();

    // $generation + $accept = 2 events.
    expect(server.allEvents).toHaveLength(2);
    const accept = server.allEvents[1];
    expect(accept.type).toBe("$accept");
    expect(accept.session_id).toBe("sess_1");
    expect(accept.generation_id).toBe(gen.id);
    expect(accept.prompt_id).toBe("summarize");
    expect(accept.prompt_version).toBe("v1.0");
    expect(accept.user_id).toBe("user_7");

    await client.destroy();
  });

  it("merges metadata from defaults and call site", async () => {
    const client = makeClient();
    const gen = client.generation("sess_1", {
      metadata: { model: "gpt-4o" },
    });

    gen.event("$copy", { source: "button" });
    await client.flush();

    const copy = server.allEvents[1];
    expect(copy.metadata).toMatchObject({ model: "gpt-4o", source: "button" });

    await client.destroy();
  });

  it("supports custom event types", async () => {
    const client = makeClient();
    const gen = client.generation("sess_1");

    gen.event("my_custom_signal", { score: 42 });
    await client.flush();

    const custom = server.allEvents[1];
    expect(custom.type).toBe("my_custom_signal");
    expect(custom.metadata).toMatchObject({ score: 42 });

    await client.destroy();
  });

  it("tracks $view without extra behavior", async () => {
    const client = makeClient();
    const gen = client.generation("sess_1");

    gen.event("$view", { viewport_pct: 0.8 });
    await client.flush();

    const view = server.allEvents[1];
    expect(view.type).toBe("$view");
    expect(view.metadata).toMatchObject({ viewport_pct: 0.8 });

    await client.destroy();
  });
});

// ---------------------------------------------------------------------------
// gen.edit()
// ---------------------------------------------------------------------------

describe("gen.edit()", () => {
  it("sends raw before/after text as metadata", async () => {
    const client = makeClient();
    const gen = client.generation("sess_1");

    gen.edit({
      before: "The quick brown fox",
      after: "A quick brown fox jumps",
    });
    await client.flush();

    const edit = server.allEvents[1];
    expect(edit.type).toBe("$edit");
    expect(edit.metadata).toMatchObject({
      before: "The quick brown fox",
      after: "A quick brown fox jumps",
    });

    await client.destroy();
  });

  it("merges extra metadata with before/after", async () => {
    const client = makeClient();
    const gen = client.generation("sess_1", {
      metadata: { model: "gpt-4o" },
    });

    gen.edit({
      before: "original",
      after: "modified",
      metadata: { editor: "textarea" },
    });
    await client.flush();

    const edit = server.allEvents[1];
    expect(edit.metadata).toMatchObject({
      model: "gpt-4o",
      editor: "textarea",
      before: "original",
      after: "modified",
    });

    await client.destroy();
  });
});

// ---------------------------------------------------------------------------
// attach()
// ---------------------------------------------------------------------------

describe("attach()", () => {
  it("returns a handle without emitting $generation", async () => {
    const client = makeClient();

    const gen = client.attach("existing_gen_id", "sess_1", {
      user_id: "user_7",
    });

    gen.event("$accept");
    await client.flush();

    // Only the $accept event, no $generation.
    expect(server.allEvents).toHaveLength(1);
    expect(server.allEvents[0].type).toBe("$accept");
    expect(server.allEvents[0].generation_id).toBe("existing_gen_id");
    expect(server.allEvents[0].user_id).toBe("user_7");

    await client.destroy();
  });
});

// ---------------------------------------------------------------------------
// feature()
// ---------------------------------------------------------------------------

describe("feature()", () => {
  it("propagates defaults to generations", async () => {
    const client = makeClient();
    const feat = client.feature("summarizer", {
      model: "gpt-4o",
      user_id: "user_99",
    });

    const gen = feat.generation("sess_1", { prompt_version: "v3.0" });
    gen.event("$accept");
    await client.flush();

    // $generation event should have feature defaults.
    const genEvent = server.allEvents[0];
    expect(genEvent.type).toBe("$generation");
    expect(genEvent.prompt_id).toBe("summarizer");
    expect(genEvent.prompt_version).toBe("v3.0");
    expect(genEvent.user_id).toBe("user_99");
    // model is a wire-level field: top-level on the event, not duplicated
    // into metadata. Only feature name stays in metadata.
    expect(genEvent.metadata).toMatchObject({ feature: "summarizer" });
    expect(genEvent.metadata).not.toHaveProperty("model");
    expect((genEvent as { model?: string }).model).toBe("gpt-4o");

    await client.destroy();
  });

  it("uses feature name as default prompt_id", async () => {
    const client = makeClient();
    const feat = client.feature("email_drafter");
    feat.generation("sess_1");

    await client.flush();

    expect(server.allEvents[0].prompt_id).toBe("email_drafter");

    await client.destroy();
  });
});

// ---------------------------------------------------------------------------
// Wire-level fields: every entry point must surface these at the top of the
// event payload (not inside metadata). The ingest server writes them to
// typed Postgres columns (events.model, events.cost, ...). This block is
// the regression guard for the v0.5.0 bug where Feature.generation() and
// Feature.track() dropped or duplicated them.
// ---------------------------------------------------------------------------

describe("wire-level fields", () => {
  const SAMPLE = {
    model: "gpt-4o",
    provider: "openai",
    input_tokens: 120,
    output_tokens: 340,
    total_tokens: 460,
    duration_ms: 1850,
    ttft_ms: 240,
    cost: 0.0042,
  } as const;

  function assertTopLevelNoLeak(event: Record<string, unknown>) {
    for (const [key, expected] of Object.entries(SAMPLE)) {
      expect(event[key]).toBe(expected);
      const meta = (event.metadata ?? {}) as Record<string, unknown>;
      expect(meta).not.toHaveProperty(key);
    }
  }

  it("track() serializes wire fields at top level", async () => {
    const client = makeClient();
    client.track({ type: "$generation", session_id: "s1", ...SAMPLE });
    await client.flush();

    assertTopLevelNoLeak(server.allEvents[0]);
    await client.destroy();
  });

  it("generation() serializes wire fields at top level", async () => {
    const client = makeClient();
    client.generation("s1", { prompt_id: "chat", ...SAMPLE });
    await client.flush();

    const gen = server.allEvents.find((e) => e.type === "$generation")!;
    assertTopLevelNoLeak(gen as unknown as Record<string, unknown>);
    await client.destroy();
  });

  it("gen.event() serializes wire fields at top level (e.g. $switch_model)", async () => {
    const client = makeClient();
    const gen = client.generation("s1", { prompt_id: "chat" });
    gen.event("$switch_model", { ...SAMPLE });
    await client.flush();

    const switchEvent = server.allEvents.find((e) => e.type === "$switch_model")!;
    assertTopLevelNoLeak(switchEvent as unknown as Record<string, unknown>);
    await client.destroy();
  });

  it("feature.generation() forwards per-call wire fields at top level", async () => {
    const client = makeClient();
    const feat = client.feature("summarizer");
    feat.generation("s1", { ...SAMPLE });
    await client.flush();

    const gen = server.allEvents.find((e) => e.type === "$generation")!;
    assertTopLevelNoLeak(gen as unknown as Record<string, unknown>);
    await client.destroy();
  });

  it("feature.track() serializes wire fields at top level", async () => {
    const client = makeClient();
    const feat = client.feature("summarizer");
    feat.track({ type: "$generation", session_id: "s1", ...SAMPLE });
    await client.flush();

    assertTopLevelNoLeak(server.allEvents[0] as unknown as Record<string, unknown>);
    await client.destroy();
  });

  it("feature default model/provider go top-level, never into metadata", async () => {
    const client = makeClient();
    const feat = client.feature("content_gen", { model: "gpt-4o", provider: "openai" });
    feat.generation("s1");
    await client.flush();

    const gen = server.allEvents.find((e) => e.type === "$generation")!;
    expect(gen.model).toBe("gpt-4o");
    expect(gen.provider).toBe("openai");
    expect(gen.metadata).not.toHaveProperty("model");
    expect(gen.metadata).not.toHaveProperty("provider");
    await client.destroy();
  });

  it("per-call model overrides feature default", async () => {
    const client = makeClient();
    const feat = client.feature("chat", { model: "gpt-4o-mini" });
    feat.generation("s1", { model: "gpt-4o" });
    await client.flush();

    const gen = server.allEvents.find((e) => e.type === "$generation")!;
    expect(gen.model).toBe("gpt-4o");
    await client.destroy();
  });
});

// ---------------------------------------------------------------------------
// Buffering
// ---------------------------------------------------------------------------

describe("buffering", () => {
  it("batches multiple events into a single flush", async () => {
    const client = makeClient();

    const gen = client.generation("sess_1");
    gen.event("$accept");
    gen.event("$copy");
    await client.flush();

    // All 3 events ($generation + $accept + $copy) in one batch.
    expect(server.batches).toHaveLength(1);
    expect(server.batches[0].events).toHaveLength(3);

    await client.destroy();
  });

  it("drops oldest events when queue overflows", async () => {
    const client = makeClient({ maxQueueSize: 3 });

    // Track 5 events — queue cap is 3, so the oldest 2 are dropped.
    for (let i = 0; i < 5; i++) {
      client.track({
        type: `event_${i}`,
        session_id: "sess_1",
      });
    }
    await client.flush();

    expect(server.allEvents).toHaveLength(3);
    // Oldest (event_0, event_1) should be gone.
    expect(server.allEvents.map((e) => e.type)).toEqual(["event_2", "event_3", "event_4"]);

    await client.destroy();
  });

  it("does nothing on flush when buffer is empty", async () => {
    const client = makeClient();
    await client.flush();

    expect(server.batches).toHaveLength(0);

    await client.destroy();
  });

  it("ignores track() calls after destroy()", async () => {
    const client = makeClient();
    await client.destroy();

    client.track({ type: "should_not_send", session_id: "sess_1" });
    // flush() would also short-circuit, but let's try anyway.
    await client.flush();

    expect(server.allEvents).toHaveLength(0);
  });

  it("assigns unique UUIDs to each event", async () => {
    const client = makeClient();

    client.track({ type: "a", session_id: "sess_1" });
    client.track({ type: "b", session_id: "sess_1" });
    await client.flush();

    const ids = server.allEvents.map((e) => e.id);
    expect(ids[0]).not.toBe(ids[1]);

    await client.destroy();
  });

  it("timestamps events at track time, not flush time", async () => {
    const client = makeClient();

    const beforeTrack = new Date().toISOString();
    client.track({ type: "a", session_id: "sess_1" });
    const afterTrack = new Date().toISOString();

    // Wait a bit then flush.
    await new Promise((r) => setTimeout(r, 50));
    await client.flush();

    const ts = server.allEvents[0].timestamp;
    expect(ts >= beforeTrack).toBe(true);
    expect(ts <= afterTrack).toBe(true);

    await client.destroy();
  });
});

// ---------------------------------------------------------------------------
// SDK identification
// ---------------------------------------------------------------------------

describe("SDK identification", () => {
  it("injects $lib and $lib_version into every event metadata", async () => {
    const client = makeClient();
    client.track({ type: "test", session_id: "sess_1", metadata: { custom: "value" } });
    await client.flush();

    const event = server.allEvents[0];
    expect(event.metadata?.$lib).toBe("litmus-ts");
    expect(event.metadata?.$lib_version).toBeDefined();
    // Custom metadata should still be there.
    expect(event.metadata?.custom).toBe("value");

    await client.destroy();
  });

  it("$lib_version matches SDK_VERSION export", async () => {
    const { SDK_VERSION } = await import("../src/version.js");
    const client = makeClient();
    client.track({ type: "test", session_id: "sess_1" });
    await client.flush();

    expect(server.allEvents[0].metadata?.$lib_version).toBe(SDK_VERSION);

    await client.destroy();
  });
});

// ---------------------------------------------------------------------------
// Opt-out / consent
// ---------------------------------------------------------------------------

describe("opt-out", () => {
  it("track() is a no-op when opted out", async () => {
    const client = makeClient();
    client.optOut();

    client.track({ type: "should_not_send", session_id: "sess_1" });
    await client.flush();

    expect(server.allEvents).toHaveLength(0);

    await client.destroy();
  });

  it("generation() is a no-op when opted out (events gated by track)", async () => {
    const client = makeClient();
    client.optOut();

    const gen = client.generation("sess_1");
    gen.event("$accept");
    await client.flush();

    expect(server.allEvents).toHaveLength(0);

    await client.destroy();
  });

  it("optIn() re-enables tracking after optOut()", async () => {
    const client = makeClient();
    client.optOut();
    client.optIn();

    client.track({ type: "should_send", session_id: "sess_1" });
    await client.flush();

    expect(server.allEvents).toHaveLength(1);

    await client.destroy();
  });

  it("hasOptedOut() reflects current state", async () => {
    const client = makeClient();
    expect(client.hasOptedOut()).toBe(false);

    client.optOut();
    expect(client.hasOptedOut()).toBe(true);

    client.optIn();
    expect(client.hasOptedOut()).toBe(false);

    await client.destroy();
  });

  it("defaultOptOut starts tracking disabled", async () => {
    const client = makeClient({ defaultOptOut: true });

    client.track({ type: "should_not_send", session_id: "sess_1" });
    await client.flush();

    expect(server.allEvents).toHaveLength(0);
    expect(client.hasOptedOut()).toBe(true);

    await client.destroy();
  });
});

// ---------------------------------------------------------------------------
// $startup event
// ---------------------------------------------------------------------------

describe("$startup", () => {
  it("fires on init with environment metadata", async () => {
    const client = makeClient({ disableTelemetry: false });
    await client.flush();

    const startup = server.allEvents.find((e) => e.type === "$startup");
    expect(startup).toBeDefined();
    expect(startup!.session_id).toBe("");
    expect(startup!.metadata).toHaveProperty("platform");
    expect(startup!.metadata?.$lib).toBe("litmus-ts");

    await client.destroy();
  });

  it("is suppressed by disableTelemetry", async () => {
    const client = makeClient({ disableTelemetry: true });
    await client.flush();

    expect(server.allEvents.find((e) => e.type === "$startup")).toBeUndefined();

    await client.destroy();
  });
});
