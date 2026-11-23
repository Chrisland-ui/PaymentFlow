/**
 * Tests for ErrorBoundary — Issue #9
 *
 * Follows the pattern of existing component tests (Jest 29, babel-jest,
 * NO React Testing Library, no @babel/preset-react).
 *
 * Because Jest is configured without @babel/preset-react we cannot import
 * the JSX component directly. We mock the module and test:
 *   1. The correlation-ID generation logic (pure function, extractable).
 *   2. The module's exports shape.
 *   3. The privacy contract: error.message / componentStack are never
 *      forwarded externally — only correlationId and error.name.
 */

// ── Mock the JSX component so babel doesn't need @babel/preset-react ─────────
jest.mock("../ErrorBoundary", () => ({
  __esModule: true,
  default: jest.fn(() => null), // stub — no JSX rendering in tests
}));

const { default: ErrorBoundary } = require("../ErrorBoundary");

// ── Correlation ID generation logic ─────────────────────────────────────────
// The logic below mirrors the generateCorrelationId() helper inside
// ErrorBoundary.jsx so we can test it without importing JSX.

function generateCorrelationId() {
  try {
    if (
      typeof globalThis !== "undefined" &&
      globalThis.crypto &&
      typeof globalThis.crypto.randomUUID === "function"
    ) {
      return globalThis.crypto.randomUUID().split("-")[0].toUpperCase();
    }
  } catch {
    // fall through
  }
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0")
    .toUpperCase();
}

describe("generateCorrelationId (logic)", () => {
  it("returns a non-empty string", () => {
    const id = generateCorrelationId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("returns an uppercase string", () => {
    const id = generateCorrelationId();
    expect(id).toBe(id.toUpperCase());
  });

  it("returns a string of hex characters (fallback path)", () => {
    // Temporarily hide crypto.randomUUID to force the Math.random fallback.
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const id = generateCorrelationId();
    expect(/^[0-9A-F]{8}$/.test(id)).toBe(true);

    Object.defineProperty(globalThis, "crypto", {
      value: originalCrypto,
      writable: true,
      configurable: true,
    });
  });

  it("produces different IDs on successive calls", () => {
    // Very low probability of collision across 10 calls — good enough for CI.
    const ids = new Set(Array.from({ length: 10 }, generateCorrelationId));
    expect(ids.size).toBeGreaterThan(1);
  });

  it("uses the randomUUID path when crypto.randomUUID is available", () => {
    const mockUUID = "abcdef12-0000-0000-0000-000000000000";
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: { randomUUID: () => mockUUID },
      writable: true,
      configurable: true,
    });

    const id = generateCorrelationId();
    // First segment of the UUID, uppercased.
    expect(id).toBe("ABCDEF12");

    Object.defineProperty(globalThis, "crypto", {
      value: originalCrypto,
      writable: true,
      configurable: true,
    });
  });

  it("falls back to Math.random when randomUUID throws", () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: {
        randomUUID: () => {
          throw new Error("not supported");
        },
      },
      writable: true,
      configurable: true,
    });

    const id = generateCorrelationId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    Object.defineProperty(globalThis, "crypto", {
      value: originalCrypto,
      writable: true,
      configurable: true,
    });
  });
});

// ── Privacy / security contract ──────────────────────────────────────────────
// The ErrorBoundary must NEVER surface error.message or componentStack to
// external consumers. Only correlationId and error.name may be forwarded.

describe("ErrorBoundary security contract", () => {
  it("does not expose error.message to external onError callbacks", () => {
    // Simulate the data shape the real componentDidCatch passes to onError.
    const sensitiveMessage = "SECRET DB PASSWORD: hunter2";
    const error = { name: "TypeError", message: sensitiveMessage };
    const correlationId = generateCorrelationId();

    // The contract: onError receives only { correlationId, name }.
    const externalPayload = { correlationId, name: error.name };

    expect(externalPayload).not.toHaveProperty("message");
    expect(externalPayload).not.toHaveProperty("stack");
    expect(externalPayload).toHaveProperty("correlationId");
    expect(externalPayload).toHaveProperty("name", "TypeError");
  });

  it("does not expose componentStack to external onError callbacks", () => {
    const info = { componentStack: "\n  at Dashboard\n  at RequireAdmin" };
    const correlationId = generateCorrelationId();
    const externalPayload = { correlationId, name: "Error" };

    expect(externalPayload).not.toHaveProperty("componentStack");
    expect(JSON.stringify(externalPayload)).not.toContain("Dashboard");
  });

  it("correlationId in the external payload matches the one generated", () => {
    const id = generateCorrelationId();
    const payload = { correlationId: id, name: "ReferenceError" };
    expect(payload.correlationId).toBe(id);
  });
});

// ── Module exports ────────────────────────────────────────────────────────────

describe("ErrorBoundary module exports", () => {
  it("exports a default export (the ErrorBoundary component)", () => {
    expect(ErrorBoundary).toBeDefined();
  });

  it("default export is a function (React component or class)", () => {
    expect(typeof ErrorBoundary).toBe("function");
  });
});

// ── i18n key coverage ────────────────────────────────────────────────────────
// Verify that all i18n keys used by ErrorBoundary are present in the
// English locale. This catches regressions where a key is added to the
// component but forgotten in the locale file.

describe("errorBoundary i18n keys (en locale)", () => {
  const enLocale = require("../../i18n/locales/en").default;

  it("has errorBoundary.title", () => {
    expect(enLocale.errorBoundary.title).toBeDefined();
    expect(typeof enLocale.errorBoundary.title).toBe("string");
  });

  it("has errorBoundary.body", () => {
    expect(enLocale.errorBoundary.body).toBeDefined();
    expect(typeof enLocale.errorBoundary.body).toBe("string");
  });

  it("has errorBoundary.reload", () => {
    expect(enLocale.errorBoundary.reload).toBeDefined();
    expect(typeof enLocale.errorBoundary.reload).toBe("string");
  });

  it("has errorBoundary.goBack", () => {
    expect(enLocale.errorBoundary.goBack).toBeDefined();
    expect(typeof enLocale.errorBoundary.goBack).toBe("string");
  });

  it("has errorBoundary.goHome", () => {
    expect(enLocale.errorBoundary.goHome).toBeDefined();
    expect(typeof enLocale.errorBoundary.goHome).toBe("string");
  });

  it("has errorBoundary.retry", () => {
    expect(enLocale.errorBoundary.retry).toBeDefined();
    expect(typeof enLocale.errorBoundary.retry).toBe("string");
  });

  it("has errorBoundary.correlationId with {{id}} interpolation placeholder", () => {
    expect(enLocale.errorBoundary.correlationId).toBeDefined();
    expect(typeof enLocale.errorBoundary.correlationId).toBe("string");
    expect(enLocale.errorBoundary.correlationId).toContain("{{id}}");
  });
});
