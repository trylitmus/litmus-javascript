// ---------------------------------------------------------------------------
// Client-side rate limiter — token bucket with continuous refill.
//
// Prevents runaway loops from flooding the buffer and hammering the ingest
// server. If a customer has a bug that calls track() in a render loop, this
// catches it before it becomes a problem.
//
// Classic token bucket with continuous fractional refill. 10 events/sec with
// 10x burst (100 tokens). Bucket state is
// persisted to localStorage so it survives refreshes. We keep it in-memory
// since the purpose is catching bugs, not enforcing billing.
//
// Algorithm: classic token bucket with continuous fractional refill.
//   - Bucket starts full at burstLimit tokens
//   - Each event consumes 1 token
//   - Tokens refill at eventsPerSecond per second, computed on-demand
//   - No timer/interval needed (pure math on elapsed time)
//
// The server-side rate limiter (apps/ingest GCRA at 3000 req/min per project)
// is the real enforcement. This is a courtesy to protect the user's browser.
// ---------------------------------------------------------------------------

/** Default: 10 events per second. */
const DEFAULT_EVENTS_PER_SECOND = 10;

/** Default burst: 10x the per-second rate. */
const DEFAULT_BURST_MULTIPLIER = 10;

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private eventsPerSecond: number;
  private burstLimit: number;
  private warned: boolean = false;

  constructor(eventsPerSecond?: number, burstLimit?: number) {
    this.eventsPerSecond = eventsPerSecond ?? DEFAULT_EVENTS_PER_SECOND;
    this.burstLimit = burstLimit ?? this.eventsPerSecond * DEFAULT_BURST_MULTIPLIER;
    // Bucket starts full - no warmup penalty.
    this.tokens = this.burstLimit;
    this.lastRefill = Date.now();
  }

  /**
   * Check if the next event should be dropped due to rate limiting.
   * If not limited, consumes 1 token and returns false.
   * If limited, returns true (caller should drop the event).
   */
  isRateLimited(): boolean {
    this.refill();

    if (this.tokens < 1) {
      // Log once per burst of rate limiting, not on every dropped event.
      if (!this.warned) {
        this.warned = true;
        console.warn("[litmus] client rate limit reached, events are being dropped. " +
          "This usually means track() is being called in a tight loop (e.g. render cycle).");
      }
      return true;
    }

    this.tokens--;
    // Reset warning flag when tokens recover above 50% so we warn again
    // on the next burst.
    if (this.warned && this.tokens > this.burstLimit / 2) {
      this.warned = false;
    }
    return false;
  }

  /** Refill tokens based on elapsed time since last refill. */
  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(this.burstLimit, this.tokens + elapsedSeconds * this.eventsPerSecond);
  }
}
