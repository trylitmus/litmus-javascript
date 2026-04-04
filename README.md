# @trylitmus/sdk

TypeScript SDK for [Litmus](https://trylitmus.com) — implicit evals for AI products.

## Install

```bash
pnpm add @trylitmus/sdk
```

## Quick start

```typescript
import { LitmusClient } from "@trylitmus/sdk";

const litmus = new LitmusClient({
  apiKey: "ltm_pk_live_...",
});

// Track a generation and user signals
const gen = litmus.generation("session-123", { promptId: "content_gen" });
gen.event("$accept");
gen.event("$edit", { edit_distance: 0.3 });
gen.event("$share", { channel: "slack" });

// Custom events work too
gen.event("my_custom_signal", { score: 0.9 });

// Flush before teardown
await litmus.flush();
litmus.destroy();
```

## Features

A `Feature` scopes defaults so you don't repeat yourself:

```typescript
const summarizer = litmus.feature("summarizer", { model: "gpt-4o" });
const gen = summarizer.generation("session-123");
gen.event("$accept"); // prompt_id, model, and feature name attached automatically
```

## Cross-SDK flow

When the backend creates the generation and the frontend records signals:

```typescript
// Frontend attaches to a generation_id created by the backend
const gen = litmus.attach("backend-gen-uuid", "session-123");
gen.event("$accept");
gen.event("$edit", { edit_distance: 0.4 });
```

## Event types

All system events (`$accept`, `$edit`, `$copy`, etc.) get full autocomplete via the `SystemEvent` type. Custom event strings are accepted too.

## How it works

Events are buffered in memory and flushed to the Litmus ingest API every 5 seconds or when 50 events accumulate (both configurable). The SDK uses `fetch` with `keepalive` for normal flushes and `navigator.sendBeacon` on page unload so events aren't lost during navigation.

Transient failures are retried with exponential backoff and jitter. The SDK respects `Retry-After` headers and automatically splits oversized payloads on 413.

Zero runtime dependencies.
