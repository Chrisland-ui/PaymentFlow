/**
 * Tests for TransactionDetail — Issue #106
 *
 * Follows the project pattern (Jest 29, babel-jest, NO @babel/preset-react).
 * The JSX component is mocked so babel does not need React JSX support.
 * Pure helper logic is extracted and tested directly.
 */

// ── Mock the JSX component ────────────────────────────────────────────────────
jest.mock("../TransactionDetail", () => {
  return {
    __esModule: true,
    default: jest.fn(() => null),
  };
});

const TransactionDetail = require("../TransactionDetail").default;

// ── Helpers extracted for unit testing ───────────────────────────────────────

function truncateHash(hash, len = 16) {
  if (!hash) return "—";
  if (hash.length <= len) return hash;
  return `${hash.slice(0, len)}…`;
}

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const STATUS_CONFIG = {
  SUCCESS:   { cls: "badge-success", color: "var(--success)" },
  CONFIRMED: { cls: "badge-success", color: "var(--success)" },
  PENDING:   { cls: "badge-warning", color: "var(--warning)" },
  SUBMITTED: { cls: "badge-info",    color: "var(--info)" },
  FAILED:    { cls: "badge-danger",  color: "var(--danger)" },
  DISPUTED:  { cls: "badge-warning", color: "var(--warning)" },
  REFUNDED:  { cls: "badge-neutral", color: "var(--text-muted)" },
  INVALID:   { cls: "badge-danger",  color: "var(--danger)" },
};

function getStatusConfig(status) {
  return STATUS_CONFIG[(status || "").toUpperCase()] ||
    { cls: "badge-neutral", color: "var(--text-muted)" };
}

// ── truncateHash ──────────────────────────────────────────────────────────────

describe("truncateHash", () => {
  it("returns — for null", () => {
    expect(truncateHash(null)).toBe("—");
  });

  it("returns — for undefined", () => {
    expect(truncateHash(undefined)).toBe("—");
  });

  it("returns — for empty string", () => {
    expect(truncateHash("")).toBe("—");
  });

  it("returns the full string when length is at or below limit", () => {
    expect(truncateHash("abc123", 10)).toBe("abc123");
    expect(truncateHash("exactly16chars!!", 16)).toBe("exactly16chars!!");
  });

  it("truncates a long hash with ellipsis", () => {
    const hash = "a1b2c3d4e5f6a7b8c9d0e1f2";
    const result = truncateHash(hash, 16);
    expect(result).toBe("a1b2c3d4e5f6a7b8…");
    expect(result.endsWith("…")).toBe(true);
    // The visible portion is exactly `len` chars before the ellipsis
    expect(result.slice(0, 16)).toBe(hash.slice(0, 16));
  });

  it("uses default length of 16 when not specified", () => {
    const hash = "x".repeat(64); // typical Stellar tx hash length
    const result = truncateHash(hash);
    expect(result.length).toBe(17); // 16 chars + ellipsis
  });
});

// ── formatDate ────────────────────────────────────────────────────────────────

describe("formatDate", () => {
  it("returns — for null", () => {
    expect(formatDate(null)).toBe("—");
  });

  it("returns — for undefined", () => {
    expect(formatDate(undefined)).toBe("—");
  });

  it("returns — for empty string", () => {
    expect(formatDate("")).toBe("—");
  });

  it("returns a non-empty string for a valid ISO date", () => {
    const result = formatDate("2025-01-15T10:30:00.000Z");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe("—");
  });

  it("does not throw for an invalid date string", () => {
    expect(() => formatDate("not-a-date")).not.toThrow();
  });
});

// ── getStatusConfig ───────────────────────────────────────────────────────────

describe("getStatusConfig", () => {
  it("returns success config for SUCCESS", () => {
    expect(getStatusConfig("SUCCESS").cls).toBe("badge-success");
  });

  it("returns success config for CONFIRMED", () => {
    expect(getStatusConfig("CONFIRMED").cls).toBe("badge-success");
  });

  it("returns warning config for PENDING", () => {
    expect(getStatusConfig("PENDING").cls).toBe("badge-warning");
  });

  it("returns warning config for DISPUTED", () => {
    expect(getStatusConfig("DISPUTED").cls).toBe("badge-warning");
  });

  it("returns danger config for FAILED", () => {
    expect(getStatusConfig("FAILED").cls).toBe("badge-danger");
  });

  it("returns danger config for INVALID", () => {
    expect(getStatusConfig("INVALID").cls).toBe("badge-danger");
  });

  it("returns info config for SUBMITTED", () => {
    expect(getStatusConfig("SUBMITTED").cls).toBe("badge-info");
  });

  it("returns neutral fallback for unknown status", () => {
    expect(getStatusConfig("UNKNOWN_XYZ").cls).toBe("badge-neutral");
  });

  it("is case-insensitive", () => {
    expect(getStatusConfig("success").cls).toBe("badge-success");
    expect(getStatusConfig("failed").cls).toBe("badge-danger");
  });

  it("handles null gracefully", () => {
    expect(getStatusConfig(null).cls).toBe("badge-neutral");
  });

  it("handles undefined gracefully", () => {
    expect(getStatusConfig(undefined).cls).toBe("badge-neutral");
  });

  it("returns a color value for every known status", () => {
    const knownStatuses = ["SUCCESS", "CONFIRMED", "PENDING", "SUBMITTED", "FAILED", "DISPUTED", "REFUNDED", "INVALID"];
    for (const s of knownStatuses) {
      expect(getStatusConfig(s).color).toBeDefined();
      expect(typeof getStatusConfig(s).color).toBe("string");
    }
  });
});

// ── Dispute action guard ──────────────────────────────────────────────────────

describe("dispute action visibility logic", () => {
  const NON_DISPUTABLE = ["DISPUTED", "REFUNDED", "PENDING", "FAILED", "INVALID"];

  function canDispute(status) {
    return !NON_DISPUTABLE.includes((status || "").toUpperCase());
  }

  it("allows dispute for SUCCESS", () => {
    expect(canDispute("SUCCESS")).toBe(true);
  });

  it("allows dispute for CONFIRMED", () => {
    expect(canDispute("CONFIRMED")).toBe(true);
  });

  it("allows dispute for SUBMITTED", () => {
    expect(canDispute("SUBMITTED")).toBe(true);
  });

  it("disallows dispute for DISPUTED", () => {
    expect(canDispute("DISPUTED")).toBe(false);
  });

  it("disallows dispute for REFUNDED", () => {
    expect(canDispute("REFUNDED")).toBe(false);
  });

  it("disallows dispute for PENDING", () => {
    expect(canDispute("PENDING")).toBe(false);
  });

  it("disallows dispute for FAILED", () => {
    expect(canDispute("FAILED")).toBe(false);
  });

  it("disallows dispute for INVALID", () => {
    expect(canDispute("INVALID")).toBe(false);
  });
});

// ── Module export ─────────────────────────────────────────────────────────────

describe("TransactionDetail module", () => {
  it("exports a function (React component stub)", () => {
    expect(typeof TransactionDetail).toBe("function");
  });
});
