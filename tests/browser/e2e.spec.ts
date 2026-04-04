// ---------------------------------------------------------------------------
// Playwright e2e test
//
// This test loads the built SDK bundle in an actual browser and verifies
// the full pipeline: SDK → fetch → server. Tests browser-specific behavior
// that jsdom can't replicate: sendBeacon on navigation, real page lifecycle
// events, real DOM event listeners for activity detection.
//
// Prerequisites: pnpm run build (SDK must be compiled to dist/)
// ---------------------------------------------------------------------------

import { test, expect } from "@playwright/test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Test server: serves both the SDK bundle and the API endpoint.
// ---------------------------------------------------------------------------

interface CapturedEvent {
  type: string;
  session_id: string;
  generation_id?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface CapturedBatch {
  events: CapturedEvent[];
}

let server: ReturnType<typeof createServer>;
let port: number;
const batches: CapturedBatch[] = [];

// Resolve paths relative to the SDK package root.
const SDK_ROOT = resolve(import.meta.dirname, "../..");
const SDK_BUNDLE = readFileSync(resolve(SDK_ROOT, "dist/index.js"), "utf-8");

// Build an HTML page that loads the SDK inline (avoids ESM import issues in test pages).
// We assign exports to window.__litmus so Playwright's evaluate() can use them.
const TEST_PAGE = `<!DOCTYPE html>
<html>
<head>
  <script type="module">
    // The SDK bundle is ESM. We import it inline and expose on window.
    ${SDK_BUNDLE}

    // Re-export everything Playwright needs.
    window.__LitmusClient = LitmusClient;
    window.__Generation = Generation;
    window.__ready = true;
  </script>
</head>
<body>
  <h1>Litmus SDK E2E Test Page</h1>
  <div id="output">AI generated text goes here</div>
</body>
</html>`;

test.beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, `http://localhost`);

    // Serve the test page at /.
    if (url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html",
        // CORS headers for fetch from the page.
        "Access-Control-Allow-Origin": "*",
      });
      res.end(TEST_PAGE);
      return;
    }

    // Handle CORS preflight.
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    // Capture event batches at /v1/events.
    if (url.pathname === "/v1/events") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.events) {
            batches.push(parsed as CapturedBatch);
          }
        } catch {
          // sendBeacon might send a Blob — try to parse it anyway.
        }
        res.writeHead(200, { "Access-Control-Allow-Origin": "*" });
        res.end();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test.beforeEach(() => {
  batches.length = 0;
});

// ---------------------------------------------------------------------------
// Helper: all events across all batches.
// ---------------------------------------------------------------------------

function allEvents(): CapturedEvent[] {
  return batches.flatMap(b => b.events);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("SDK loads and sends events from a real browser", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${port}/`);

  // Wait for the SDK to load.
  await page.waitForFunction(() => (window as unknown as Record<string, unknown>).__ready === true);

  // Create a client and generation, track an event, flush.
  await page.evaluate(async (endpoint: string) => {
    const Client = (window as unknown as Record<string, unknown>).__LitmusClient as typeof import("../../src/index.js").LitmusClient;

    const litmus = new (Client as unknown as new (cfg: Record<string, unknown>) => InstanceType<typeof import("../../src/index.js").LitmusClient>)({
      endpoint,
      apiKey: "ltm_pk_test_browser",
      flushInterval: 999_999,
      disableAutoAbandon: true,
    });

    const gen = litmus.generation("browser_sess_1", {
      prompt_id: "chat",
      prompt_version: "v1.0",
    });
    gen.event("$accept");
    gen.edit({ before: "Hello world", after: "Hello, world!" });

    await litmus.flush();
  }, `http://127.0.0.1:${port}`);

  // Give the server a moment to receive the request.
  await page.waitForTimeout(500);

  // Verify the server received events from the real browser.
  const events = allEvents();
  expect(events.length).toBeGreaterThanOrEqual(3); // $generation + $accept + $edit

  const types = events.map(e => e.type);
  expect(types).toContain("$generation");
  expect(types).toContain("$accept");
  expect(types).toContain("$edit");

  // Verify $edit has before/after.
  const editEvent = events.find(e => e.type === "$edit");
  expect(editEvent?.metadata).toMatchObject({
    before: "Hello world",
    after: "Hello, world!",
  });
});

test("sendBeacon fires on page navigation", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => (window as unknown as Record<string, unknown>).__ready === true);

  // Create a client with events in the buffer but DON'T flush.
  await page.evaluate((endpoint: string) => {
    const Client = (window as unknown as Record<string, unknown>).__LitmusClient as new (cfg: Record<string, unknown>) => Record<string, unknown>;

    const litmus = new Client({
      endpoint,
      apiKey: "ltm_pk_test_beacon",
      flushInterval: 999_999,
      disableAutoAbandon: true,
    });

    (litmus as Record<string, Function>).generation("beacon_sess_1", {
      prompt_id: "beacon_test",
    });

    // Store reference so it doesn't get GC'd before navigation.
    (window as unknown as Record<string, unknown>).__litmus = litmus;
  }, `http://127.0.0.1:${port}`);

  // Navigate away — should trigger pagehide → sendBeacon.
  await page.goto("about:blank");

  // Give the server time to receive the beacon.
  await page.waitForTimeout(1000);

  // The $generation event should have been sent via sendBeacon.
  const events = allEvents();
  const beaconEvents = events.filter(e => e.session_id === "beacon_sess_1");
  expect(beaconEvents.length).toBeGreaterThanOrEqual(1);
  expect(beaconEvents[0].type).toBe("$generation");
});

test("auto-abandon fires in real browser after inactivity", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => (window as unknown as Record<string, unknown>).__ready === true);

  // Create a client with a very short abandon threshold (2 seconds for fast test).
  await page.evaluate((endpoint: string) => {
    const Client = (window as unknown as Record<string, unknown>).__LitmusClient as new (cfg: Record<string, unknown>) => Record<string, unknown>;

    const litmus = new Client({
      endpoint,
      apiKey: "ltm_pk_test_abandon_browser",
      flushInterval: 999_999,
      disableAutoAbandon: false,
      abandonThreshold: 2000, // 2 seconds
    });

    (litmus as Record<string, Function>).generation("abandon_sess_1", {
      prompt_id: "abandon_test",
    });

    (window as unknown as Record<string, unknown>).__litmus = litmus;
  }, `http://127.0.0.1:${port}`);

  // Wait for the abandon threshold + idle check interval (2s + 10s buffer).
  // The idle check runs every 10 seconds, so we need to wait for at least one check.
  await page.waitForTimeout(13_000);

  // Manually flush to send the $abandon event.
  await page.evaluate(async () => {
    const litmus = (window as unknown as Record<string, unknown>).__litmus as Record<string, Function>;
    await litmus.flush();
  });

  await page.waitForTimeout(500);

  const events = allEvents();
  const abandons = events.filter(e => e.type === "$abandon" && e.session_id === "abandon_sess_1");
  expect(abandons.length).toBeGreaterThanOrEqual(1);
  expect(abandons[0].metadata).toMatchObject({ auto: true });
});
