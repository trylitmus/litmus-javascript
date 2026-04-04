// ---------------------------------------------------------------------------
// Consent manager — opt-in/opt-out/pending with localStorage persistence.
//
// Three consent states:
//   PENDING (-1): No explicit choice yet. Behavior controlled by defaultOptOut.
//   DENIED  (0):  User opted out. All tracking disabled.
//   GRANTED (1):  User opted in. Tracking enabled.
//
// Features:
//   - localStorage persistence (survives page refresh and tab close)
//   - Do Not Track (DNT) respect (navigator.doNotTrack)
//   - Pending state for GDPR-first flows (defaultOptOut + explicit optIn)
//
// Storage format:
//   localStorage key: __litmus_consent_<api_key_prefix>
//   value: "1" (granted) | "0" (denied) | absent (pending)
//
// All localStorage access is wrapped in try/catch because:
//   - localStorage might not exist (Node.js, SSR)
//   - localStorage might be disabled (private browsing in some browsers)
//   - localStorage might be full (5MB quota exceeded)
// ---------------------------------------------------------------------------

const STORAGE_KEY_PREFIX = "__litmus_consent";

export const ConsentStatus = {
  PENDING: -1,
  DENIED: 0,
  GRANTED: 1,
} as const;

export type ConsentStatusValue = typeof ConsentStatus[keyof typeof ConsentStatus];

export class ConsentManager {
  private status: ConsentStatusValue;
  private storageKey: string;
  private respectDnt: boolean;
  private defaultOptOut: boolean;

  constructor(apiKeyPrefix: string, defaultOptOut: boolean = false, respectDnt: boolean = true) {
    // Use the first 8 chars of the API key as a namespace so multiple
    // Litmus projects on the same domain don't collide.
    this.storageKey = `${STORAGE_KEY_PREFIX}_${apiKeyPrefix.slice(0, 8)}`;
    this.respectDnt = respectDnt;
    this.defaultOptOut = defaultOptOut;
    this.status = this.load();
  }

  /**
   * True if tracking should be disabled. Checked on every track() call.
   *
   * Returns true when:
   *   - Explicit denial (user called optOut())
   *   - DNT is set and respectDnt is enabled
   *   - Status is PENDING and defaultOptOut is true
   */
  isOptedOut(): boolean {
    if (this.status === ConsentStatus.DENIED) return true;
    if (this.respectDnt && this.isDnt()) return true;
    if (this.status === ConsentStatus.PENDING && this.defaultOptOut) return true;
    return false;
  }

  /** Explicit opt-in. Persists to localStorage. Overrides DNT. */
  optIn(): void {
    this.status = ConsentStatus.GRANTED;
    this.persist("1");
  }

  /** Explicit opt-out. Persists to localStorage. */
  optOut(): void {
    this.status = ConsentStatus.DENIED;
    this.persist("0");
  }

  /** Get the raw consent status without considering defaults or DNT. */
  getExplicitStatus(): "granted" | "denied" | "pending" {
    if (this.status === ConsentStatus.GRANTED) return "granted";
    if (this.status === ConsentStatus.DENIED) return "denied";
    return "pending";
  }

  /** Clear stored preference, returning to PENDING state. */
  reset(): void {
    this.status = ConsentStatus.PENDING;
    if (typeof localStorage !== "undefined") {
      try { localStorage.removeItem(this.storageKey); } catch { /* noop */ }
    }
  }

  /** Check browser Do Not Track signal. */
  private isDnt(): boolean {
    if (typeof navigator === "undefined") return false;
    // navigator.doNotTrack: standard (Chrome, Firefox)
    // navigator.msDoNotTrack: legacy IE
    // window.doNotTrack: legacy Safari
    const dnt = navigator.doNotTrack
      ?? (navigator as Record<string, unknown>)["msDoNotTrack"]
      ?? (typeof window !== "undefined" ? (window as Record<string, unknown>)["doNotTrack"] : undefined);
    return dnt === "1" || dnt === "yes" || dnt === true;
  }

  /** Load consent from localStorage. Returns PENDING if nothing stored. */
  private load(): ConsentStatusValue {
    if (typeof localStorage === "undefined" || typeof localStorage.getItem !== "function") return ConsentStatus.PENDING;
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored === "0") return ConsentStatus.DENIED;
      if (stored === "1") return ConsentStatus.GRANTED;
      return ConsentStatus.PENDING;
    } catch {
      return ConsentStatus.PENDING;
    }
  }

  /** Persist consent choice to localStorage. */
  private persist(value: "0" | "1"): void {
    if (typeof localStorage === "undefined" || typeof localStorage.setItem !== "function") return;
    try {
      localStorage.setItem(this.storageKey, value);
    } catch {
      // localStorage full or disabled. Consent is still held in memory.
    }
  }
}