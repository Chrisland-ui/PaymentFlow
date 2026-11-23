/**
 * useOptimisticAction — Issue #8
 *
 * A minimal, composable hook that implements an optimistic-update policy for
 * reversible, idempotent UI actions.
 *
 * Design rationale
 * ────────────────
 * Optimistic updates are only safe for actions that:
 *   1. Are reversible (we can undo the local state change if the server rejects
 *      it), AND
 *   2. Are idempotent (re-submitting on transient failure does not duplicate the
 *      effect).
 *
 * Non-reversible payment actions (e.g. verifyPayment, syncPayments) must remain
 * server-confirmed and MUST NOT use this hook.  A clear comment in those call
 * sites explains why.
 *
 * State machine for each action invocation
 * ─────────────────────────────────────────
 *   idle  →  pending  →  fulfilled  (server confirmed, optimistic state sticks)
 *                    ↘  rejected   (server rejected, optimistic state rolled back)
 *
 * The hook exposes:
 *   - status: 'idle' | 'pending' | 'fulfilled' | 'rejected'
 *   - optimisticValue: the value applied locally before server confirmation
 *   - error: the rejection error (null otherwise)
 *   - execute(optimisticValue, serverAction): trigger the optimistic update
 *   - reset(): return to 'idle' (useful for retrying after rejection)
 *
 * Usage example (toggling a fee-adjustment rule's isActive flag):
 *
 *   const { status, execute } = useOptimisticAction({
 *     onOptimisticApply: (v) => setRules(prev => prev.map(r => r.id === v.id ? { ...r, isActive: v.isActive } : r)),
 *     onRollback:        (_, prev) => setRules(prev),
 *   });
 *
 *   // In the button handler:
 *   execute(
 *     { id: rule.id, isActive: !rule.isActive },   // optimistic value
 *     () => updateFeeAdjustmentRule(rule.id, { isActive: !rule.isActive }, schoolId)
 *   );
 */
import { useCallback, useReducer, useRef } from 'react';

// ── State machine ─────────────────────────────────────────────────────────────

const INITIAL = { status: 'idle', optimisticValue: undefined, error: null };

function reducer(state, action) {
  switch (action.type) {
    case 'PENDING':
      return { status: 'pending', optimisticValue: action.payload, error: null };
    case 'FULFILLED':
      return { ...state, status: 'fulfilled', error: null };
    case 'REJECTED':
      return { status: 'rejected', optimisticValue: undefined, error: action.payload };
    case 'RESET':
      return INITIAL;
    default:
      return state;
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * @param {object}   opts
 * @param {Function} opts.onOptimisticApply   (optimisticValue) => void
 *   Called immediately on execute() — apply the optimistic local state.
 * @param {Function} opts.onRollback          (optimisticValue, prevSnapshot) => void
 *   Called when the server rejects — undo the optimistic local state.
 * @param {Function} [opts.onFulfilled]       (optimisticValue, serverResult) => void
 *   Optional: called when the server confirms.  Use to sync the local state
 *   with any server-returned data (e.g. updated timestamps).
 * @param {Function} [opts.getSnapshot]       () => any
 *   Optional: called before onOptimisticApply to capture a snapshot of current
 *   state for rollback.  If omitted, prevSnapshot in onRollback will be undefined.
 */
export function useOptimisticAction({
  onOptimisticApply,
  onRollback,
  onFulfilled,
  getSnapshot,
} = {}) {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  // Holds the pre-optimistic snapshot for rollback.
  const snapshotRef = useRef(undefined);
  // Holds the optimistic value so onRollback can receive it even after dispatch.
  const optimisticValueRef = useRef(undefined);

  /**
   * Trigger an optimistic update.
   *
   * @param {any}      optimisticValue  The value to apply locally right now.
   * @param {Function} serverAction     () => Promise  The actual API call.
   * @returns {Promise<any>}  Resolves with the server result; rejects on error.
   */
  const execute = useCallback(async (optimisticValue, serverAction) => {
    // Capture snapshot before mutating local state.
    snapshotRef.current = getSnapshot?.();
    optimisticValueRef.current = optimisticValue;

    // 1. Apply optimistic local state immediately.
    onOptimisticApply?.(optimisticValue);
    dispatch({ type: 'PENDING', payload: optimisticValue });

    try {
      // 2. Call the server.
      const result = await serverAction();
      dispatch({ type: 'FULFILLED' });
      onFulfilled?.(optimisticValue, result);
      return result;
    } catch (err) {
      // 3. Server rejected — roll back local state.
      dispatch({ type: 'REJECTED', payload: err });
      onRollback?.(optimisticValueRef.current, snapshotRef.current);
      throw err;
    }
  }, [onOptimisticApply, onRollback, onFulfilled, getSnapshot]);

  const reset = useCallback(() => {
    dispatch({ type: 'RESET' });
  }, []);

  return {
    status: state.status,
    optimisticValue: state.optimisticValue,
    error: state.error,
    isPending:   state.status === 'pending',
    isRejected:  state.status === 'rejected',
    isFulfilled: state.status === 'fulfilled',
    execute,
    reset,
  };
}

// ── Convenience: useOptimisticToggle ──────────────────────────────────────────

/**
 * Convenience wrapper for the common boolean-toggle pattern.
 *
 * Optimistically flips a boolean field on an item inside an array, then
 * rolls back if the server rejects.
 *
 * @param {object}   opts
 * @param {Function} opts.setItems   React state setter for the item array
 * @param {string}   opts.idField    Name of the unique-ID field (default: 'id')
 * @param {string}   opts.toggleField Name of the boolean field to flip
 * @returns {{ execute, status, error, isPending, isRejected, isFulfilled, reset }}
 */
export function useOptimisticToggle({ setItems, idField = 'id', toggleField }) {
  return useOptimisticAction({
    getSnapshot: () => {
      // We cannot capture the current items array here without a ref; callers
      // that need precise rollback should use useOptimisticAction directly and
      // provide getSnapshot.  This wrapper relies on onRollback receiving the
      // snapshot captured at call time.
      return undefined;
    },
    onOptimisticApply: ({ id, value }) => {
      setItems(prev =>
        prev.map(item =>
          item[idField] === id
            ? { ...item, [toggleField]: value }
            : item
        )
      );
    },
    onRollback: ({ id, previousValue }) => {
      setItems(prev =>
        prev.map(item =>
          item[idField] === id
            ? { ...item, [toggleField]: previousValue }
            : item
        )
      );
    },
  });
}
