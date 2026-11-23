import { useState, useCallback, useRef } from "react";
import { isRetryable, getErrorCode } from "../utils/retryClassification";
import { getErrorMessage } from "../utils/errorMessages";

/**
 * Maximum number of retry attempts before the hook stops offering a retry
 * button and shows a terminal "max retries exceeded" message instead.
 */
export const MAX_RETRY_ATTEMPTS = 3;

/**
 * useRetry — bounded inline retry for data-fetching operations.
 *
 * Wraps an async fetch function and tracks:
 *   - Whether the last failure was retryable (transient) or permanent.
 *   - How many attempts have been made (capped at MAX_RETRY_ATTEMPTS).
 *   - The human-readable error message to display.
 *   - A `loading` flag for the duration of each attempt.
 *
 * Filter and scroll preservation:
 *   The `fetchFn` argument is looked up via a ref on every execute call, so
 *   the caller can pass a new closure (with up-to-date filter values) before
 *   calling execute and the hook will use it.  Because only the error banner
 *   changes in the DOM (the table/list behind it stays mounted), browser scroll
 *   position is preserved automatically.
 *
 * Usage:
 *   const { retryState, execute, reset } = useRetry(fetchFn);
 *
 *   // In your effect or event handler — replaces the old manual fetch call:
 *   execute();
 *
 *   // In JSX:
 *   <ErrorAlert retryState={retryState} onRetry={execute} loading={retryState.loading} />
 *
 * @param {() => Promise<any>} fetchFn - Async function to execute / retry.
 *        Updated on each render via a ref; always called with the latest closure.
 * @param {object}  [options]
 * @param {number}  [options.maxAttempts=MAX_RETRY_ATTEMPTS] - Hard cap on retries.
 * @returns {{
 *   retryState: {
 *     error:       string|null,  // Human-readable message, null when healthy.
 *     isRetryable: boolean,      // true → show retry button.
 *     attempts:    number,       // Failed attempts so far.
 *     exhausted:   boolean,      // true → max attempts reached.
 *     loading:     boolean,      // true while the fetch is in-flight.
 *   },
 *   execute: () => void,         // Run (or retry) fetchFn.
 *   reset:   () => void,         // Clear error state (e.g. when filters change).
 * }}
 */
export function useRetry(fetchFn, { maxAttempts = MAX_RETRY_ATTEMPTS } = {}) {
  const [retryState, setRetryState] = useState({
    error:       null,
    isRetryable: false,
    attempts:    0,
    exhausted:   false,
    loading:     false,
  });

  // Keep a stable ref to fetchFn so the execute callback doesn't need to be
  // recreated every time the caller's fetchFn reference changes (e.g. due to
  // inline arrow functions in effects or filter-change closures).
  const fetchFnRef = useRef(fetchFn);
  fetchFnRef.current = fetchFn;

  // Track the current attempt count in a ref so the execute callback captures
  // a stable closure while still reading the latest value.
  const attemptsRef = useRef(0);

  const execute = useCallback(() => {
    const currentAttempts = attemptsRef.current;

    // Guard: once exhausted, the button is hidden, but protect against stale
    // programmatic calls (e.g. SSE-triggered refetch after exhaustion).
    if (currentAttempts >= maxAttempts) return;

    setRetryState(prev => ({ ...prev, loading: true }));

    fetchFnRef.current().then(() => {
      // Success — clear all error state so the UI returns to a clean slate.
      attemptsRef.current = 0;
      setRetryState({ error: null, isRetryable: false, attempts: 0, exhausted: false, loading: false });
    }).catch((err) => {
      // Silently ignore aborted requests — the component is unmounting or a
      // newer fetch superseded this one.
      if (err?.name === "CanceledError" || err?.code === "ERR_CANCELED") {
        setRetryState(prev => ({ ...prev, loading: false }));
        return;
      }

      const nextAttempts = currentAttempts + 1;
      attemptsRef.current = nextAttempts;

      const canRetry  = isRetryable(err);
      const exhausted = nextAttempts >= maxAttempts;
      const code      = getErrorCode(err);
      const fallback  = err?.response?.data?.error || err?.message || null;

      // When max attempts are reached, show the MAX_RETRIES_EXCEEDED message
      // regardless of the underlying error to communicate a clear terminal state.
      const errorMsg = exhausted
        ? getErrorMessage("MAX_RETRIES_EXCEEDED")
        : getErrorMessage(code, fallback);

      setRetryState({
        error:       errorMsg,
        isRetryable: canRetry && !exhausted,
        attempts:    nextAttempts,
        exhausted,
        loading:     false,
      });
    });
  }, [maxAttempts]);

  const reset = useCallback(() => {
    attemptsRef.current = 0;
    setRetryState({ error: null, isRetryable: false, attempts: 0, exhausted: false, loading: false });
  }, []);

  return { retryState, execute, reset };
}
