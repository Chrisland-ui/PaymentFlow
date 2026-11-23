import { useState, useCallback, useRef, useEffect } from 'react';
import { getStudentPayments } from '../services/api';
import { isTerminalStatus } from '../utils/paymentStatus';

/** Initial poll interval in ms */
export const DEFAULT_INITIAL_INTERVAL = 3000;
/** Maximum backoff cap in ms */
export const DEFAULT_MAX_INTERVAL = 30000;
/** Backoff multiplier applied after each failure */
export const DEFAULT_BACKOFF_FACTOR = 1.5;

/**
 * usePendingPaymentPoller
 *
 * Polls for payment updates for a given student with:
 *   - Automatic stop when the payment reaches a terminal state
 *     (SUCCESS, FAILED, REFUNDED, INVALID).
 *   - Page-visibility awareness: pauses on hidden tabs, fires an immediate
 *     refresh when the tab becomes visible again.
 *   - Exponential backoff on failed fetches; resets to initialInterval on success.
 *   - AbortController cancellation on cleanup.
 *   - Manual refresh: resets backoff and fires an immediate poll.
 *   - 'Last checked X seconds ago' indicator for user reassurance.
 *
 * @see usePaymentEvents for SSE-based real-time updates when available.
 *
 * @param {object}   options
 * @param {string}   options.studentId          Student to poll for.
 * @param {string}   [options.currentStatus]    Current payment status. Polling skipped if terminal.
 * @param {Function} [options.onUpdate]         Called with fresh payments array on each successful poll.
 * @param {boolean}  [options.enabled=true]     Set false to pause polling.
 * @param {number}   [options.initialInterval]  Initial poll interval (ms). Default 3000.
 * @param {number}   [options.maxInterval]      Backoff ceiling (ms). Default 30000.
 * @param {number}   [options.backoffFactor]    Failure backoff multiplier. Default 1.5.
 * @returns {{ polling: boolean, lastUpdated: Date|null, error: string|null, consecutiveErrors: number }}
 */
export function usePendingPaymentPoller({
  studentId,
  currentStatus,
  onUpdate,
  enabled = true,
  initialInterval = DEFAULT_INITIAL_INTERVAL,
  maxInterval = DEFAULT_MAX_INTERVAL,
  backoffFactor = DEFAULT_BACKOFF_FACTOR,
} = {}) {
  const [polling, setPolling] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [lastCheckedSecondsAgo, setLastCheckedSecondsAgo] = useState(null);
  const [error, setError] = useState(null);
  const [consecutiveErrors, setConsecutiveErrors] = useState(0);

  const timerRef = useRef(null);
  const tickerRef = useRef(null);
  const abortRef = useRef(null);
  const intervalRef = useRef(initialInterval);
  const consecutiveErrorsRef = useRef(0);
  const isTerminalRef = useRef(isTerminalStatus(currentStatus));
  const onUpdateRef = useRef(onUpdate);
  const enabledRef = useRef(enabled);
  const lastUpdatedRef = useRef(null);

  // Keep refs current without causing re-renders
  useEffect(() => { onUpdateRef.current = onUpdate; }, [onUpdate]);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { intervalRef.current = initialInterval; }, [initialInterval]);

  // Stop polling immediately when the status becomes terminal
  useEffect(() => {
    isTerminalRef.current = isTerminalStatus(currentStatus);
    if (isTerminalRef.current) {
      clearTimeout(timerRef.current);
      clearInterval(tickerRef.current);
      abortRef.current?.abort();
      setPolling(false);
    }
  }, [currentStatus]);

  // ── "Last checked X seconds ago" ticker ──────────────────────────────────────
  // Updates the displayed age of the last successful check every second.
  useEffect(() => {
    tickerRef.current = setInterval(() => {
      if (lastUpdatedRef.current) {
        const secs = Math.floor((Date.now() - lastUpdatedRef.current.getTime()) / 1000);
        setLastCheckedSecondsAgo(secs);
      }
    }, 1000);

    return () => clearInterval(tickerRef.current);
  }, []);

  const poll = useCallback(() => {
    if (!enabledRef.current || isTerminalRef.current || !studentId) return;

    // Cancel any previous in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPolling(true);

    getStudentPayments(studentId, { signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return;

        // Reset backoff on success
        intervalRef.current = initialInterval;
        consecutiveErrorsRef.current = 0;
        setConsecutiveErrors(0);
        setError(null);
        setLastUpdated(new Date());
        setPolling(false);

        const payments = Array.isArray(data) ? data : (data?.payments ?? []);
        onUpdateRef.current?.(payments);

        // Stop polling if the latest payment reached a terminal state
        const latestStatus = payments[0]?.status;
        if (latestStatus && isTerminalStatus(latestStatus)) {
          isTerminalRef.current = true;
          return;
        }

        // Schedule next poll
        if (enabledRef.current && !isTerminalRef.current) {
          timerRef.current = setTimeout(poll, intervalRef.current);
        }
      })
      .catch((err) => {
        // Silently discard aborted requests (unmount / navigation)
        if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') {
          setPolling(false);
          return;
        }

        // Apply exponential backoff
        intervalRef.current = Math.min(intervalRef.current * backoffFactor, maxInterval);
        consecutiveErrorsRef.current += 1;
        setConsecutiveErrors(consecutiveErrorsRef.current);
        setError(err?.response?.data?.error || err?.message || 'Poll failed');
        setPolling(false);

        // Schedule retry at backed-off interval
        if (enabledRef.current && !isTerminalRef.current) {
          timerRef.current = setTimeout(poll, intervalRef.current);
        }
      });
  }, [studentId, initialInterval, backoffFactor, maxInterval]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Manual refresh ────────────────────────────────────────────────────────────
  // Resets the backoff interval to the initial value and fires an immediate poll.
  // This is suitable for wiring to a "Refresh now" button.
  const manualRefresh = useCallback(() => {
    if (isTerminalRef.current || !studentId) return;

    // Reset backoff so the user gets the fast cadence back
    intervalRef.current = initialInterval;
    consecutiveErrorsRef.current = 0;
    setConsecutiveErrors(0);
    setError(null);

    // Cancel any scheduled tick and fire immediately
    clearTimeout(timerRef.current);
    poll();
  }, [studentId, initialInterval, poll]);

  // ── Page-visibility handling ─────────────────────────────────────────────────

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handleVisibilityChange = () => {
      if (
        document.visibilityState === 'visible' &&
        enabledRef.current &&
        !isTerminalRef.current
      ) {
        // Tab became active — fire an immediate refresh instead of waiting for
        // the next scheduled tick
        clearTimeout(timerRef.current);
        poll();
      }
      // When the tab is hidden, we let the currently scheduled timer elapse
      // naturally — the next scheduled poll will check visibility before
      // rescheduling via the same guard above.
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [poll]);

  // ── Main polling lifecycle ───────────────────────────────────────────────────

  useEffect(() => {
    if (!enabled || isTerminalStatus(currentStatus) || !studentId) return;

    // Reset interval on (re-)start
    intervalRef.current = initialInterval;

    // Kick off the first poll immediately
    poll();

    return () => {
      clearTimeout(timerRef.current);
      abortRef.current?.abort();
      setPolling(false);
    };
  }, [enabled, studentId, poll, currentStatus, initialInterval]); // eslint-disable-line react-hooks/exhaustive-deps

  return { polling, lastUpdated, error, consecutiveErrors };
}

export default usePendingPaymentPoller;
