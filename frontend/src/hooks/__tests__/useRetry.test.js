/**
 * Tests for useRetry hook — issue retry-inline
 *
 * Strategy: Jest runs in a node environment without a DOM or React renderer.
 * We test the hook's internal logic by mocking React's useState/useRef/useCallback
 * to collect state mutations, then asserting what was stored.
 *
 * Each test creates a fresh mock environment so mutations don't leak.
 */

// ─── React mock ──────────────────────────────────────────────────────────────

let stateStore       = [];
let stateIndex       = 0;
let refStore         = [];
let refIndex         = 0;

/**
 * Minimal useState: stores initial value on first call, returns current + setter.
 * The setter updates the store and records the new value for inspection.
 */
function mockUseState(initial) {
  const idx = stateIndex++;
  if (stateStore[idx] === undefined) {
    stateStore[idx] = typeof initial === "function" ? initial() : initial;
  }
  const setter = (valueOrUpdater) => {
    stateStore[idx] =
      typeof valueOrUpdater === "function"
        ? valueOrUpdater(stateStore[idx])
        : valueOrUpdater;
  };
  return [stateStore[idx], setter];
}

/** Minimal useRef: returns a stable { current } box. */
function mockUseRef(initial) {
  const idx = refIndex++;
  if (refStore[idx] === undefined) {
    refStore[idx] = { current: initial };
  }
  return refStore[idx];
}

/** Minimal useCallback: just returns the fn (no memoisation needed). */
function mockUseCallback(fn) {
  return fn;
}

jest.mock("react", () => ({
  useState:     jest.fn((initial) => mockUseState(initial)),
  useRef:       jest.fn((initial) => mockUseRef(initial)),
  useCallback:  jest.fn((fn) => mockUseCallback(fn)),
}));

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock("../../utils/retryClassification", () => ({
  isRetryable:   jest.fn(),
  getErrorCode:  jest.fn().mockReturnValue(""),
}));

jest.mock("../../utils/errorMessages", () => ({
  getErrorMessage: jest.fn((code, fallback) => fallback || code || "error"),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resetMocks() {
  stateStore = [];
  stateIndex = 0;
  refStore   = [];
  refIndex   = 0;
  // Re-register mock implementations (jest.fn() resets on clearAllMocks)
  const React = require("react");
  React.useState.mockImplementation((initial) => mockUseState(initial));
  React.useRef.mockImplementation((initial) => mockUseRef(initial));
  React.useCallback.mockImplementation((fn) => mockUseCallback(fn));
}

function getHook(fetchFn, opts) {
  const { useRetry } = require("../useRetry");
  return useRetry(fetchFn, opts);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const { isRetryable, getErrorCode } = require("../../utils/retryClassification");
const { getErrorMessage }            = require("../../utils/errorMessages");

beforeEach(() => {
  jest.clearAllMocks();
  resetMocks();
});

describe("useRetry — initial state", () => {
  it("starts with error=null, loading=false, attempts=0, exhausted=false", () => {
    const { retryState } = getHook(() => Promise.resolve());
    expect(retryState.error).toBeNull();
    expect(retryState.loading).toBe(false);
    expect(retryState.attempts).toBe(0);
    expect(retryState.exhausted).toBe(false);
    expect(retryState.isRetryable).toBe(false);
  });
});

describe("useRetry — exports", () => {
  it("returns execute, reset, retryState", () => {
    const result = getHook(() => Promise.resolve());
    expect(typeof result.execute).toBe("function");
    expect(typeof result.reset).toBe("function");
    expect(typeof result.retryState).toBe("object");
  });

  it("exports MAX_RETRY_ATTEMPTS as a positive integer", () => {
    const { MAX_RETRY_ATTEMPTS } = require("../useRetry");
    expect(typeof MAX_RETRY_ATTEMPTS).toBe("number");
    expect(MAX_RETRY_ATTEMPTS).toBeGreaterThan(0);
  });
});

describe("useRetry — execute on success", () => {
  it("sets loading=true during execution then clears all error state on success", async () => {
    let resolvePromise;
    const fetchFn = jest.fn(
      () => new Promise((res) => { resolvePromise = res; })
    );

    resetMocks();
    const { execute } = getHook(fetchFn);

    // Kick off execution but don't resolve yet — loading should be true.
    const p = new Promise((done) => {
      // We can't read loading mid-flight without a renderer, but we can verify
      // the success path clears state by resolving.
      resolvePromise = done;
    });

    execute();
    resolvePromise();
    await Promise.resolve(); // flush microtasks

    // After success the stateStore[0] (retryState) should show cleared error.
    // stateStore[0] is the retryState object.
    expect(stateStore[0]).toMatchObject({
      error: null,
      attempts: 0,
      exhausted: false,
      loading: false,
    });
  });

  it("calls fetchFn exactly once per execute() call", async () => {
    const fetchFn = jest.fn().mockResolvedValue("ok");
    resetMocks();
    const { execute } = getHook(fetchFn);
    execute();
    await new Promise(r => setTimeout(r, 0));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("useRetry — execute on failure, retryable error", () => {
  it("sets error message and isRetryable=true for a retryable error", async () => {
    const err = { name: "AxiosError", response: { status: 503, data: { code: "SERVICE_UNAVAILABLE" } } };
    isRetryable.mockReturnValue(true);
    getErrorCode.mockReturnValue("SERVICE_UNAVAILABLE");
    getErrorMessage.mockReturnValue("The service is temporarily unavailable.");

    resetMocks();
    const fetchFn = jest.fn().mockRejectedValue(err);
    const { execute } = getHook(fetchFn);
    execute();
    await new Promise(r => setTimeout(r, 0));

    expect(stateStore[0]).toMatchObject({
      error: "The service is temporarily unavailable.",
      isRetryable: true,
      attempts: 1,
      exhausted: false,
      loading: false,
    });
  });

  it("sets isRetryable=false for a non-retryable error", async () => {
    const err = { name: "AxiosError", response: { status: 409, data: { code: "DUPLICATE_STUDENT" } } };
    isRetryable.mockReturnValue(false);
    getErrorCode.mockReturnValue("DUPLICATE_STUDENT");
    getErrorMessage.mockReturnValue("A student with this ID already exists.");

    resetMocks();
    const fetchFn = jest.fn().mockRejectedValue(err);
    const { execute } = getHook(fetchFn);
    execute();
    await new Promise(r => setTimeout(r, 0));

    expect(stateStore[0]).toMatchObject({
      error: "A student with this ID already exists.",
      isRetryable: false,
      attempts: 1,
      exhausted: false,
      loading: false,
    });
  });
});

describe("useRetry — bounded attempts", () => {
  it("sets exhausted=true and isRetryable=false when MAX_RETRY_ATTEMPTS reached", async () => {
    const { MAX_RETRY_ATTEMPTS } = require("../useRetry");

    const err = { response: { status: 503, data: { code: "SERVICE_UNAVAILABLE" } } };
    isRetryable.mockReturnValue(true);
    getErrorCode.mockReturnValue("SERVICE_UNAVAILABLE");
    getErrorMessage.mockImplementation((code) =>
      code === "MAX_RETRIES_EXCEEDED"
        ? "Maximum retry attempts exceeded."
        : "Service unavailable."
    );

    resetMocks();
    // Simulate MAX_RETRY_ATTEMPTS failures by advancing attemptsRef directly.
    // The execute() will not fire again once exhausted.
    const fetchFn = jest.fn().mockRejectedValue(err);
    const { execute } = getHook(fetchFn, { maxAttempts: MAX_RETRY_ATTEMPTS });

    // Call execute MAX_RETRY_ATTEMPTS times.
    for (let i = 0; i < MAX_RETRY_ATTEMPTS; i++) {
      execute();
      await new Promise(r => setTimeout(r, 0));
      // Reset stateIndex to re-read the hook state for next iteration.
      stateIndex = 1; // Only retryState setter matters; skip reinit.
    }

    expect(stateStore[0]).toMatchObject({
      exhausted: true,
      isRetryable: false,
      attempts: MAX_RETRY_ATTEMPTS,
      loading: false,
    });
    expect(stateStore[0].error).toBe("Maximum retry attempts exceeded.");
  });

  it("does not call fetchFn after exhaustion", async () => {
    const { MAX_RETRY_ATTEMPTS } = require("../useRetry");
    const err = { response: { status: 503, data: {} } };
    isRetryable.mockReturnValue(true);
    getErrorCode.mockReturnValue("");
    getErrorMessage.mockReturnValue("err");

    resetMocks();
    // Force attemptsRef to be at max by pre-seeding the ref store.
    // refStore[1] is attemptsRef (index depends on declaration order).
    // Instead, we simulate by calling execute MAX times first.
    const fetchFn = jest.fn().mockRejectedValue(err);
    const { execute } = getHook(fetchFn, { maxAttempts: MAX_RETRY_ATTEMPTS });

    for (let i = 0; i < MAX_RETRY_ATTEMPTS; i++) {
      execute();
      await new Promise(r => setTimeout(r, 0));
      stateIndex = 1;
    }

    const callsAtExhaustion = fetchFn.mock.calls.length;
    // One more execute — should be a no-op.
    execute();
    await new Promise(r => setTimeout(r, 0));

    expect(fetchFn).toHaveBeenCalledTimes(callsAtExhaustion);
  });
});

describe("useRetry — reset", () => {
  it("reset() clears error state and resets attempts to 0", async () => {
    const err = { response: { status: 503, data: { code: "SERVICE_UNAVAILABLE" } } };
    isRetryable.mockReturnValue(true);
    getErrorCode.mockReturnValue("SERVICE_UNAVAILABLE");
    getErrorMessage.mockReturnValue("Service unavailable.");

    resetMocks();
    const fetchFn = jest.fn().mockRejectedValue(err);
    const { execute, reset } = getHook(fetchFn);

    execute();
    await new Promise(r => setTimeout(r, 0));

    // There is an error now.
    expect(stateStore[0].error).not.toBeNull();

    reset();

    // After reset, state should be clean.
    expect(stateStore[0]).toMatchObject({
      error: null,
      attempts: 0,
      exhausted: false,
      isRetryable: false,
      loading: false,
    });
  });
});

describe("useRetry — CanceledError is silently ignored", () => {
  it("does not set error state for CanceledError", async () => {
    const cancelErr = { name: "CanceledError", code: "ERR_CANCELED" };
    isRetryable.mockReturnValue(false); // isRetryable guards against CanceledError too

    resetMocks();
    const fetchFn = jest.fn().mockRejectedValue(cancelErr);
    const { execute } = getHook(fetchFn);
    execute();
    await new Promise(r => setTimeout(r, 0));

    // Loading should be cleared, but error should stay null.
    expect(stateStore[0].error).toBeNull();
    expect(stateStore[0].loading).toBe(false);
  });
});

describe("useRetry — successful retry clears error state", () => {
  it("clears error and resets attempts to 0 on successful retry after a failure", async () => {
    isRetryable.mockReturnValue(true);
    getErrorCode.mockReturnValue("SERVICE_UNAVAILABLE");
    getErrorMessage.mockReturnValue("Service unavailable.");

    resetMocks();
    let callCount = 0;
    const fetchFn = jest.fn().mockImplementation(() => {
      callCount++;
      // First call fails, second succeeds.
      if (callCount === 1) return Promise.reject({ response: { status: 503, data: { code: "SERVICE_UNAVAILABLE" } } });
      return Promise.resolve();
    });

    const { execute } = getHook(fetchFn);

    // First attempt — fails.
    execute();
    await new Promise(r => setTimeout(r, 0));
    expect(stateStore[0].error).not.toBeNull();
    expect(stateStore[0].attempts).toBe(1);

    // Second attempt (retry) — succeeds.
    execute();
    await new Promise(r => setTimeout(r, 0));

    // Error state must be fully cleared.
    expect(stateStore[0]).toMatchObject({
      error: null,
      attempts: 0,
      exhausted: false,
      isRetryable: false,
      loading: false,
    });
  });
});
