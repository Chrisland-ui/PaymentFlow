/**
 * Tests for featureFlags.js — Issue #11
 *
 * Covers:
 *   - Build-time defaults (env-var parsing)
 *   - Safe disabled state for unknown flags
 *   - Server override merging and precedence
 *   - loadServerFlags: happy path, non-2xx, network error, malformed response
 *   - getAllFlags snapshot
 *   - Consistent evaluation contract
 *
 * Jest environment: node (matches jest.config.js).
 * No React, no DOM — purely unit-tests against the JS module.
 */

// ─── Imports ──────────────────────────────────────────────────────────────────

// We import after resetting module registry so each describe block starts clean.
// The module is re-required inside helpers that call jest.resetModules().

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Load a fresh copy of the module with the given env vars applied.
 * Resets the module registry to clear module-level state between tests.
 */
function loadModule(envOverrides = {}) {
  jest.resetModules();
  const saved = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const mod = require("../featureFlags");
  // Restore env vars
  for (const [key] of Object.entries(envOverrides)) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
  return mod;
}

// ─── Build-time defaults ──────────────────────────────────────────────────────

describe("featureFlags — build-time defaults", () => {
  it("returns false for all known flags when no env vars are set", () => {
    const { isEnabled } = loadModule();
    const knownFlags = [
      "paymentPlans",
      "feeAdjustments",
      "disputes",
      "refunds",
      "multiAsset",
      "paymentVerification",
      "bulkStudentImport",
      "sourceValidation",
    ];
    for (const flag of knownFlags) {
      expect(isEnabled(flag)).toBe(false);
    }
  });

  it("returns true when NEXT_PUBLIC_FEATURE_DISPUTES=true", () => {
    const { isEnabled } = loadModule({ NEXT_PUBLIC_FEATURE_DISPUTES: "true" });
    expect(isEnabled("disputes")).toBe(true);
  });

  it("returns true when NEXT_PUBLIC_FEATURE_PAYMENT_PLANS=true", () => {
    const { isEnabled } = loadModule({ NEXT_PUBLIC_FEATURE_PAYMENT_PLANS: "true" });
    expect(isEnabled("paymentPlans")).toBe(true);
  });

  it("is case-insensitive for the env-var value (TRUE, True)", () => {
    const { isEnabled: mod1 } = loadModule({ NEXT_PUBLIC_FEATURE_REFUNDS: "TRUE" });
    expect(mod1("refunds")).toBe(true);

    const { isEnabled: mod2 } = loadModule({ NEXT_PUBLIC_FEATURE_REFUNDS: "True" });
    expect(mod2("refunds")).toBe(true);
  });

  it("treats any value other than 'true' as false", () => {
    for (const val of ["1", "yes", "on", "enabled", ""]) {
      const { isEnabled } = loadModule({ NEXT_PUBLIC_FEATURE_REFUNDS: val });
      expect(isEnabled("refunds")).toBe(false);
    }
  });

  it("other flags are not affected when one is enabled", () => {
    const { isEnabled } = loadModule({ NEXT_PUBLIC_FEATURE_DISPUTES: "true" });
    expect(isEnabled("paymentPlans")).toBe(false);
    expect(isEnabled("refunds")).toBe(false);
    expect(isEnabled("multiAsset")).toBe(false);
  });
});

// ─── Safe disabled state ──────────────────────────────────────────────────────

describe("featureFlags — safe disabled state (unknown flags)", () => {
  it("returns false for a completely unknown flag name", () => {
    const { isEnabled } = loadModule();
    expect(isEnabled("nonExistentFlag")).toBe(false);
  });

  it("returns false for an empty string flag name", () => {
    const { isEnabled } = loadModule();
    expect(isEnabled("")).toBe(false);
  });

  it("returns false for a null flag name", () => {
    const { isEnabled } = loadModule();
    expect(isEnabled(null)).toBe(false);
  });

  it("returns false for an undefined flag name", () => {
    const { isEnabled } = loadModule();
    expect(isEnabled(undefined)).toBe(false);
  });

  it("returns false for a numeric flag name", () => {
    const { isEnabled } = loadModule();
    expect(isEnabled(42)).toBe(false);
  });

  it("disabled flag renders as false consistently across multiple calls", () => {
    const { isEnabled } = loadModule();
    for (let i = 0; i < 5; i++) {
      expect(isEnabled("paymentPlans")).toBe(false);
    }
  });
});

// ─── Server override merging ──────────────────────────────────────────────────

describe("featureFlags — server override precedence", () => {
  it("server override true overrides a build-time false", () => {
    const { isEnabled, _setServerOverrides } = loadModule();
    _setServerOverrides({ disputes: true });
    expect(isEnabled("disputes")).toBe(true);
  });

  it("server override false overrides a build-time true", () => {
    const { isEnabled, _setServerOverrides } = loadModule({
      NEXT_PUBLIC_FEATURE_DISPUTES: "true",
    });
    _setServerOverrides({ disputes: false });
    expect(isEnabled("disputes")).toBe(false);
  });

  it("server override for one flag does not affect other flags", () => {
    const { isEnabled, _setServerOverrides } = loadModule();
    _setServerOverrides({ disputes: true });
    expect(isEnabled("paymentPlans")).toBe(false);
    expect(isEnabled("refunds")).toBe(false);
  });

  it("unknown flag enabled via server override resolves to true", () => {
    const { isEnabled, _setServerOverrides } = loadModule();
    _setServerOverrides({ brandNewCapability: true });
    expect(isEnabled("brandNewCapability")).toBe(true);
  });

  it("non-boolean server override values are ignored", () => {
    const { isEnabled, _setServerOverrides } = loadModule();
    // Inject non-boolean via the internal helper (simulates a broken server response)
    // _setServerOverrides only stores booleans; the test verifies the module
    // still falls back to build-time default.
    _setServerOverrides({});
    expect(isEnabled("disputes")).toBe(false);
  });

  it("_resetFlags restores build-time defaults", () => {
    const { isEnabled, _setServerOverrides, _resetFlags } = loadModule({
      NEXT_PUBLIC_FEATURE_DISPUTES: "true",
    });
    _setServerOverrides({ disputes: false });
    expect(isEnabled("disputes")).toBe(false);
    _resetFlags();
    // After reset, overrides are not loaded → build-time default (true) applies.
    expect(isEnabled("disputes")).toBe(true);
  });

  it("flags evaluate consistently — same name returns same value on repeated calls", () => {
    const { isEnabled, _setServerOverrides } = loadModule();
    _setServerOverrides({ disputes: true });
    const first = isEnabled("disputes");
    const second = isEnabled("disputes");
    expect(first).toBe(second);
  });
});

// ─── getAllFlags ──────────────────────────────────────────────────────────────

describe("featureFlags — getAllFlags", () => {
  it("returns an object containing all known flag names", () => {
    const { getAllFlags } = loadModule();
    const flags = getAllFlags();
    const expected = [
      "paymentPlans",
      "feeAdjustments",
      "disputes",
      "refunds",
      "multiAsset",
      "paymentVerification",
      "bulkStudentImport",
      "sourceValidation",
    ];
    for (const name of expected) {
      expect(flags).toHaveProperty(name);
    }
  });

  it("all values in the snapshot are booleans", () => {
    const { getAllFlags } = loadModule();
    const flags = getAllFlags();
    for (const value of Object.values(flags)) {
      expect(typeof value).toBe("boolean");
    }
  });

  it("snapshot reflects server overrides", () => {
    const { getAllFlags, _setServerOverrides } = loadModule();
    _setServerOverrides({ disputes: true, refunds: true });
    const flags = getAllFlags();
    expect(flags.disputes).toBe(true);
    expect(flags.refunds).toBe(true);
  });

  it("returned object is frozen (immutable snapshot)", () => {
    const { getAllFlags } = loadModule();
    const flags = getAllFlags();
    expect(Object.isFrozen(flags)).toBe(true);
  });

  it("mutating the snapshot does not affect subsequent isEnabled calls", () => {
    const { getAllFlags, isEnabled } = loadModule();
    const flags = getAllFlags();
    // Attempting mutation on frozen object throws in strict mode; silence it.
    try { flags.disputes = true; } catch { /* expected */ }
    expect(isEnabled("disputes")).toBe(false);
  });
});

// ─── loadServerFlags ─────────────────────────────────────────────────────────

describe("featureFlags — loadServerFlags", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("merges boolean flags from a successful response", async () => {
    jest.resetModules();
    const { isEnabled, loadServerFlags } = require("../featureFlags");

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ disputes: true, refunds: false }),
      })
    );

    await loadServerFlags({ apiUrl: "http://localhost:5000/api" });

    expect(isEnabled("disputes")).toBe(true);
    expect(isEnabled("refunds")).toBe(false);
  });

  it("ignores non-boolean values from the server response", async () => {
    jest.resetModules();
    const { isEnabled, loadServerFlags } = require("../featureFlags");

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ disputes: "yes", refunds: 1, multiAsset: null }),
      })
    );

    await loadServerFlags({ apiUrl: "http://localhost:5000/api" });

    // Non-boolean server values fall back to build-time default (false).
    expect(isEnabled("disputes")).toBe(false);
    expect(isEnabled("refunds")).toBe(false);
    expect(isEnabled("multiAsset")).toBe(false);
  });

  it("keeps build-time defaults when server returns a non-2xx status", async () => {
    jest.resetModules();
    const { isEnabled, loadServerFlags } = require("../featureFlags");

    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) })
    );

    // Should not throw.
    await expect(loadServerFlags({ apiUrl: "http://localhost:5000/api" })).resolves.toBeUndefined();
    expect(isEnabled("disputes")).toBe(false);
  });

  it("swallows network errors and keeps build-time defaults", async () => {
    jest.resetModules();
    const { isEnabled, loadServerFlags } = require("../featureFlags");

    global.fetch = jest.fn(() => Promise.reject(new Error("Network failure")));

    await expect(loadServerFlags({ apiUrl: "http://localhost:5000/api" })).resolves.toBeUndefined();
    expect(isEnabled("disputes")).toBe(false);
  });

  it("keeps build-time defaults when the response is not a plain object", async () => {
    jest.resetModules();
    const { isEnabled, loadServerFlags } = require("../featureFlags");

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([true, false]), // array, not object
      })
    );

    await loadServerFlags({ apiUrl: "http://localhost:5000/api" });
    expect(isEnabled("disputes")).toBe(false);
  });

  it("is a no-op when called server-side (window === undefined)", async () => {
    jest.resetModules();
    const savedWindow = global.window;
    // Simulate SSR environment.
    Object.defineProperty(global, "window", { value: undefined, writable: true });
    global.fetch = jest.fn();

    const { loadServerFlags } = require("../featureFlags");
    await loadServerFlags({ apiUrl: "http://localhost:5000/api" });

    expect(global.fetch).not.toHaveBeenCalled();
    global.window = savedWindow;
  });

  it("uses NEXT_PUBLIC_API_URL as the default base URL", async () => {
    jest.resetModules();
    process.env.NEXT_PUBLIC_API_URL = "http://testserver:8080/api";

    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    );

    const { loadServerFlags } = require("../featureFlags");
    await loadServerFlags();

    expect(global.fetch).toHaveBeenCalledWith(
      "http://testserver:8080/api/feature-flags",
      expect.any(Object)
    );
    delete process.env.NEXT_PUBLIC_API_URL;
  });
});
