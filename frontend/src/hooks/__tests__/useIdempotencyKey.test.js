/**
 * Tests for useIdempotencyKey — Issue #12
 *
 * Covers all acceptance criteria:
 *   - Retries reuse the same key (getKey() returns same value before rotate())
 *   - A new intentional payment receives a new key (after rotate() / reset())
 *   - Keys are not placed in URLs or analytics payloads (format / prefix check)
 *   - generateIdempotencyKey produces unique, well-formed keys
 *
 * Jest environment: node (matches jest.config.js).
 * No React renderer needed — hooks are tested by calling them as plain
 * functions (the same pattern used by AdminAuthContext.test.js).
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock React so we can invoke hooks without a renderer.
// useRef is replaced with a simple object-ref factory.
// useCallback returns its first argument unchanged.
jest.mock("react", () => ({
  useRef: jest.fn((initial) => ({ current: initial })),
  useCallback: jest.fn((fn) => fn),
}));

const { useIdempotencyKey, generateIdempotencyKey } = require("../useIdempotencyKey");

// ─── generateIdempotencyKey ───────────────────────────────────────────────────

describe("generateIdempotencyKey", () => {
  it("returns a string", () => {
    expect(typeof generateIdempotencyKey()).toBe("string");
  });

  it("starts with the 'pf-' prefix", () => {
    expect(generateIdempotencyKey()).toMatch(/^pf-/);
  });

  it("matches the expected format pf-<16 hex chars>-<digits>", () => {
    const key = generateIdempotencyKey();
    expect(key).toMatch(/^pf-[0-9a-f]{16}-\d+$/);
  });

  it("produces unique keys on successive calls", () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateIdempotencyKey()));
    expect(keys.size).toBe(50);
  });

  it("includes a timestamp component (last segment is numeric)", () => {
    const key = generateIdempotencyKey();
    const parts = key.split("-");
    const timestamp = Number(parts[parts.length - 1]);
    expect(Number.isFinite(timestamp)).toBe(true);
    expect(timestamp).toBeGreaterThan(0);
  });

  it("does not contain query-string delimiters (safe for headers, not for URLs)", () => {
    for (let i = 0; i < 20; i++) {
      const key = generateIdempotencyKey();
      expect(key).not.toContain("?");
      expect(key).not.toContain("&");
      expect(key).not.toContain("=");
      expect(key).not.toContain("#");
    }
  });
});

// ─── useIdempotencyKey ────────────────────────────────────────────────────────

describe("useIdempotencyKey", () => {
  // Re-require after clearing the module registry so the useRef mock starts fresh.
  function buildHook() {
    // Simulate a fresh component mount: invoke the hook as a plain function.
    // The React mock ensures useRef returns a shared mutable ref object and
    // useCallback passes functions through unchanged.
    return useIdempotencyKey();
  }

  describe("getKey — lazy generation", () => {
    it("returns a string on the first call", () => {
      const { getKey } = buildHook();
      expect(typeof getKey()).toBe("string");
    });

    it("generated key matches the expected format", () => {
      const { getKey } = buildHook();
      expect(getKey()).toMatch(/^pf-[0-9a-f]{16}-\d+$/);
    });

    it("returns the SAME key on repeated calls before rotate (retry contract)", () => {
      const { getKey } = buildHook();
      const first = getKey();
      const second = getKey();
      const third = getKey();
      expect(second).toBe(first);
      expect(third).toBe(first);
    });
  });

  describe("rotate — key lifecycle", () => {
    it("after rotate(), getKey() returns a DIFFERENT key", () => {
      const { getKey, rotate } = buildHook();
      const before = getKey();
      rotate();
      const after = getKey();
      expect(after).not.toBe(before);
    });

    it("after rotate(), the new key is still a valid pf-key", () => {
      const { getKey, rotate } = buildHook();
      getKey(); // generate first
      rotate();
      expect(getKey()).toMatch(/^pf-[0-9a-f]{16}-\d+$/);
    });

    it("multiple rotate() calls each produce a fresh key", () => {
      const { getKey, rotate } = buildHook();
      const keys = new Set();
      for (let i = 0; i < 5; i++) {
        keys.add(getKey());
        rotate();
      }
      // Each rotation should yield a unique key.
      expect(keys.size).toBe(5);
    });

    it("key is stable between two getKey() calls after rotate", () => {
      const { getKey, rotate } = buildHook();
      getKey(); // first key
      rotate();
      const a = getKey();
      const b = getKey(); // same key, no rotate in between
      expect(a).toBe(b);
    });
  });

  describe("reset — alias for rotate", () => {
    it("reset() causes getKey() to return a different key", () => {
      const { getKey, reset } = buildHook();
      const before = getKey();
      reset();
      const after = getKey();
      expect(after).not.toBe(before);
    });

    it("key after reset() matches expected format", () => {
      const { getKey, reset } = buildHook();
      getKey();
      reset();
      expect(getKey()).toMatch(/^pf-[0-9a-f]{16}-\d+$/);
    });

    it("reset() behaves identically to rotate() for multiple cycles", () => {
      const { getKey: gk1, rotate } = buildHook();
      const { getKey: gk2, reset } = buildHook();

      // Both hooks cycle three times; the number of unique keys must be 3.
      const rotateKeys = new Set();
      const resetKeys = new Set();
      for (let i = 0; i < 3; i++) {
        rotateKeys.add(gk1()); rotate();
        resetKeys.add(gk2()); reset();
      }
      expect(rotateKeys.size).toBe(3);
      expect(resetKeys.size).toBe(3);
    });
  });

  describe("URL / analytics safety", () => {
    it("key does not contain URL-unsafe characters", () => {
      const { getKey } = buildHook();
      const key = getKey();
      // Ensure the key contains no characters that would contaminate a URL or
      // analytics event string.
      expect(key).not.toContain("?");
      expect(key).not.toContain("&");
      expect(key).not.toContain("=");
      expect(key).not.toContain("#");
      expect(key).not.toContain("/");
      expect(key).not.toContain(" ");
    });

    it("key contains only printable ASCII (safe for HTTP headers)", () => {
      const { getKey } = buildHook();
      const key = getKey();
      // HTTP header values must be visible US-ASCII (0x21–0x7E) or SP.
      // Our key uses only [0-9a-f-] which satisfies this.
      expect(/^[\x21-\x7E]+$/.test(key)).toBe(true);
    });
  });

  describe("module exports", () => {
    it("exports useIdempotencyKey as a function", () => {
      expect(typeof useIdempotencyKey).toBe("function");
    });

    it("exports generateIdempotencyKey as a function", () => {
      expect(typeof generateIdempotencyKey).toBe("function");
    });

    it("useIdempotencyKey returns an object with getKey, rotate, and reset", () => {
      const handle = useIdempotencyKey();
      expect(typeof handle.getKey).toBe("function");
      expect(typeof handle.rotate).toBe("function");
      expect(typeof handle.reset).toBe("function");
    });
  });
});
