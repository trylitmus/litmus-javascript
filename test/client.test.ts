import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LitmusClient } from "../src/client.js";
import type { TrackEvent } from "../src/client.js";

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

describe("LitmusClient", () => {
  let client: LitmusClient;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("event ID stability across retries", () => {
    it("retries send the exact same event IDs", async () => {
      // First flush fails (500), second succeeds (202).
      const mock = createMockServer([{ status: 500 }, { status: 202 }]);

      client = new LitmusClient({
        endpoint: "http://localhost:9999",
        apiKey: "ltm_pk_test_abc123",
        flushInterval: 60000, // large interval so we control flushes manually
      });

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

    it("each tracked event gets a unique ID", () => {
      const mock = createMockServer([]);
      client = new LitmusClient({
        endpoint: "http://localhost:9999",
        apiKey: "ltm_pk_test_abc123",
        flushInterval: 60000,
      });

      client.track({ type: "generation", session_id: "s1" });
      client.track({ type: "generation", session_id: "s1" });
      client.track({ type: "copy", session_id: "s2" });

      // Flush to capture the IDs.
      client.flush();

      const ids = mock.requests[0].events.map((e) => e.id);
      const unique = new Set(ids);
      expect(unique.size).toBe(3);

      client.destroy();
      mock.restore();
    });
  });
});
