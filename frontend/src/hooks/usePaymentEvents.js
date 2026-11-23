import { useState, useEffect, useRef, useCallback } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';

// After this many consecutive closed-connection errors we stop retrying and
// surface a 'failed' status so the UI can prompt the user to refresh.
const MAX_RETRIES = 5;

/**
 * usePaymentEvents
 *
 * Connects to the backend SSE endpoint and surfaces:
 *   - `degraded`          (boolean) — true when the backend has signalled that
 *                                      Redis pub/sub is unavailable (Issue #1054).
 *   - `connectionStatus`  (string)  — 'connected' | 'reconnecting' | 'failed'.
 *                                      'reconnecting' while back-off retries are
 *                                      in flight; 'failed' after MAX_RETRIES
 *                                      consecutive failures with no successful open.
 *   - `onEvent`           (function) — optional per-event callback, receives (type, data).
 *
 * The hook handles:
 *   - Automatic reconnect with exponential back-off (1 s → 2 s → … → 30 s cap).
 *   - After MAX_RETRIES the connection is abandoned and status becomes 'failed'.
 *   - Resetting the degraded flag on an `sse.recovered` event.
 *   - Cleanup on unmount.
 *
 * @param {object}   options
 * @param {boolean}  [options.enabled=true]  - Set false to skip connecting (e.g. unauthenticated pages).
 * @param {Function} [options.onEvent]        - Called with (eventType, data) for every non-system event.
 * @returns {{ degraded: boolean, connectionStatus: 'connected'|'reconnecting'|'failed' }}
 *
 * @see usePendingPaymentPoller for polling-based updates when SSE is unavailable.
 */
export function usePaymentEvents({ enabled = true, onEvent } = {}) {
  const [degraded, setDegraded] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('connected');
  const esRef = useRef(null);
  const retryRef = useRef(null);
  const retryDelayRef = useRef(1000);
  const retryCountRef = useRef(0);
  const onEventRef = useRef(onEvent);

  // Keep the callback ref current without re-connecting the stream.
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const connect = useCallback(() => {
    if (typeof window === 'undefined') return;

    const schoolId = localStorage.getItem('schoolId');
    if (!schoolId) return;

    const url = `${API_URL}/payments/events?schoolId=${encodeURIComponent(schoolId)}`;
    const es = new EventSource(url, { withCredentials: true });
    esRef.current = es;

    // ── System events (Issue #1054) ──────────────────────────────────────────

    es.addEventListener('sse.degraded', () => {
      setDegraded(true);
    });

    es.addEventListener('sse.recovered', () => {
      setDegraded(false);
    });

    // ── Domain events ────────────────────────────────────────────────────────

    es.addEventListener('payment', (e) => {
      try {
        const data = JSON.parse(e.data);
        onEventRef.current?.('payment', data);
      } catch { /* malformed — ignore */ }
    });

    es.addEventListener('dispute.created', (e) => {
      try {
        const data = JSON.parse(e.data);
        onEventRef.current?.('dispute.created', data);
      } catch { /* malformed — ignore */ }
    });

    es.addEventListener('dispute.updated', (e) => {
      try {
        const data = JSON.parse(e.data);
        onEventRef.current?.('dispute.updated', data);
      } catch { /* malformed — ignore */ }
    });

    // ── Connection lifecycle ──────────────────────────────────────────────────

    es.addEventListener('error', () => {
      // EventSource handles its own reconnect for transient drops (readyState
      // goes to CONNECTING). We only schedule a manual retry when the browser
      // gives up (readyState === EventSource.CLOSED).
      if (es.readyState === EventSource.CLOSED) {
        esRef.current = null;
        es.close();

        retryCountRef.current += 1;

        if (retryCountRef.current > MAX_RETRIES) {
          // Give up — tell the UI to prompt the user to refresh.
          setConnectionStatus('failed');
          return;
        }

        setConnectionStatus('reconnecting');
        const delay = retryDelayRef.current;
        retryDelayRef.current = Math.min(delay * 2, 30000);
        retryRef.current = setTimeout(connect, delay);
      }
    });

    // Reset back-off counters on a successful open.
    es.addEventListener('open', () => {
      retryDelayRef.current = 1000;
      retryCountRef.current = 0;
      setConnectionStatus('connected');
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!enabled) return;

    connect();

    return () => {
      clearTimeout(retryRef.current);
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [enabled, connect]);

  return { degraded, connectionStatus };
}
