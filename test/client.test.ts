import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { LitmusClient } from "../src";
import type { TrackEvent } from "../src";

// Captures request bodies sent to the mock server.
// Mirrors the wire shape defined in contract/openapi.yaml.
interface CapturedEvent {
  id: string;
  type: string;
  session_id: string;
  user_id?: string;
  timestamp: string;
  generation_id?: string;
  prompt_id?: string;
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
}

interface CapturedRequest {
  events: CapturedEvent[];
}

interface MockResponse {
  status: number;
  headers?: Record<string, string>;
}

function createMockServer(responses: Array<MockResponse>) {
  const requests: CapturedRequest[] = [];
  let callIndex = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as CapturedRequest;
    requests.push(body);

    const response = responses[callIndex] ?? { status: 202 };
    callIndex++;

    const resHeaders = new Headers({ "Content-Type": "application/json" });
    if (response.headers) {
      for (const [k, v] of Object.entries(response.headers)) {
        resHeaders.set(k, v);
      }
    }

    return new Response(JSON.stringify({ accepted: body.events.length }), {
      status: response.status,
      headers: resHeaders,
    });
  }) as typeof fetch;

  return {
    requests,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function createThrowingServer() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => {
    throw new Error("network down");
  }) as typeof fetch;

  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function newClient(overrides: Partial<{
  flushInterval: number;
  maxBatchSize: number;
  maxQueueSize: number;
}> = {}) {
  return new LitmusClient({
    endpoint: "http://localhost:9999",
    apiKey: "ltm_pk_test_abc123",
    flushInterval: 60000, // large interval so we control flushes manually
    disablePageLifecycle: true, // no DOM in test env
    ...overrides,
  });
}

describe("LitmusClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("event ID stability across retries", () => {
    it("retries send the exact same event IDs", async () => {
      // First flush fails (500), second succeeds (202).
      const mock = createMockServer([{ status: 500 }, { status: 202 }]);
      const client = newClient();

      const events: TrackEvent[] = [
        { type: "$generation", session_id: "sess_1" },
        { type: "$copy", session_id: "sess_1" },
        { type: "$regenerate", session_id: "sess_2" },
      ];

      for (const e of events) {
        client.track(e);
      }

      // First flush: server returns 500, events go back in buffer.
      await client.flush();
      expect(mock.requests).toHaveLength(1);

      const firstAttemptIDs = mock.requests[0].events.map((e) => e.id);
      expect(firstAttemptIDs).toHaveLength(3);
      // Every event should have a UUID
      for (const id of firstAttemptIDs) {
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      }

      // Second flush: server returns 202, same events resent.
      await client.flush();
      expect(mock.requests).toHaveLength(2);

      const secondAttemptIDs = mock.requests[1].events.map((e) => e.id);

      // The whole point: same IDs on retry.
      expect(secondAttemptIDs).toEqual(firstAttemptIDs);

      // Buffer should be empty now (flush succeeded).
      await client.flush();
      expect(mock.requests).toHaveLength(2); // no third request

      client.destroy();
      mock.restore();
    });

    it("each tracked event gets a unique ID", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      client.track({ type: "$generation", session_id: "s1" });
      client.track({ type: "$generation", session_id: "s1" });
      client.track({ type: "$copy", session_id: "s2" });

      await client.flush();

      const ids = mock.requests[0].events.map((e) => e.id);
      const unique = new Set(ids);
      expect(unique.size).toBe(3);

      client.destroy();
      mock.restore();
    });
  });

  describe("auto-flush on maxBatchSize", () => {
    it("flushes when buffer hits maxBatchSize", async () => {
      const mock = createMockServer([]);
      const client = newClient({ maxBatchSize: 3 });

      client.track({ type: "$generation", session_id: "s1" });
      client.track({ type: "$copy", session_id: "s1" });

      // Not yet at threshold.
      expect(mock.requests).toHaveLength(0);

      // This should trigger auto-flush.
      client.track({ type: "$edit", session_id: "s1" });

      // flush() is called synchronously from track(), but the fetch is async.
      // Give it a tick to land.
      await vi.waitFor(() => expect(mock.requests).toHaveLength(1));

      expect(mock.requests[0].events).toHaveLength(3);

      client.destroy();
      mock.restore();
    });
  });

  describe("empty flush is a no-op", () => {
    it("does not send a request when buffer is empty", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      await client.flush();
      await client.flush();

      expect(mock.requests).toHaveLength(0);

      client.destroy();
      mock.restore();
    });
  });

  describe("network error handling", () => {
    it("preserves buffer on network error", async () => {
      const throwing = createThrowingServer();
      const client = newClient();

      client.track({ type: "$generation", session_id: "s1" });
      client.track({ type: "$copy", session_id: "s1" });

      // Flush will fail (network error), events should stay in buffer.
      await client.flush();

      throwing.restore();

      // Now set up a working server and flush again.
      const mock = createMockServer([]);
      await client.flush();

      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0].events).toHaveLength(2);

      client.destroy();
      mock.restore();
    });

    it("preserves event order after network error", async () => {
      const throwing = createThrowingServer();
      const client = newClient();

      client.track({ type: "$generation", session_id: "s1" });
      client.track({ type: "$copy", session_id: "s1" });

      // Flush fails.
      await client.flush();
      throwing.restore();

      // Track more events after the failure.
      const mock = createMockServer([]);
      client.track({ type: "$edit", session_id: "s1" });

      await client.flush();

      // Original events should come before the new one.
      const types = mock.requests[0].events.map((e) => e.type);
      expect(types).toEqual(["$generation", "$copy", "$edit"]);

      client.destroy();
      mock.restore();
    });
  });

  describe("destroy", () => {
    it("clears the interval timer", () => {
      const mock = createMockServer([]);
      const client = newClient({ flushInterval: 50 });

      client.track({ type: "$generation", session_id: "s1" });
      client.destroy();

      // After destroy, no more automatic flushes should fire.
      const requestCountAfterDestroy = mock.requests.length;

      // Wait longer than the flush interval to confirm no more fire.
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(mock.requests.length).toBe(requestCountAfterDestroy);
          mock.restore();
          resolve();
        }, 150);
      });
    });

    it("ignores track() calls after destroy", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      client.destroy();
      client.track({ type: "$generation", session_id: "s1" });

      await client.flush();
      // The track was ignored, nothing to flush.
      expect(mock.requests).toHaveLength(0);

      mock.restore();
    });
  });

  describe("exponential backoff", () => {
    it("retries with exponential backoff on flush failure", async () => {
      vi.useFakeTimers();
      const mock = createMockServer([{ status: 500 }, { status: 500 }, { status: 202 }]);
      const client = newClient();

      client.track({ type: "$generation", session_id: "s1" });

      // First flush fails, consecutiveFailures = 1
      await client.flush();
      expect(mock.requests).toHaveLength(1);

      // Backoff delay for failure 1: min(1000 * 2^0, 30000) + jitter = ~1000-1999ms
      await vi.advanceTimersByTimeAsync(2000);

      // Second flush fires via backoff, also fails, consecutiveFailures = 2
      expect(mock.requests).toHaveLength(2);

      // Backoff delay for failure 2: min(1000 * 2^1, 30000) + jitter = ~2000-2999ms
      await vi.advanceTimersByTimeAsync(3000);

      // Third flush fires via backoff, succeeds
      expect(mock.requests).toHaveLength(3);

      // All three requests should contain the same event (same IDs)
      const ids = mock.requests.map((r) => r.events[0].id);
      expect(ids[0]).toBe(ids[1]);
      expect(ids[1]).toBe(ids[2]);

      client.destroy();
      mock.restore();
      vi.useRealTimers();
    });

    it("drops batch after max retries", async () => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Generate 11 500 responses (initial flush + 10 retries)
      const responses = Array.from({ length: 11 }, () => ({ status: 500 }));
      const mock = createMockServer(responses);
      const client = newClient();

      client.track({ type: "$generation", session_id: "s1" });

      // Initial flush fails
      await client.flush();
      expect(mock.requests).toHaveLength(1);

      // Burn through all 10 retries. Each needs enough time for the backoff.
      for (let i = 1; i <= 10; i++) {
        // Max possible delay: min(1000 * 2^(i-1), 30000) + 1000
        const maxDelay = Math.min(1000 * Math.pow(2, i - 1), 30000) + 1000;
        await vi.advanceTimersByTimeAsync(maxDelay);
      }

      expect(warnSpy).toHaveBeenCalledWith("[litmus] batch dropped after 10 retries");

      // Buffer should be empty now
      await client.flush();

      client.destroy();
      mock.restore();
      warnSpy.mockRestore();
      vi.useRealTimers();
    });

    it("resets backoff counter on success", async () => {
      vi.useFakeTimers();
      // Fail once, then succeed, then fail once more
      const mock = createMockServer([
        { status: 500 },
        { status: 202 },
        { status: 500 },
        { status: 202 },
      ]);
      const client = newClient();

      client.track({ type: "$generation", session_id: "s1" });

      // First flush fails
      await client.flush();
      expect(mock.requests).toHaveLength(1);

      // Advance past backoff for failure 1: base delay ~1000-1999ms
      await vi.advanceTimersByTimeAsync(2000);
      expect(mock.requests).toHaveLength(2); // retry succeeds

      // Track a new event and fail again
      client.track({ type: "$copy", session_id: "s2" });
      await client.flush();
      expect(mock.requests).toHaveLength(3); // fails

      // If counter was reset, backoff should be base delay again (~1000-1999ms)
      await vi.advanceTimersByTimeAsync(2000);
      expect(mock.requests).toHaveLength(4); // retry succeeds

      client.destroy();
      mock.restore();
      vi.useRealTimers();
    });

    it("pauses regular flush interval during backoff", async () => {
      vi.useFakeTimers();
      const mock = createMockServer([{ status: 500 }, { status: 202 }]);
      // Use a short flush interval so we can verify it doesn't fire during backoff
      const client = newClient({ flushInterval: 500 });

      client.track({ type: "$generation", session_id: "s1" });

      // Manually flush, which fails and triggers backoff
      await client.flush();
      expect(mock.requests).toHaveLength(1);

      // Track another event while in backoff
      client.track({ type: "$copy", session_id: "s2" });

      // Advance by 500ms (the flush interval). The regular interval should
      // be paused, so no new flush should fire.
      await vi.advanceTimersByTimeAsync(500);
      expect(mock.requests).toHaveLength(1); // no competing flush

      // Advance enough for the backoff timer to fire
      await vi.advanceTimersByTimeAsync(1500);
      expect(mock.requests).toHaveLength(2); // backoff retry fired

      // The backoff retry should include both events (original + new one)
      expect(mock.requests[1].events).toHaveLength(2);

      client.destroy();
      mock.restore();
      vi.useRealTimers();
    });
  });

  describe("smart retry", () => {
    it("does NOT retry 400 (bad request)", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mock = createMockServer([{ status: 400 }, { status: 202 }]);
      const client = newClient();

      client.track({ type: "$generation", session_id: "s1" });
      await client.flush();

      // Events are dropped, not retried.
      expect(mock.requests).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("permanently rejected (400)"),
      );

      // Nothing left to flush.
      await client.flush();
      expect(mock.requests).toHaveLength(1);

      client.destroy();
      mock.restore();
      errorSpy.mockRestore();
    });

    it("does NOT retry 401 (unauthorized)", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mock = createMockServer([{ status: 401 }]);
      const client = newClient();

      client.track({ type: "$generation", session_id: "s1" });
      await client.flush();

      expect(mock.requests).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("permanently rejected (401)"),
      );

      await client.flush();
      expect(mock.requests).toHaveLength(1);

      client.destroy();
      mock.restore();
      errorSpy.mockRestore();
    });

    it("does NOT retry 403 (forbidden)", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mock = createMockServer([{ status: 403 }]);
      const client = newClient();

      client.track({ type: "$generation", session_id: "s1" });
      await client.flush();

      expect(mock.requests).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("permanently rejected (403)"),
      );

      client.destroy();
      mock.restore();
      errorSpy.mockRestore();
    });

    it("halves batch on 413 (payload too large)", async () => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      // First request: 413, then the two halved batches succeed.
      const mock = createMockServer([{ status: 413 }, { status: 202 }, { status: 202 }]);
      const client = newClient();

      // Track 4 events that together exceed the body limit.
      for (let i = 0; i < 4; i++) {
        client.track({ type: "$generation", session_id: `s${i}` });
      }

      // First flush gets 413, splits, and schedules retry via setTimeout(0).
      await client.flush();
      expect(mock.requests).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("batch too large, splitting"),
      );

      // Advance past the setTimeout(0) to trigger the split retry.
      await vi.advanceTimersByTimeAsync(1);
      expect(mock.requests.length).toBeGreaterThanOrEqual(2);

      client.destroy();
      mock.restore();
      warnSpy.mockRestore();
      vi.useRealTimers();
    });

    it("drops a single event that's too large on 413", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mock = createMockServer([{ status: 413 }]);
      const client = newClient();

      client.track({ type: "$generation", session_id: "s1" });
      await client.flush();

      expect(errorSpy).toHaveBeenCalledWith("[litmus] single event too large for ingest, dropped");

      client.destroy();
      mock.restore();
      errorSpy.mockRestore();
    });

    it("respects Retry-After header on 429", async () => {
      vi.useFakeTimers();
      // 429 with 5s retry-after, then success
      const mock = createMockServer([
        { status: 429, headers: { "Retry-After": "5" } },
        { status: 202 },
      ]);
      const client = newClient();

      client.track({ type: "$generation", session_id: "s1" });
      await client.flush();

      // First request should be the 429.
      await vi.advanceTimersByTimeAsync(0); // drain microtasks
      expect(mock.requests).toHaveLength(1);

      // Advance less than 5s, shouldn't have retried yet.
      await vi.advanceTimersByTimeAsync(4000);
      expect(mock.requests).toHaveLength(1);

      // Advance past 5s total, should retry.
      await vi.advanceTimersByTimeAsync(1500);
      expect(mock.requests).toHaveLength(2);

      client.destroy();
      mock.restore();
      vi.useRealTimers();
    });
  });

  describe("offline awareness", () => {
    it("skips flush when offline", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      // Simulate going offline by reaching into the client.
      // In real usage, the 'offline' event handler sets this.
      (client as unknown as { online: boolean }).online = false;

      client.track({ type: "$generation", session_id: "s1" });
      await client.flush();

      // No request made while offline.
      expect(mock.requests).toHaveLength(0);

      // Come back online.
      (client as unknown as { online: boolean }).online = true;
      await client.flush();

      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0].events).toHaveLength(1);

      client.destroy();
      mock.restore();
    });
  });

  describe("max queue size", () => {
    it("evicts oldest events when queue overflows", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const mock = createMockServer([]);
      const client = newClient({ maxQueueSize: 3 });

      // Track 5 events, only the last 3 should survive.
      client.track({ type: "$generation", session_id: "s1" });
      client.track({ type: "$copy", session_id: "s2" });
      client.track({ type: "$edit", session_id: "s3" });
      client.track({ type: "$accept", session_id: "s4" });
      client.track({ type: "$abandon", session_id: "s5" });

      await client.flush();

      // Only 3 events should have been sent.
      expect(mock.requests[0].events).toHaveLength(3);
      const types = mock.requests[0].events.map((e: CapturedEvent) => e.type);
      expect(types).toEqual(["$edit", "$accept", "$abandon"]);
      expect(warnSpy).toHaveBeenCalled();

      client.destroy();
      mock.restore();
      warnSpy.mockRestore();
    });
  });

  describe("timestamp at track time", () => {
    it("assigns timestamp at track() time, not flush() time", async () => {
      vi.useFakeTimers();
      const mock = createMockServer([]);
      const client = newClient();

      const trackTime = new Date();
      client.track({ type: "$generation", session_id: "s1" });

      // Advance time significantly. If timestamp were set at flush time,
      // it would be 10s in the future.
      await vi.advanceTimersByTimeAsync(10_000);

      await client.flush();

      const timestamp = new Date(mock.requests[0].events[0].timestamp);
      // Timestamp should be from track time (~trackTime), not flush time (~trackTime + 10s).
      expect(timestamp.getTime()).toBe(trackTime.getTime());

      client.destroy();
      vi.useRealTimers();
      mock.restore();
    });
  });

  describe("generation()", () => {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    it("returns an object with a UUID id", () => {
      const mock = createMockServer([]);
      const client = newClient();

      const result = client.generation("sess_1");

      expect(result).toHaveProperty("id");
      expect(result.id).toMatch(UUID_RE);

      client.destroy();
      mock.restore();
    });

    it("auto-tracks a generation event", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const result = client.generation("sess_1", { prompt_id: "v1" });
      await client.flush();

      expect(mock.requests).toHaveLength(1);
      const event = mock.requests[0].events[0];
      expect(event.type).toBe("$generation");
      expect(event.session_id).toBe("sess_1");
      expect(event.prompt_id).toBe("v1");
      expect(event.generation_id).toBe(result.id);

      client.destroy();
      mock.restore();
    });

    it("passes metadata through", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      client.generation("sess_1", { metadata: { model: "gpt-4" } });
      await client.flush();

      expect(mock.requests).toHaveLength(1);
      const event = mock.requests[0].events[0];
      expect(event.metadata).toEqual({ model: "gpt-4" });

      client.destroy();
      mock.restore();
    });

    it("returned id links subsequent events", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const gen = client.generation("sess_1");
      client.track({
        type: "$copy",
        session_id: "sess_1",
        generation_id: gen.id,
      });
      await client.flush();

      expect(mock.requests).toHaveLength(1);
      const events = mock.requests[0].events;
      expect(events).toHaveLength(2);
      expect(events[0].generation_id).toBe(gen.id);
      expect(events[1].generation_id).toBe(gen.id);

      client.destroy();
      mock.restore();
    });
  });

  describe("generation.event()", () => {
    it("emits $accept with correct generation_id and session_id", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const gen = client.generation("sess_1");
      gen.event("$accept");
      await client.flush();

      const events = mock.requests[0].events;
      expect(events).toHaveLength(2);
      expect(events[1].type).toBe("$accept");
      expect(events[1].session_id).toBe("sess_1");
      expect(events[1].generation_id).toBe(gen.id);

      client.destroy();
      mock.restore();
    });

    it("passes metadata through", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const gen = client.generation("sess_1");
      gen.event("$edit", { edit_distance: 0.42 });
      await client.flush();

      const editEvent = mock.requests[0].events[1];
      expect(editEvent.type).toBe("$edit");
      expect(editEvent.metadata).toEqual(expect.objectContaining({ edit_distance: 0.42 }));

      client.destroy();
      mock.restore();
    });

    it("works with any system event type", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const gen = client.generation("sess_1");
      gen.event("$share", { channel: "slack", edited_before_share: false });
      gen.event("$flag", { reason: "hallucination" });
      gen.event("$rate", { value: 4, scale: "5-star" });
      gen.event("$post_accept_edit", { edit_distance: 0.6, time_since_accept_ms: 300000 });
      await client.flush();

      const events = mock.requests[0].events;
      const types = events.map((e: CapturedEvent) => e.type);
      expect(types).toEqual(["$generation", "$share", "$flag", "$rate", "$post_accept_edit"]);

      client.destroy();
      mock.restore();
    });

    it("works with custom event types", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const gen = client.generation("sess_1");
      gen.event("thumbs_down", { reason: "wrong_tone" });
      await client.flush();

      const customEvent = mock.requests[0].events[1];
      expect(customEvent.type).toBe("thumbs_down");
      expect(customEvent.metadata).toEqual(expect.objectContaining({ reason: "wrong_tone" }));

      client.destroy();
      mock.restore();
    });

    it("chaining multiple signals on one generation", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const gen = client.generation("sess_1");
      gen.event("$view");
      gen.event("$edit", { edit_distance: 0.1 });
      gen.event("$accept");
      await client.flush();

      const events = mock.requests[0].events;
      expect(events).toHaveLength(4); // generation + view + edit + accept
      expect(events.map((e: CapturedEvent) => e.type)).toEqual([
        "$generation", "$view", "$edit", "$accept",
      ]);
      // All events share the same generation_id
      const genIds = events.map((e: CapturedEvent) => e.generation_id);
      expect(new Set(genIds).size).toBe(1);

      client.destroy();
      mock.restore();
    });

    it("carries user_id from generation opts to all subsequent events", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const gen = client.generation("sess_1", { user_id: "user_42" });
      gen.event("$accept");
      gen.event("$share", { channel: "email" });
      await client.flush();

      const events = mock.requests[0].events;
      for (const e of events) {
        expect(e.user_id).toBe("user_42");
      }

      client.destroy();
      mock.restore();
    });
  });

  describe("feature()", () => {
    it("creates a scoped feature with prompt_id defaulting to feature name", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const contentGen = client.feature("content_gen");
      const gen = contentGen.generation("sess_1");
      gen.event("$accept");
      await client.flush();

      const events = mock.requests[0].events;
      expect(events[0].prompt_id).toBe("content_gen");
      expect(events[1].prompt_id).toBe("content_gen");
      // Feature name is also in metadata
      expect(events[0].metadata).toEqual(expect.objectContaining({ feature: "content_gen" }));

      client.destroy();
      mock.restore();
    });

    it("carries model and user_id defaults through", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const topics = client.feature("topic_suggestions", {
        model: "claude-sonnet",
        user_id: "user_99",
      });
      const gen = topics.generation("sess_1");
      gen.event("$regenerate");
      await client.flush();

      const events = mock.requests[0].events;
      // user_id carried through
      for (const e of events) {
        expect(e.user_id).toBe("user_99");
      }
      // model is a wire-level field — goes top-level on the $generation event,
      // NOT duplicated into metadata. The ingest server writes it to the
      // events.model column; metadata stays for freeform props only.
      const genEvent = events.find((e: CapturedEvent) => e.type === "$generation")!;
      expect(genEvent.model).toBe("claude-sonnet");
      expect(genEvent.metadata).not.toHaveProperty("model");

      client.destroy();
      mock.restore();
    });

    it("generation-level user_id overrides feature-level", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const feat = client.feature("content_gen", { user_id: "default_user" });
      const gen = feat.generation("sess_1", { user_id: "specific_user" });
      gen.event("$accept");
      await client.flush();

      const events = mock.requests[0].events;
      for (const e of events) {
        expect(e.user_id).toBe("specific_user");
      }

      client.destroy();
      mock.restore();
    });

    it("feature.track() merges feature defaults", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const feat = client.feature("content_gen", { user_id: "u1" });
      feat.track({ type: "$abandon", session_id: "sess_1" });
      await client.flush();

      const event = mock.requests[0].events[0];
      expect(event.type).toBe("$abandon");
      expect(event.prompt_id).toBe("content_gen");
      expect(event.user_id).toBe("u1");
      expect(event.metadata).toEqual(expect.objectContaining({ feature: "content_gen" }));

      client.destroy();
      mock.restore();
    });

    it("two features track independently", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const contentGen = client.feature("content_gen", { model: "gpt-4o" });
      const topics = client.feature("topics", { model: "claude-sonnet" });

      const gen1 = contentGen.generation("sess_1");
      gen1.event("$accept");

      const gen2 = topics.generation("sess_1");
      gen2.event("$regenerate");
      gen2.event("$abandon");

      await client.flush();

      const events = mock.requests[0].events;
      expect(events).toHaveLength(5); // gen + accept + gen + regen + abandon

      // First feature events
      expect(events[0].prompt_id).toBe("content_gen");
      expect(events[1].prompt_id).toBe("content_gen");
      // Second feature events
      expect(events[2].prompt_id).toBe("topics");
      expect(events[3].prompt_id).toBe("topics");
      expect(events[4].prompt_id).toBe("topics");
      // Different generation IDs
      expect(events[0].generation_id).not.toBe(events[2].generation_id);

      client.destroy();
      mock.restore();
    });
  });

  describe("wire-level fields on every entry point", () => {
    // Regression guard for the v0.5.0 bug where Feature.generation() and
    // Feature.track() dropped wire fields or duplicated them into metadata.
    // Every public entry point must (a) surface wire fields at the top of
    // the event JSON and (b) NOT leak them into metadata alongside.
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

    function assertTopLevelNoLeak(event: CapturedEvent) {
      for (const [key, expected] of Object.entries(SAMPLE)) {
        expect(event[key as keyof CapturedEvent]).toBe(expected);
        expect(event.metadata).not.toHaveProperty(key);
      }
    }

    it("track() serializes wire fields at top level", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      client.track({ type: "$generation", session_id: "s1", ...SAMPLE });
      await client.flush();

      assertTopLevelNoLeak(mock.requests[0].events[0]);
      client.destroy();
      mock.restore();
    });

    it("generation() serializes wire fields at top level", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      client.generation("s1", { prompt_id: "chat", ...SAMPLE });
      await client.flush();

      const gen = mock.requests[0].events.find((e) => e.type === "$generation")!;
      assertTopLevelNoLeak(gen);
      client.destroy();
      mock.restore();
    });

    it("gen.event() serializes wire fields at top level", async () => {
      // Mid-stream $switch_model needs to carry new model + token deltas.
      const mock = createMockServer([]);
      const client = newClient();

      const gen = client.generation("s1", { prompt_id: "chat" });
      gen.event("$switch_model", { ...SAMPLE });
      await client.flush();

      const switchEvent = mock.requests[0].events.find((e) => e.type === "$switch_model")!;
      assertTopLevelNoLeak(switchEvent);
      client.destroy();
      mock.restore();
    });

    it("feature.generation() serializes per-call wire fields at top level", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const feat = client.feature("summarizer");
      feat.generation("s1", { ...SAMPLE });
      await client.flush();

      const gen = mock.requests[0].events.find((e) => e.type === "$generation")!;
      assertTopLevelNoLeak(gen);
      client.destroy();
      mock.restore();
    });

    it("feature.track() serializes wire fields at top level", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const feat = client.feature("summarizer");
      feat.track({ type: "$generation", session_id: "s1", ...SAMPLE });
      await client.flush();

      assertTopLevelNoLeak(mock.requests[0].events[0]);
      client.destroy();
      mock.restore();
    });

    it("feature defaults for model/provider go top-level, never into metadata", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const feat = client.feature("content_gen", { model: "gpt-4o", provider: "openai" });
      feat.generation("s1");
      await client.flush();

      const gen = mock.requests[0].events.find((e) => e.type === "$generation")!;
      expect(gen.model).toBe("gpt-4o");
      expect(gen.provider).toBe("openai");
      expect(gen.metadata).not.toHaveProperty("model");
      expect(gen.metadata).not.toHaveProperty("provider");
      client.destroy();
      mock.restore();
    });

    it("per-call model overrides feature default", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const feat = client.feature("chat", { model: "gpt-4o-mini" });
      feat.generation("s1", { model: "gpt-4o" });
      await client.flush();

      const gen = mock.requests[0].events.find((e) => e.type === "$generation")!;
      expect(gen.model).toBe("gpt-4o");
      client.destroy();
      mock.restore();
    });
  });

  describe("attach()", () => {
    it("returns a Generation handle without emitting $generation", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const gen = client.attach("backend-gen-uuid", "sess_1");
      gen.event("$accept");
      await client.flush();

      const events = mock.requests[0].events;
      // Only $accept, no $generation
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("$accept");
      expect(events[0].generation_id).toBe("backend-gen-uuid");
      expect(events[0].session_id).toBe("sess_1");

      client.destroy();
      mock.restore();
    });

    it("uses the provided generation_id", () => {
      const mock = createMockServer([]);
      const client = newClient();

      const gen = client.attach("my-backend-id", "sess_1");
      expect(gen.id).toBe("my-backend-id");

      client.destroy();
      mock.restore();
    });

    it("works with no opts at all", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const gen = client.attach("gen-abc", "sess_1");
      gen.event("$copy");
      await client.flush();

      const event = mock.requests[0].events[0];
      expect(event.generation_id).toBe("gen-abc");
      expect(event.session_id).toBe("sess_1");
      expect(event.user_id).toBeUndefined();

      client.destroy();
      mock.restore();
    });
  });

  describe("cross-SDK correlation", () => {
    it("all events share the same generation_id", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      // Backend creates generation (emits $generation with prompt context)
      const backendGen = client.generation("sess_1", {
        prompt_id: "content_gen",
        prompt_version: "v2.3",
        metadata: { model: "gpt-4o", latency_ms: 420 },
      });
      const generationId = backendGen.id;

      // Frontend attaches, records behavioral signals (no $generation)
      const frontendGen = client.attach(generationId, "sess_1");
      frontendGen.event("$accept");
      frontendGen.event("$edit", { edit_distance: 0.3 });
      frontendGen.event("$copy");

      await client.flush();

      const events = mock.requests[0].events;

      // Every event must share the same generation_id
      const genIds = new Set(events.map((e: CapturedEvent) => e.generation_id));
      expect(genIds.size).toBe(1);
      expect(genIds.has(generationId)).toBe(true);
    });

    it("$generation carries prompt context, behavioral events don't need to", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const backendGen = client.generation("sess_1", {
        prompt_id: "summarizer",
        prompt_version: "v3.1",
        metadata: { model: "claude-sonnet", token_count: 512 },
      });

      const frontendGen = client.attach(backendGen.id, "sess_1");
      frontendGen.event("$accept");

      await client.flush();

      const events = mock.requests[0].events;
      const genEvent = events.find((e: CapturedEvent) => e.type === "$generation")!;
      const acceptEvent = events.find((e: CapturedEvent) => e.type === "$accept")!;

      // Backend $generation has full prompt context
      expect(genEvent.prompt_id).toBe("summarizer");
      expect(genEvent.metadata).toEqual(expect.objectContaining({
        model: "claude-sonnet",
        token_count: 512,
      }));

      // Frontend behavioral event correlates via generation_id only
      expect(acceptEvent.prompt_id).toBeUndefined();
      expect(acceptEvent.generation_id).toBe(backendGen.id);

      client.destroy();
      mock.restore();
    });

    it("exactly one $generation event no matter how many attach() calls", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const gen = client.generation("sess_1", { prompt_id: "chat-v1" });

      // Multiple consumers attach to the same generation
      const handleA = client.attach(gen.id, "sess_1");
      const handleB = client.attach(gen.id, "sess_1");

      handleA.event("$view");
      handleB.event("$copy");
      handleA.event("$accept");

      await client.flush();

      const events = mock.requests[0].events;
      const genEvents = events.filter((e: CapturedEvent) => e.type === "$generation");
      expect(genEvents).toHaveLength(1);

      // All 4 events (1 gen + 3 behavioral) share the same id
      expect(events).toHaveLength(4);
      for (const e of events) {
        expect(e.generation_id).toBe(gen.id);
      }

      client.destroy();
      mock.restore();
    });

    it("session_id is consistent across generation and attach", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      const gen = client.generation("conversation-42", { prompt_id: "chat" });
      const frontend = client.attach(gen.id, "conversation-42");
      frontend.event("$accept");

      await client.flush();

      const events = mock.requests[0].events;
      const sessionIds = new Set(events.map((e: CapturedEvent) => e.session_id));
      expect(sessionIds.size).toBe(1);
      expect(sessionIds.has("conversation-42")).toBe(true);

      client.destroy();
      mock.restore();
    });
  });

  describe("request format", () => {
    it("sends correct headers and URL", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      client.track({ type: "$generation", session_id: "s1" });
      await client.flush();

      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

      expect(url).toBe("http://localhost:9999/v1/events");
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual(
        expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer ltm_pk_test_abc123",
        }),
      );

      client.destroy();
      mock.restore();
    });

    it("adds ISO 8601 timestamp to each event", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      client.track({ type: "$generation", session_id: "s1" });
      await client.flush();

      const timestamp = mock.requests[0].events[0].timestamp;
      // Should be a valid ISO 8601 string (parseable by Date).
      const parsed = new Date(timestamp);
      expect(parsed.toISOString()).toBe(timestamp);

      client.destroy();
      mock.restore();
    });

    it("sets keepalive: true on small payloads", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      client.track({ type: "$generation", session_id: "s1" });
      await client.flush();

      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.keepalive).toBe(true);

      client.destroy();
      mock.restore();
    });
  });
});
