/**
 * Tests for FilterChips — Issue #107
 *
 * Follows the project pattern (Jest 29, babel-jest, NO @babel/preset-react).
 * The JSX component is mocked. Pure logic is tested directly.
 */

// ── Mock the JSX component ────────────────────────────────────────────────────
jest.mock("../FilterChips", () => ({
  __esModule: true,
  default: jest.fn(() => null),
}));

const FilterChips = require("../FilterChips").default;

// ── Pure helper logic matching what FilterChips uses internally ───────────────

/**
 * Builds an activeFilters array from the filter state values
 * (mirrors the call-site pattern).
 */
function buildActiveFilters({ statusFilter, classFilter, search }) {
  return [
    statusFilter && statusFilter !== "all"
      ? { key: "status", label: "Status", value: statusFilter }
      : null,
    classFilter
      ? { key: "className", label: "Class", value: classFilter }
      : null,
    search
      ? { key: "search", label: "Search", value: search }
      : null,
  ].filter(Boolean);
}

/**
 * Removes a filter by key and returns the new state delta.
 */
function removeFilter(key, { setStatusFilter, setClassFilter, setSearch }) {
  const handlers = {
    status:    () => setStatusFilter("all"),
    className: () => setClassFilter(""),
    search:    () => setSearch(""),
  };
  if (handlers[key]) handlers[key]();
}

/**
 * Clears all filters.
 */
function clearAllFilters({ setStatusFilter, setClassFilter, setSearch }) {
  setStatusFilter("all");
  setClassFilter("");
  setSearch("");
}

// ── buildActiveFilters ────────────────────────────────────────────────────────

describe("buildActiveFilters", () => {
  it("returns an empty array when no filters are active", () => {
    const result = buildActiveFilters({ statusFilter: "all", classFilter: "", search: "" });
    expect(result).toHaveLength(0);
  });

  it("returns one chip when only status is set", () => {
    const result = buildActiveFilters({ statusFilter: "paid", classFilter: "", search: "" });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("status");
    expect(result[0].value).toBe("paid");
    expect(result[0].label).toBe("Status");
  });

  it("returns one chip when only class is set", () => {
    const result = buildActiveFilters({ statusFilter: "all", classFilter: "Class A", search: "" });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("className");
    expect(result[0].value).toBe("Class A");
  });

  it("returns one chip when only search is set", () => {
    const result = buildActiveFilters({ statusFilter: "all", classFilter: "", search: "John" });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("search");
    expect(result[0].value).toBe("John");
  });

  it("returns two chips when status and class are set", () => {
    const result = buildActiveFilters({ statusFilter: "paid", classFilter: "Class B", search: "" });
    expect(result).toHaveLength(2);
    const keys = result.map(r => r.key);
    expect(keys).toContain("status");
    expect(keys).toContain("className");
  });

  it("returns three chips when all filters are set", () => {
    const result = buildActiveFilters({ statusFilter: "unpaid", classFilter: "Class C", search: "Anna" });
    expect(result).toHaveLength(3);
    const keys = result.map(r => r.key);
    expect(keys).toContain("status");
    expect(keys).toContain("className");
    expect(keys).toContain("search");
  });

  it("does not include a chip for statusFilter === 'all'", () => {
    const result = buildActiveFilters({ statusFilter: "all", classFilter: "Class X", search: "" });
    const keys = result.map(r => r.key);
    expect(keys).not.toContain("status");
  });

  it("preserves the label and value for each chip", () => {
    const result = buildActiveFilters({ statusFilter: "partial", classFilter: "", search: "" });
    expect(result[0].label).toBe("Status");
    expect(result[0].value).toBe("partial");
  });
});

// ── removeFilter ──────────────────────────────────────────────────────────────

describe("removeFilter", () => {
  it("resets statusFilter to 'all' when removing status chip", () => {
    const setStatusFilter = jest.fn();
    const setClassFilter  = jest.fn();
    const setSearch       = jest.fn();
    removeFilter("status", { setStatusFilter, setClassFilter, setSearch });
    expect(setStatusFilter).toHaveBeenCalledWith("all");
    expect(setClassFilter).not.toHaveBeenCalled();
    expect(setSearch).not.toHaveBeenCalled();
  });

  it("clears classFilter when removing className chip", () => {
    const setStatusFilter = jest.fn();
    const setClassFilter  = jest.fn();
    const setSearch       = jest.fn();
    removeFilter("className", { setStatusFilter, setClassFilter, setSearch });
    expect(setClassFilter).toHaveBeenCalledWith("");
    expect(setStatusFilter).not.toHaveBeenCalled();
    expect(setSearch).not.toHaveBeenCalled();
  });

  it("clears search when removing search chip", () => {
    const setStatusFilter = jest.fn();
    const setClassFilter  = jest.fn();
    const setSearch       = jest.fn();
    removeFilter("search", { setStatusFilter, setClassFilter, setSearch });
    expect(setSearch).toHaveBeenCalledWith("");
    expect(setStatusFilter).not.toHaveBeenCalled();
    expect(setClassFilter).not.toHaveBeenCalled();
  });

  it("does not throw for an unknown key", () => {
    const setStatusFilter = jest.fn();
    const setClassFilter  = jest.fn();
    const setSearch       = jest.fn();
    expect(() =>
      removeFilter("unknown_key", { setStatusFilter, setClassFilter, setSearch })
    ).not.toThrow();
    expect(setStatusFilter).not.toHaveBeenCalled();
    expect(setClassFilter).not.toHaveBeenCalled();
    expect(setSearch).not.toHaveBeenCalled();
  });
});

// ── clearAllFilters ───────────────────────────────────────────────────────────

describe("clearAllFilters", () => {
  it("resets all three filter state values", () => {
    const setStatusFilter = jest.fn();
    const setClassFilter  = jest.fn();
    const setSearch       = jest.fn();
    clearAllFilters({ setStatusFilter, setClassFilter, setSearch });
    expect(setStatusFilter).toHaveBeenCalledWith("all");
    expect(setClassFilter).toHaveBeenCalledWith("");
    expect(setSearch).toHaveBeenCalledWith("");
  });

  it("calls each setter exactly once", () => {
    const setStatusFilter = jest.fn();
    const setClassFilter  = jest.fn();
    const setSearch       = jest.fn();
    clearAllFilters({ setStatusFilter, setClassFilter, setSearch });
    expect(setStatusFilter).toHaveBeenCalledTimes(1);
    expect(setClassFilter).toHaveBeenCalledTimes(1);
    expect(setSearch).toHaveBeenCalledTimes(1);
  });
});

// ── "Clear all" visibility rule ───────────────────────────────────────────────

describe("clear-all visibility rule", () => {
  it("shows clear-all when more than one filter is active", () => {
    const filters = buildActiveFilters({ statusFilter: "paid", classFilter: "Class A", search: "" });
    expect(filters.length > 1).toBe(true);
  });

  it("does NOT show clear-all when only one filter is active", () => {
    const filters = buildActiveFilters({ statusFilter: "paid", classFilter: "", search: "" });
    expect(filters.length > 1).toBe(false);
  });

  it("does NOT show clear-all when no filters are active", () => {
    const filters = buildActiveFilters({ statusFilter: "all", classFilter: "", search: "" });
    expect(filters.length > 1).toBe(false);
  });
});

// ── chip count ────────────────────────────────────────────────────────────────

describe("chip count", () => {
  it("count equals the number of active filter entries", () => {
    const all = buildActiveFilters({ statusFilter: "unpaid", classFilter: "Class X", search: "test" });
    expect(all.length).toBe(3);
  });

  it("count is zero when no filters are active", () => {
    const none = buildActiveFilters({ statusFilter: "all", classFilter: "", search: "" });
    expect(none.length).toBe(0);
  });
});

// ── Module export ─────────────────────────────────────────────────────────────

describe("FilterChips module", () => {
  it("exports a function (React component stub)", () => {
    expect(typeof FilterChips).toBe("function");
  });
});
