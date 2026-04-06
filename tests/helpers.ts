// ---------------------------------------------------------------------------
// Real HTTP test server for integration tests.
//
// No mocks. The SDK sends actual HTTP requests to this server, and we
// capture every batch that arrives. Tests assert against the captured
// batches to verify the full event pipeline end-to-end.
//
// Usage:
//   const server = createTestServer();
//   const endpoint = await server.start();
//   // ... create LitmusClient with endpoint, do stuff ...
//   expect(server.allEvents).toHaveLength(2);
//   await server.stop();
// ---------------------------------------------------------------------------

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/** Shape of a single event as it arrives at the server. */
export interface CapturedEvent {
  type: string;
  session_id: string;
  user_id?: string;
  prompt_id?: string;
  prompt_version?: string;
  generation_id?: string;
  metadata?: Record<string, unknown>;
  id: string;
  timestamp: string;
}

/** One POST body received by the server. */
export interface CapturedBatch {
  events: CapturedEvent[];
}

/** What createTestServer returns. */
export interface TestServer {
  /** All captured batches in arrival order. */
  readonly batches: CapturedBatch[];
  /** Convenience: all events flattened across batches. */
  readonly allEvents: CapturedEvent[];
  /** The base URL (e.g. "http://127.0.0.1:12345"). Set after start(). */
  readonly endpoint: string;
  /** Change what status code the server returns for subsequent requests. */
  setStatus(code: number): void;
  /** Set response headers for subsequent requests. */
  setHeaders(headers: Record<string, string>): void;
  /** Start listening on a random port. Returns the base URL. */
  start(): Promise<string>;
  /** Stop the server. */
  stop(): Promise<void>;
  /** Clear all captured data and reset status/headers to defaults. */
  reset(): void;
}

export function createTestServer(): TestServer {
  const batches: CapturedBatch[] = [];
  let statusCode = 200;
  let responseHeaders: Record<string, string> = {};

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        if (parsed.events) {
          batches.push(parsed as CapturedBatch);
        }
      } catch {
        // Non-JSON request (e.g. sendBeacon with blob). Try to parse anyway.
      }

      for (const [key, value] of Object.entries(responseHeaders)) {
        res.setHeader(key, value);
      }
      res.writeHead(statusCode);
      res.end();
    });
  });

  let endpoint = "";

  return {
    get batches() {
      return batches;
    },
    get allEvents() {
      return batches.flatMap((b) => b.events);
    },
    get endpoint() {
      return endpoint;
    },

    setStatus(code: number) {
      statusCode = code;
    },
    setHeaders(headers: Record<string, string>) {
      responseHeaders = headers;
    },

    async start(): Promise<string> {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as { port: number };
          endpoint = `http://127.0.0.1:${addr.port}`;
          resolve(endpoint);
        });
      });
    },

    async stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },

    reset() {
      batches.length = 0;
      statusCode = 200;
      responseHeaders = {};
    },
  };
}
