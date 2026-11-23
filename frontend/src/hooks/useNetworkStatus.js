/**
 * useNetworkStatus — Issue #21
 *
 * Detects browser online/offline transitions using the Navigator Network
 * Information API and the window 'online'/'offline' events.
 *
 * Returns:
 *   isOnline   {boolean} — true when the browser reports connectivity.
 *   wasOffline {boolean} — true after the browser goes offline and stays true
 *                          for 3 s after coming back online. This lets the UI
 *                          show a "back online" confirmation and a stale-state
 *                          warning without immediately hiding it.
 *
 * SSR-safe: returns { isOnline: true, wasOffline: false } during server-side
 * rendering where window is not available.
 */
import { useState, useEffect, useRef } from 'react';

/** How long (ms) wasOffline stays true after reconnection. */
const BACK_ONLINE_LINGER_MS = 3000;

/**
 * @returns {{ isOnline: boolean, wasOffline: boolean }}
 */
export function useNetworkStatus() {
  const isSSR = typeof window === 'undefined';

  const [isOnline, setIsOnline]     = useState(isSSR ? true : navigator.onLine);
  const [wasOffline, setWasOffline] = useState(false);

  // Tracks whether we've ever gone offline in this session.
  const wentOfflineRef = useRef(false);
  // Timer ref so we can cancel the linger timeout on unmount.
  const lingerTimerRef = useRef(null);

  useEffect(() => {
    if (isSSR) return;

    function handleOffline() {
      wentOfflineRef.current = true;
      setIsOnline(false);
      setWasOffline(true);
      // Cancel any pending linger timer from a previous reconnection.
      if (lingerTimerRef.current) {
        clearTimeout(lingerTimerRef.current);
        lingerTimerRef.current = null;
      }
    }

    function handleOnline() {
      setIsOnline(true);
      // wasOffline stays true for BACK_ONLINE_LINGER_MS so the UI can show a
      // "back online" message before clearing it.
      if (wentOfflineRef.current) {
        lingerTimerRef.current = setTimeout(() => {
          setWasOffline(false);
          lingerTimerRef.current = null;
        }, BACK_ONLINE_LINGER_MS);
      }
    }

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      if (lingerTimerRef.current) clearTimeout(lingerTimerRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { isOnline, wasOffline };
}
