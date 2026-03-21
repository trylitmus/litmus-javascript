import { describe, it, expect, vi, afterEach } from "vitest";
import { LitmusClient } from "../src";
import type { TrackEvent } from "../src";

// Captures request bodies sent to the mock server.
interface CapturedRequest {
  events: Array<{ id: string; type: string; session_id: string; timestamp: string }>;
}

function createMockServer(responses: Array<{ status: number }>) {
  const requests: CapturedRequest[] = [];
  let callIndex = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as CapturedRequest;
    requests.push(body);

    const response = responses[callIndex] ?? { status: 202 };
    callIndex++;

    return new Response(JSON.stringify({ accepted: body.events.length }), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
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

function newClient(overrides: Partial<{ flushInterval: number; maxBatchSize: number }> = {}) {
  return new LitmusClient({
    endpoint: "http://localhost:9999",
    apiKey: "ltm_pk_test_abc123",
    flushInterval: 60000, // large interval so we control flushes manually
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
        { type: "generation", session_id: "sess_1" },
        { type: "copy", session_id: "sess_1" },
        { type: "regenerate", session_id: "sess_2" },
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
        expect(id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
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

      client.track({ type: "generation", session_id: "s1" });
      client.track({ type: "generation", session_id: "s1" });
      client.track({ type: "copy", session_id: "s2" });

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

      client.track({ type: "generation", session_id: "s1" });
      client.track({ type: "copy", session_id: "s1" });

      // Not yet at threshold.
      expect(mock.requests).toHaveLength(0);

      // This should trigger auto-flush.
      client.track({ type: "edit", session_id: "s1" });

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

      client.track({ type: "generation", session_id: "s1" });
      client.track({ type: "copy", session_id: "s1" });

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

      client.track({ type: "generation", session_id: "s1" });
      client.track({ type: "copy", session_id: "s1" });

      // Flush fails.
      await client.flush();
      throwing.restore();

      // Track more events after the failure.
      const mock = createMockServer([]);
      client.track({ type: "edit", session_id: "s1" });

      await client.flush();

      // Original events should come before the new one.
      const types = mock.requests[0].events.map((e) => e.type);
      expect(types).toEqual(["generation", "copy", "edit"]);

      client.destroy();
      mock.restore();
    });
  });

  describe("destroy", () => {
    it("clears the interval timer", () => {
      const mock = createMockServer([]);
      const client = newClient({ flushInterval: 50 });

      client.track({ type: "generation", session_id: "s1" });
      client.destroy();

      // After destroy, no more automatic flushes should fire.
      // The destroy() call itself triggers one flush.
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
  });

  describe("request format", () => {
    it("sends correct headers and URL", async () => {
      const mock = createMockServer([]);
      const client = newClient();

      client.track({ type: "generation", session_id: "s1" });
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

      client.track({ type: "generation", session_id: "s1" });
      await client.flush();

      const timestamp = mock.requests[0].events[0].timestamp;
      // Should be a valid ISO 8601 string (parseable by Date).
      const parsed = new Date(timestamp);
      expect(parsed.toISOString()).toBe(timestamp);

      client.destroy();
      mock.restore();
    });
  });
});
