/**
 * featureFlags.js — Issue #11
 *
 * A small feature-flag adapter that supports:
 *   1. Build-time defaults via NEXT_PUBLIC_FEATURE_* environment variables.
 *   2. Runtime server-provided overrides fetched from /api/feature-flags.
 *   3. A safe disabled state — unknown flags always resolve to `false`.
 *
 * ## Usage
 *
 *   import { isEnabled, loadServerFlags } from '../config/featureFlags';
 *
 *   // Read a flag (uses build-time default until overrides are loaded):
 *   if (isEnabled('paymentPlans')) { ... }
 *
 *   // In _app.jsx — load server overrides once on startup:
 *   await loadServerFlags();
 *
 * ## Flag names (payment capabilities)
 *
 *   paymentPlans         — installment / payment-plan UI
 *   feeAdjustments       — fee-adjustment rule editor
 *   disputes             — dispute-filing flow
 *   refunds              — refund request flow
 *   multiAsset           — non-XLM asset selection in payment form
 *   paymentVerification  — manual transaction-hash verification panel
 *   bulkStudentImport    — CSV bulk-import button
 *   sourceValidation     — source-validation rules page
 *
 * ## Adding a new flag
 *
 *   1. Add a NEXT_PUBLIC_FEATURE_<NAME>=true/false entry to .env.local.example.
 *   2. Add an entry to BUILD_TIME_DEFAULTS below (default: false).
 *   3. The server can override it by returning { "<name>": true|false } from
 *      GET /api/feature-flags.
 */

// ─── Build-time defaults ──────────────────────────────────────────────────────
// These are evaluated once at module load time from process.env.
// All flags default to false (disabled) unless explicitly enabled.

/**
 * Parse a NEXT_PUBLIC_FEATURE_* env var to a boolean.
 * Anything other than the string "true" (case-insensitive) is treated as false.
 * @param {string|undefined} envValue
 * @returns {boolean}
 */
function parseEnvFlag(envValue) {
  return typeof envValue === "string" && envValue.trim().toLowerCase() === "true";
}

const BUILD_TIME_DEFAULTS = {
  paymentPlans:        parseEnvFlag(process.env.NEXT_PUBLIC_FEATURE_PAYMENT_PLANS),
  feeAdjustments:      parseEnvFlag(process.env.NEXT_PUBLIC_FEATURE_FEE_ADJUSTMENTS),
  disputes:            parseEnvFlag(process.env.NEXT_PUBLIC_FEATURE_DISPUTES),
  refunds:             parseEnvFlag(process.env.NEXT_PUBLIC_FEATURE_REFUNDS),
  multiAsset:          parseEnvFlag(process.env.NEXT_PUBLIC_FEATURE_MULTI_ASSET),
  paymentVerification: parseEnvFlag(process.env.NEXT_PUBLIC_FEATURE_PAYMENT_VERIFICATION),
  bulkStudentImport:   parseEnvFlag(process.env.NEXT_PUBLIC_FEATURE_BULK_STUDENT_IMPORT),
  sourceValidation:    parseEnvFlag(process.env.NEXT_PUBLIC_FEATURE_SOURCE_VALIDATION),
};

// ─── Runtime state ────────────────────────────────────────────────────────────
// Server overrides are merged in after loadServerFlags() resolves.
// Starts as an empty object; only the keys returned by the server are applied.

/** @type {Record<string, boolean>} */
let _serverOverrides = {};

/** @type {boolean} */
let _overridesLoaded = false;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return the current resolved value of a named feature flag.
 *
 * Resolution order (first match wins):
 *   1. Server override (if loadServerFlags() has been called and returned a value for this flag).
 *   2. Build-time default (NEXT_PUBLIC_FEATURE_* env var).
 *   3. `false` — safe disabled state for any unknown flag name.
 *
 * @param {string} flagName
 * @returns {boolean}
 */
export function isEnabled(flagName) {
  if (typeof flagName !== "string" || flagName.trim() === "") return false;

  // Server overrides take precedence.
  if (_overridesLoaded && Object.prototype.hasOwnProperty.call(_serverOverrides, flagName)) {
    return Boolean(_serverOverrides[flagName]);
  }

  // Fall back to the build-time default.
  if (Object.prototype.hasOwnProperty.call(BUILD_TIME_DEFAULTS, flagName)) {
    return Boolean(BUILD_TIME_DEFAULTS[flagName]);
  }

  // Unknown flag — safe fallback.
  return false;
}

/**
 * Return an immutable snapshot of all currently resolved flag values.
 * Useful for logging or debugging; do not make control-flow decisions based
 * on the returned object directly — use isEnabled() instead.
 *
 * @returns {Readonly<Record<string, boolean>>}
 */
export function getAllFlags() {
  const resolved = { ...BUILD_TIME_DEFAULTS };
  if (_overridesLoaded) {
    for (const [key, value] of Object.entries(_serverOverrides)) {
      // Only accept boolean values from server overrides; drop any other type.
      if (typeof value === "boolean") {
        resolved[key] = value;
      }
    }
  }
  return Object.freeze(resolved);
}

/**
 * Fetch server-provided flag overrides from GET /api/feature-flags and merge
 * them into the runtime state.
 *
 * - Safe to call multiple times; subsequent calls refresh the overrides.
 * - Non-boolean values from the server response are silently ignored.
 * - Network or parse errors are swallowed so the app continues with
 *   build-time defaults (fail-open to the configured defaults).
 *
 * @param {object}  [options]
 * @param {string}  [options.apiUrl]  Base API URL (defaults to NEXT_PUBLIC_API_URL).
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<void>}
 */
export async function loadServerFlags({ apiUrl, signal } = {}) {
  // No-op on the server side (Next.js SSR) — flags are only useful client-side
  // where capability gating controls interactive UI elements.
  if (typeof window === "undefined") return;

  const base = apiUrl || process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api";
  // Ensure the endpoint path doesn't double-slash if base already ends with /api
  const url = base.replace(/\/+$/, "") + "/feature-flags";

  try {
    const res = await fetch(url, {
      credentials: "include",
      signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      // Non-2xx → keep build-time defaults; mark overrides as loaded (empty).
      _serverOverrides = {};
      _overridesLoaded = true;
      return;
    }
    const json = await res.json();

    if (json && typeof json === "object" && !Array.isArray(json)) {
      const safe = {};
      for (const [key, value] of Object.entries(json)) {
        // Only accept boolean values — drop numbers, strings, objects, etc.
        if (typeof value === "boolean") {
          safe[key] = value;
        }
      }
      _serverOverrides = safe;
    } else {
      _serverOverrides = {};
    }
    _overridesLoaded = true;
  } catch {
    // Swallow network / parse / abort errors.
    // _overridesLoaded stays false so build-time defaults remain in effect.
  }
}

/**
 * Replace the current server overrides with the provided object.
 * Primarily intended for tests — do not call in production code.
 *
 * @param {Record<string, boolean>} overrides
 * @param {boolean} [markLoaded=true]
 */
export function _setServerOverrides(overrides, markLoaded = true) {
  _serverOverrides = { ...overrides };
  _overridesLoaded = markLoaded;
}

/**
 * Reset all server overrides and mark overrides as not loaded.
 * Primarily intended for tests — do not call in production code.
 */
export function _resetFlags() {
  _serverOverrides = {};
  _overridesLoaded = false;
}
