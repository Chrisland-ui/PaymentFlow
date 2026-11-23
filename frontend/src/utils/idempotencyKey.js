/**
 * Idempotency key utilities for frontend payment requests.
 *
 * Keys are v4 UUIDs generated once per payment form session. The same key is
 * reused on every retry so the backend can deduplicate requests that arrive
 * multiple times due to double-clicks or network timeouts. The key must be
 * cleared only after a confirmed 2xx success response — never on error — so
 * that retries continue to carry the original key.
 *
 * See: docs/idempotency-payment-verification.md
 */

/**
 * Generate a new v4 UUID idempotency key.
 *
 * Uses the Web Crypto API (available in all modern browsers and Node.js ≥ 15)
 * so the output is cryptographically random and collision-resistant.
 *
 * @returns {string} A lowercase UUID v4 string, e.g. "550e8400-e29b-41d4-a716-446655440000".
 */
export function generateIdempotencyKey() {
  if (
    typeof globalThis !== "undefined" &&
    globalThis.crypto &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }

  // Fallback for environments without crypto.randomUUID (older browsers / Jest
  // with jsdom < 19). Uses getRandomValues to preserve cryptographic quality.
  if (
    typeof globalThis !== "undefined" &&
    globalThis.crypto &&
    typeof globalThis.crypto.getRandomValues === "function"
  ) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    // Set version (4) and variant (RFC 4122) bits.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Last-resort fallback (no secure random available). Not for production use.
  // Included only to avoid breaking server-side rendering in constrained envs.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
