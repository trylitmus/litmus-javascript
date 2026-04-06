// ---------------------------------------------------------------------------
// Queue persistence — localStorage-backed event buffer.
//
// Saves the event buffer to localStorage so events survive page refreshes,
// tab closes, and browser restarts. On the next page load, the constructor
// loads persisted events back into the buffer. The server deduplicates on
// event ID if any were already sent.
//
// Why localStorage instead of sessionStorage:
//   - Survives tab close (sessionStorage is cleared when the tab closes)
//   - Shared across tabs on the same origin (if two tabs are open, events
//     from a crashed tab can be recovered by the other)
//   - Events have unique IDs, so re-sending is harmless (server deduplicates)
//
// When we persist:
//   - After each successful flush (buffer state is now smaller)
//   - On visibilitychange → hidden (tab might get killed while backgrounded)
//   - On pagehide/unload (page closing)
//
// Some analytics SDKs persist the full queue on every operation.
// We persist at lifecycle boundaries to avoid localStorage I/O on every
// track() call, since events flush every 5 seconds anyway.
// ---------------------------------------------------------------------------

import type { BufferedEvent } from "./types.js";

const KEY_PREFIX = "__litmus_queue";

export class QueueStore {
  private key: string;

  constructor(apiKeyPrefix: string) {
    this.key = `${KEY_PREFIX}_${apiKeyPrefix.slice(0, 8)}`;
  }

  /** Write the current buffer to localStorage. Overwrites previous state. */
  save(events: BufferedEvent[]): void {
    if (typeof localStorage === "undefined" || typeof localStorage.setItem !== "function") return;
    try {
      if (events.length === 0) {
        localStorage.removeItem(this.key);
      } else {
        localStorage.setItem(this.key, JSON.stringify(events));
      }
    } catch {
      // localStorage full or disabled.
    }
  }

  /** Load persisted events from localStorage. Returns empty array on failure. */
  load(): BufferedEvent[] {
    if (typeof localStorage === "undefined" || typeof localStorage.getItem !== "function") return [];
    try {
      const stored = localStorage.getItem(this.key);
      if (!stored) return [];
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) return [];
      // Clear after loading so we don't re-load stale events if the app
      // creates multiple clients or crashes during flush.
      localStorage.removeItem(this.key);
      return parsed as BufferedEvent[];
    } catch {
      return [];
    }
  }
}
