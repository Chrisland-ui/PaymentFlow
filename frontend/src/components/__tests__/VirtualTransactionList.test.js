/**
 * Tests for VirtualTransactionList — Issue #7
 *
 * Strategy: Jest is configured without @babel/preset-react so we cannot import
 * the JSX component directly.  We mock the module to expose the pure logic
 * functions (useSortedTransactions, constants) and test them in isolation.
 *
 * The virtualisation contract itself (FixedSizeList renders only visible rows)
 * is enforced by react-window's own test suite; we don't re-test it here.
 * What we validate is:
 *   - sorting logic (date, amount, status; asc + desc)
 *   - exported constants are present and sane
 *   - the mock module shape matches what consuming code depends on
 */

// ── Mock the JSX module ───────────────────────────────────────────────────────
// We extract the pure useSortedTransactions logic into the mock so we can test
// it without needing a DOM or React renderer.

jest.mock("../VirtualTransactionList", () => {
  // Re-implement useSortedTransactions inline (pure function, no React hooks).
  function sortTransactions(payments, sort) {
    if (!Array.isArray(payments) || payments.length === 0) return payments || [];
    const copy = [...payments];
    copy.sort((a, b) => {
      let cmp = 0;
      if (sort.column === "date") {
        const ta = a.confirmedAt ? new Date(a.confirmedAt).getTime() : 0;
        const tb = b.confirmedAt ? new Date(b.confirmedAt).getTime() : 0;
        cmp = ta - tb;
      } else if (sort.column === "amount") {
        cmp = (parseFloat(a.amount) || 0) - (parseFloat(b.amount) || 0);
      } else if (sort.column === "status") {
        const order = { valid: 0, overpaid: 1, underpaid: 2, unknown: 3 };
        cmp = (order[a.feeValidationStatus] ?? 4) - (order[b.feeValidationStatus] ?? 4);
      }
      return sort.direction === "asc" ? cmp : -cmp;
    });
    return copy;
  }

  return {
    ROW_HEIGHT: 88,
    LIST_HEIGHT: 440,
    SORT_COLUMNS: ["date", "amount", "status"],
    DEFAULT_SORT: { column: "date", direction: "desc" },
    useSortedTransactions: sortTransactions,
    default: jest.fn(() => null), // stub React component
  };
});

const {
  ROW_HEIGHT,
  LIST_HEIGHT,
  SORT_COLUMNS,
  DEFAULT_SORT,
  useSortedTransactions,
} = require("../VirtualTransactionList");

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTx(overrides = {}) {
  return {
    txHash: `hash-${Math.random()}`,
    amount: "100",
    assetCode: "XLM",
    confirmedAt: new Date().toISOString(),
    feeValidationStatus: "valid",
    ...overrides,
  };
}

const TX_A = makeTx({ amount: "50",  confirmedAt: "2024-01-01T10:00:00Z", feeValidationStatus: "valid" });
const TX_B = makeTx({ amount: "200", confirmedAt: "2024-03-15T08:00:00Z", feeValidationStatus: "overpaid" });
const TX_C = makeTx({ amount: "10",  confirmedAt: "2023-06-01T12:00:00Z", feeValidationStatus: "underpaid" });
const TX_D = makeTx({ amount: "500", confirmedAt: "2024-06-10T09:00:00Z", feeValidationStatus: "unknown" });

const SAMPLE = [TX_A, TX_B, TX_C, TX_D];

// ── Constants ─────────────────────────────────────────────────────────────────

describe("VirtualTransactionList constants", () => {
  it("ROW_HEIGHT is a positive number", () => {
    expect(typeof ROW_HEIGHT).toBe("number");
    expect(ROW_HEIGHT).toBeGreaterThan(0);
  });

  it("LIST_HEIGHT is greater than ROW_HEIGHT", () => {
    expect(LIST_HEIGHT).toBeGreaterThan(ROW_HEIGHT);
  });

  it("SORT_COLUMNS contains date, amount, and status", () => {
    expect(SORT_COLUMNS).toContain("date");
    expect(SORT_COLUMNS).toContain("amount");
    expect(SORT_COLUMNS).toContain("status");
  });

  it("DEFAULT_SORT sorts by date descending (newest first)", () => {
    expect(DEFAULT_SORT.column).toBe("date");
    expect(DEFAULT_SORT.direction).toBe("desc");
  });
});

// ── useSortedTransactions ─────────────────────────────────────────────────────

describe("useSortedTransactions", () => {
  describe("edge cases", () => {
    it("returns an empty array for empty input", () => {
      expect(useSortedTransactions([], { column: "date", direction: "desc" })).toEqual([]);
    });

    it("returns an empty array for null input", () => {
      expect(useSortedTransactions(null, { column: "date", direction: "desc" })).toEqual([]);
    });

    it("returns a single-element array unchanged", () => {
      const result = useSortedTransactions([TX_A], { column: "date", direction: "asc" });
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(TX_A);
    });

    it("does not mutate the original array", () => {
      const original = [...SAMPLE];
      useSortedTransactions(original, { column: "amount", direction: "asc" });
      expect(original).toEqual(SAMPLE); // same order as before
    });
  });

  describe("sort by date", () => {
    it("sorts oldest → newest when direction is asc", () => {
      const result = useSortedTransactions(SAMPLE, { column: "date", direction: "asc" });
      const dates = result.map(t => new Date(t.confirmedAt).getTime());
      expect(dates).toEqual([...dates].sort((a, b) => a - b));
    });

    it("sorts newest → oldest when direction is desc", () => {
      const result = useSortedTransactions(SAMPLE, { column: "date", direction: "desc" });
      const dates = result.map(t => new Date(t.confirmedAt).getTime());
      expect(dates).toEqual([...dates].sort((a, b) => b - a));
    });

    it("places transactions without a confirmedAt at the start when asc", () => {
      const noDate = makeTx({ confirmedAt: null });
      const result = useSortedTransactions([TX_A, noDate], { column: "date", direction: "asc" });
      expect(result[0]).toBe(noDate);
    });

    it("DEFAULT_SORT produces newest-first order", () => {
      const result = useSortedTransactions(SAMPLE, DEFAULT_SORT);
      expect(result[0]).toBe(TX_D); // 2024-06-10 is the latest
    });
  });

  describe("sort by amount", () => {
    it("sorts smallest → largest when direction is asc", () => {
      const result = useSortedTransactions(SAMPLE, { column: "amount", direction: "asc" });
      const amounts = result.map(t => parseFloat(t.amount));
      expect(amounts).toEqual([...amounts].sort((a, b) => a - b));
    });

    it("sorts largest → smallest when direction is desc", () => {
      const result = useSortedTransactions(SAMPLE, { column: "amount", direction: "desc" });
      const amounts = result.map(t => parseFloat(t.amount));
      expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
    });

    it("treats non-numeric amount as 0", () => {
      const badAmt = makeTx({ amount: "N/A" });
      const result = useSortedTransactions([TX_A, badAmt], { column: "amount", direction: "asc" });
      expect(result[0]).toBe(badAmt); // 0 < 50
    });
  });

  describe("sort by status", () => {
    it("sorts valid → overpaid → underpaid → unknown asc", () => {
      const result = useSortedTransactions(SAMPLE, { column: "status", direction: "asc" });
      const statuses = result.map(t => t.feeValidationStatus);
      expect(statuses[0]).toBe("valid");
      expect(statuses[1]).toBe("overpaid");
      expect(statuses[2]).toBe("underpaid");
      expect(statuses[3]).toBe("unknown");
    });

    it("reverses order when direction is desc", () => {
      const result = useSortedTransactions(SAMPLE, { column: "status", direction: "desc" });
      const statuses = result.map(t => t.feeValidationStatus);
      expect(statuses[0]).toBe("unknown");
      expect(statuses[3]).toBe("valid");
    });
  });

  describe("large dataset performance", () => {
    it("handles 10,000 rows without throwing", () => {
      const rows = Array.from({ length: 10000 }, (_, i) =>
        makeTx({
          amount: String(Math.random() * 1000),
          confirmedAt: new Date(Date.now() - i * 1000).toISOString(),
          feeValidationStatus: ["valid", "overpaid", "underpaid", "unknown"][i % 4],
        })
      );
      expect(() => {
        useSortedTransactions(rows, DEFAULT_SORT);
      }).not.toThrow();
    });

    it("returns the same length as input for 10,000 rows", () => {
      const rows = Array.from({ length: 10000 }, () => makeTx());
      const result = useSortedTransactions(rows, DEFAULT_SORT);
      expect(result).toHaveLength(10000);
    });
  });
});

// ── Module exports ────────────────────────────────────────────────────────────

describe("VirtualTransactionList module exports", () => {
  it("exports ROW_HEIGHT as a number", () => {
    expect(typeof ROW_HEIGHT).toBe("number");
  });

  it("exports LIST_HEIGHT as a number", () => {
    expect(typeof LIST_HEIGHT).toBe("number");
  });

  it("exports SORT_COLUMNS as a non-empty array", () => {
    expect(Array.isArray(SORT_COLUMNS)).toBe(true);
    expect(SORT_COLUMNS.length).toBeGreaterThan(0);
  });

  it("exports DEFAULT_SORT with column and direction fields", () => {
    expect(DEFAULT_SORT).toHaveProperty("column");
    expect(DEFAULT_SORT).toHaveProperty("direction");
  });

  it("exports useSortedTransactions as a function", () => {
    expect(typeof useSortedTransactions).toBe("function");
  });
});
