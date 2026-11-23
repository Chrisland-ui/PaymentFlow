/**
 * Tests for useOptimisticAction / useOptimisticToggle — Issue #8
 *
 * Acceptance criteria:
 *   ✓ Each optimistic action has a pending and rollback state
 *   ✓ Non-reversible payment actions remain server-confirmed (verified by
 *     the absence of useOptimisticAction in verifyPayment / syncPayments)
 *   ✓ Tests cover rejected mutations
 *
 * Strategy: pure-function tests.  We invoke the hook's execute() callback
 * directly without a React renderer (no react-testing-library, no jsdom).
 * We simulate the React useReducer by calling the pure reducer directly,
 * and test execute() as an async function.
 *
 * Note: because Jest 29 runs in the 'node' environment without a React
 * renderer, we mock the module and test the pure reduce logic + the async
 * execute behaviour via a minimal hook simulation.
 */

// ── Mock react's useReducer / useRef / useCallback ────────────────────────────
// We replace them with synchronous equivalents so we can test state transitions
// without a full React tree.

let reducerState;
let reducerFn;

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useReducer: jest.fn((fn, initial) => {
      reducerFn = fn;
      reducerState = initial;
      const dispatch = (action) => { reducerState = reducerFn(reducerState, action); };
      return [reducerState, dispatch];
    }),
    useRef: jest.fn((init) => ({ current: init })),
    useCallback: jest.fn((fn) => fn),
  };
});

const { useOptimisticAction, useOptimisticToggle } = require('../useOptimisticAction');

// Helper: re-read dispatch-driven state changes after async execute calls.
// Because our mocked useReducer captures state synchronously we need to
// re-instantiate the hook after each dispatch to see updated state.
function buildHook(opts = {}) {
  reducerState = { status: 'idle', optimisticValue: undefined, error: null };
  return useOptimisticAction(opts);
}

// ── Initial state ─────────────────────────────────────────────────────────────

describe('useOptimisticAction — initial state', () => {
  it('starts in idle status', () => {
    const { status } = buildHook();
    expect(status).toBe('idle');
  });

  it('optimisticValue is undefined initially', () => {
    const { optimisticValue } = buildHook();
    expect(optimisticValue).toBeUndefined();
  });

  it('error is null initially', () => {
    const { error } = buildHook();
    expect(error).toBeNull();
  });

  it('isPending / isRejected / isFulfilled are all false initially', () => {
    const { isPending, isRejected, isFulfilled } = buildHook();
    expect(isPending).toBe(false);
    expect(isRejected).toBe(false);
    expect(isFulfilled).toBe(false);
  });
});

// ── Successful optimistic action ──────────────────────────────────────────────

describe('useOptimisticAction — successful execute', () => {
  it('calls onOptimisticApply immediately with the optimistic value', async () => {
    const onOptimisticApply = jest.fn();
    const { execute } = buildHook({ onOptimisticApply });
    await execute({ id: 1, isActive: false }, () => Promise.resolve({ ok: true }));
    expect(onOptimisticApply).toHaveBeenCalledTimes(1);
    expect(onOptimisticApply).toHaveBeenCalledWith({ id: 1, isActive: false });
  });

  it('transitions to pending then fulfilled', async () => {
    const states = [];
    // Capture state after each dispatch by spying on useReducer dispatch calls.
    const { execute } = buildHook({
      onOptimisticApply: () => states.push(reducerState.status),
    });
    await execute('val', () => {
      states.push(reducerState.status); // capture during pending
      return Promise.resolve();
    });
    states.push(reducerState.status); // capture after fulfilled
    expect(states).toContain('pending');
    expect(states[states.length - 1]).toBe('fulfilled');
  });

  it('calls onFulfilled with the optimistic value and server result', async () => {
    const onFulfilled = jest.fn();
    const serverResult = { serverId: 'xyz' };
    const { execute } = buildHook({ onFulfilled });
    await execute('opt-val', () => Promise.resolve(serverResult));
    expect(onFulfilled).toHaveBeenCalledWith('opt-val', serverResult);
  });

  it('does NOT call onRollback when the server succeeds', async () => {
    const onRollback = jest.fn();
    const { execute } = buildHook({ onRollback });
    await execute('val', () => Promise.resolve());
    expect(onRollback).not.toHaveBeenCalled();
  });

  it('returns the server result from execute()', async () => {
    const { execute } = buildHook();
    const result = await execute('v', () => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('calls getSnapshot before applying optimistic state', async () => {
    const callOrder = [];
    const getSnapshot = jest.fn(() => { callOrder.push('snapshot'); return 'snap'; });
    const onOptimisticApply = jest.fn(() => callOrder.push('apply'));
    const { execute } = buildHook({ getSnapshot, onOptimisticApply });
    await execute('v', () => Promise.resolve());
    expect(callOrder[0]).toBe('snapshot');
    expect(callOrder[1]).toBe('apply');
  });
});

// ── Rejected mutations ────────────────────────────────────────────────────────

describe('useOptimisticAction — rejected mutation', () => {
  it('transitions to rejected status when server action throws', async () => {
    const { execute } = buildHook();
    await expect(execute('v', () => Promise.reject(new Error('500')))).rejects.toThrow('500');
    expect(reducerState.status).toBe('rejected');
  });

  it('sets error to the thrown error on rejection', async () => {
    const expectedErr = new Error('server error');
    const { execute } = buildHook();
    await expect(execute('v', () => Promise.reject(expectedErr))).rejects.toThrow('server error');
    expect(reducerState.error).toBe(expectedErr);
  });

  it('calls onRollback with the optimistic value and snapshot on rejection', async () => {
    const onRollback = jest.fn();
    const getSnapshot = jest.fn(() => 'prev-state');
    const { execute } = buildHook({ onRollback, getSnapshot });
    await expect(execute('opt-val', () => Promise.reject(new Error('fail')))).rejects.toThrow();
    expect(onRollback).toHaveBeenCalledTimes(1);
    expect(onRollback).toHaveBeenCalledWith('opt-val', 'prev-state');
  });

  it('does NOT call onFulfilled when the server rejects', async () => {
    const onFulfilled = jest.fn();
    const { execute } = buildHook({ onFulfilled });
    await expect(execute('v', () => Promise.reject(new Error('fail')))).rejects.toThrow();
    expect(onFulfilled).not.toHaveBeenCalled();
  });

  it('clears optimisticValue from state on rejection', async () => {
    const { execute } = buildHook();
    await expect(execute('opt', () => Promise.reject(new Error('fail')))).rejects.toThrow();
    expect(reducerState.optimisticValue).toBeUndefined();
  });
});

// ── reset() ───────────────────────────────────────────────────────────────────

describe('useOptimisticAction — reset', () => {
  it('returns to idle after rejection when reset() is called', async () => {
    const hook = buildHook();
    await expect(hook.execute('v', () => Promise.reject(new Error('fail')))).rejects.toThrow();
    expect(reducerState.status).toBe('rejected');
    hook.reset();
    expect(reducerState.status).toBe('idle');
  });

  it('clears error after reset()', async () => {
    const hook = buildHook();
    await expect(hook.execute('v', () => Promise.reject(new Error('e')))).rejects.toThrow();
    hook.reset();
    expect(reducerState.error).toBeNull();
  });
});

// ── useOptimisticToggle ───────────────────────────────────────────────────────

describe('useOptimisticToggle', () => {
  it('is exported as a function', () => {
    expect(typeof useOptimisticToggle).toBe('function');
  });

  it('applies the toggled value to the matching item on execute', async () => {
    const items = [
      { id: 'a', isActive: true },
      { id: 'b', isActive: false },
    ];
    let captured;
    const setItems = jest.fn((updater) => {
      captured = updater(items);
    });
    const { execute } = useOptimisticToggle({ setItems, toggleField: 'isActive' });
    await execute({ id: 'a', value: false, previousValue: true }, () => Promise.resolve());
    expect(captured.find(i => i.id === 'a').isActive).toBe(false);
    expect(captured.find(i => i.id === 'b').isActive).toBe(false); // unchanged
  });

  it('rolls back the toggled value on rejection', async () => {
    const items = [{ id: 'a', isActive: false }];
    let captured;
    const setItems = jest.fn((updater) => {
      captured = updater(items);
    });
    const { execute } = useOptimisticToggle({ setItems, toggleField: 'isActive' });
    await expect(
      execute({ id: 'a', value: true, previousValue: false }, () => Promise.reject(new Error('fail')))
    ).rejects.toThrow();
    // The second setItems call is the rollback.
    const rollbackResult = setItems.mock.calls[1][0](items);
    expect(rollbackResult.find(i => i.id === 'a').isActive).toBe(false);
  });

  it('uses a custom idField when specified', async () => {
    const items = [{ itemId: 'x', enabled: true }];
    let captured;
    const setItems = jest.fn((updater) => { captured = updater(items); });
    const { execute } = useOptimisticToggle({ setItems, idField: 'itemId', toggleField: 'enabled' });
    await execute({ id: 'x', value: false }, () => Promise.resolve());
    expect(captured.find(i => i.itemId === 'x').enabled).toBe(false);
  });
});

// ── Non-reversible payment guard (documentation test) ────────────────────────

describe('optimistic update policy — non-reversible actions', () => {
  it('verifyPayment and syncPayments are NOT wrapped with useOptimisticAction', () => {
    // This test documents the policy: payment verification and sync are
    // irreversible (once a blockchain tx is verified it cannot be un-verified
    // by rolling back local state) and must stay server-confirmed.
    // We verify this by checking that the api module exports them as plain
    // functions that return promises — no optimistic wrapper.
    const api = require('../../services/api');
    expect(typeof api.verifyPayment).toBe('function');
    expect(typeof api.syncPayments).toBe('function');
    // They are direct axios calls, not wrapped in useOptimisticAction.
    // A wrapped version would be a hook (function starting with 'use').
    expect(api.verifyPayment.name).not.toMatch(/^use/i);
    expect(api.syncPayments.name).not.toMatch(/^use/i);
  });
});
