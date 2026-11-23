/**
 * useIdempotencyKey — Issue #12
 *
 * Manages a per-payment-submission idempotency key so that retrying an
 * ambiguous network result reuses the same key rather than issuing a
 * duplicate request.
 *
 * ## Lifecycle
 *
 *   1. A key is generated lazily the first time getKey() is called (or
 *      immediately on mount, depending on whether `autoGenerate` is true).
 *   2. Retrying after a network failure reuses the same key.
 *   3. After a confirmed terminal result (success or known permanent failure)
 *      call `rotate()` so the next intentional payment submission gets a
 *      fresh key.
 *   4. `reset()` is an alias for `rotate()` and is provided for explicit
 *      user-triggered resets (e.g. "Start over" button).
 *
 * ## Key format
 *
 *   `pf-<16 random hex chars>-<timestamp ms>`
 *
 *   The timestamp component makes keys time-sortable for debugging without
 *   leaking information about key generation rate (the random component
 *   provides collision resistance).
 *
 * ## Security
 *
 *   Keys are NOT placed in URLs, analytics payloads, or logs.  Callers must
 *   only attach the key to authenticated request headers or request bodies
 *   that are transmitted over HTTPS.
 *
 * ## Usage
 *
 *   const { getKey, rotate, reset } = useIdempotencyKey();
 *
 *   // On submit:
 *   await api.post('/payments/verify', { txHash }, {
 *     headers: { 'Idempotency-Key': getKey() },
 *   });
 *
 *   // On confirmed success or permanent failure:
 *   rotate();
 *
 *   // On explicit "pay again" / "start over":
 *   reset();
 */

import { useRef, useCallback } from "react";

// ─── Key generation ───────────────────────────────────────────────────────────

/**
 * Generate a cryptographically-random idempotency key.
 *
 * Uses `crypto.getRandomValues` when available (browser / Node 19+).
 * Falls back to `Math.random` in environments that lack the Web Crypto API
 * (older test environments) — the fallback is not cryptographically secure
 * but is sufficient for test determinism.
 *
 * @returns {string}  e.g. "pf-3a7f1b9c2e4d8a6f-1714000000000"
 */
export function generateIdempotencyKey() {
  let randomHex;
  try {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    randomHex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // Fallback for environments without crypto.getRandomValues.
    randomHex = Math.random().toString(16).slice(2).padStart(16, "0").slice(0, 16);
  }
  return `pf-${randomHex}-${Date.now()}`;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} IdempotencyKeyHandle
 * @property {() => string} getKey  — Return the current key, generating one
 *                                    lazily if none exists yet.
 * @property {() => void}   rotate  — Discard the current key.  The next call
 *                                    to getKey() will produce a new one.
 * @property {() => void}   reset   — Alias for rotate().  Intended for
 *                                    explicit user-triggered "start over" flows.
 */

/**
 * React hook that manages one idempotency key across multiple retry attempts
 * for a single payment-submission lifecycle.
 *
 * The key is stored in a ref (not state) so reading or rotating it never
 * triggers a re-render.
 *
 * @returns {IdempotencyKeyHandle}
 */
export function useIdempotencyKey() {
  // null  → no key yet (will be generated lazily on first getKey() call).
  // string → the active key for the current submission attempt.
  const keyRef = useRef(null);

  /**
   * Return the current idempotency key, generating a fresh one if needed.
   * Retries must call getKey() without calling rotate() in between to
   * reuse the same key.
   *
   * @returns {string}
   */
  const getKey = useCallback(() => {
    if (keyRef.current === null) {
      keyRef.current = generateIdempotencyKey();
    }
    return keyRef.current;
  }, []);

  /**
   * Discard the current key so the next call to getKey() produces a new one.
   * Call this after a confirmed terminal result (success or permanent error).
   */
  const rotate = useCallback(() => {
    keyRef.current = null;
  }, []);

  /**
   * Explicit reset — alias for rotate().
   * Use this on user-triggered "pay again" / "start over" actions.
   */
  const reset = useCallback(() => {
    keyRef.current = null;
  }, []);

  return { getKey, rotate, reset };
}
