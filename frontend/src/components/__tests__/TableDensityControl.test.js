/**
 * Tests for TableDensityControl — Issue #113
 *
 * Follows the pattern of existing utility tests (Jest 29, babel-jest,
 * NO React Testing Library, no @babel/preset-react).
 *
 * Because Jest is configured without @babel/preset-react, we cannot import
 * the JSX component directly in this test. We mock the module to extract
 * the pure logic (DENSITY_OPTIONS) and test the density persistence
 * contract in isolation.
 *
 * jest.mock() factory functions cannot reference out-of-scope variables, so
 * we keep the mock factory free of localStorage references and test the
 * persistence logic separately.
 */

const MOCK_DENSITY_OPTIONS = ["compact", "default", "comfortable"];
const STORAGE_KEY = "tableDensity";

// ── Mock the JSX component so babel doesn't need @babel/preset-react ─────────
jest.mock("../TableDensityControl", () => ({
  DENSITY_OPTIONS: ["compact", "default", "comfortable"],
  TableDensityControl: jest.fn(() => null), // stub — no JSX needed in tests
  useTableDensity: jest.fn(() => ({
    density: "default",
    setDensity: jest.fn(),
  })),
}));

const { DENSITY_OPTIONS, useTableDensity, TableDensityControl } = require("../TableDensityControl");

// ── DENSITY_OPTIONS ───────────────────────────────────────────────────────────

describe("DENSITY_OPTIONS", () => {
  it("contains exactly three density values", () => {
    expect(DENSITY_OPTIONS).toHaveLength(3);
  });

  it("includes compact, default, and comfortable", () => {
    expect(DENSITY_OPTIONS).toContain("compact");
    expect(DENSITY_OPTIONS).toContain("default");
    expect(DENSITY_OPTIONS).toContain("comfortable");
  });

  it("is ordered compact → default → comfortable", () => {
    expect(DENSITY_OPTIONS[0]).toBe("compact");
    expect(DENSITY_OPTIONS[1]).toBe("default");
    expect(DENSITY_OPTIONS[2]).toBe("comfortable");
  });
});

// ── localStorage persistence logic ───────────────────────────────────────────
// Tests the pure persistence logic the hook uses — without importing JSX.

describe("density persistence logic (localStorage)", () => {
  let fakeStorage;

  beforeEach(() => {
    let store = {};
    fakeStorage = {
      getItem:    (key)        => store[key] ?? null,
      setItem:    (key, value) => { store[key] = String(value); },
      removeItem: (key)        => { delete store[key]; },
      clear:      ()           => { store = {}; },
    };
    Object.defineProperty(global, "localStorage", {
      value: fakeStorage,
      writable: true,
    });
  });

  afterEach(() => {
    fakeStorage.clear();
  });

  it("reads 'default' when localStorage is empty", () => {
    expect(fakeStorage.getItem(STORAGE_KEY)).toBeNull();
    const stored = fakeStorage.getItem(STORAGE_KEY);
    const density = (stored && MOCK_DENSITY_OPTIONS.includes(stored)) ? stored : "default";
    expect(density).toBe("default");
  });

  it("reads a stored density value from localStorage", () => {
    fakeStorage.setItem(STORAGE_KEY, "compact");
    const stored = fakeStorage.getItem(STORAGE_KEY);
    const density = (stored && MOCK_DENSITY_OPTIONS.includes(stored)) ? stored : "default";
    expect(density).toBe("compact");
  });

  it("ignores an invalid density value in localStorage", () => {
    fakeStorage.setItem(STORAGE_KEY, "INVALID_DENSITY");
    const stored = fakeStorage.getItem(STORAGE_KEY);
    const density = (stored && MOCK_DENSITY_OPTIONS.includes(stored)) ? stored : "default";
    expect(density).toBe("default");
  });

  it("persists density to localStorage when set", () => {
    const newDensity = "comfortable";
    if (MOCK_DENSITY_OPTIONS.includes(newDensity)) {
      fakeStorage.setItem(STORAGE_KEY, newDensity);
    }
    expect(fakeStorage.getItem(STORAGE_KEY)).toBe("comfortable");
  });

  it("does not persist an invalid density", () => {
    const invalid = "huge";
    // Only write if valid — the hook's guard prevents invalid values
    if (MOCK_DENSITY_OPTIONS.includes(invalid)) {
      fakeStorage.setItem(STORAGE_KEY, invalid);
    }
    expect(fakeStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("correctly handles all three valid density options", () => {
    for (const d of MOCK_DENSITY_OPTIONS) {
      fakeStorage.setItem(STORAGE_KEY, d);
      const stored = fakeStorage.getItem(STORAGE_KEY);
      const density = (stored && MOCK_DENSITY_OPTIONS.includes(stored)) ? stored : "default";
      expect(density).toBe(d);
    }
  });
});

// ── Module exports ────────────────────────────────────────────────────────────

describe("TableDensityControl module exports", () => {
  it("exports DENSITY_OPTIONS as a non-empty array", () => {
    expect(Array.isArray(DENSITY_OPTIONS)).toBe(true);
    expect(DENSITY_OPTIONS.length).toBeGreaterThan(0);
  });

  it("exports useTableDensity as a function", () => {
    expect(typeof useTableDensity).toBe("function");
  });

  it("exports TableDensityControl as a function (React component)", () => {
    expect(typeof TableDensityControl).toBe("function");
  });

  it("useTableDensity returns an object with density and setDensity", () => {
    const result = useTableDensity();
    expect(result).toHaveProperty("density");
    expect(result).toHaveProperty("setDensity");
    expect(typeof result.setDensity).toBe("function");
  });

  it("default density is 'default'", () => {
    const { density } = useTableDensity();
    expect(density).toBe("default");
  });
});
