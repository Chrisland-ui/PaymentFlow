/**
 * useOnlineStatus
 *
 * Tracks the browser's network connectivity state using the
 * navigator.onLine API and the window online/offline events.
 *
 * Issue #269: Offline banner appears within 1 second of losing connectivity,
 * banner disappears and data refreshes automatically on reconnect.
 *
 * @returns {{
 *   isOnline: boolean,       — current connectivity state
 *   justReconnected: boolean — true for one tick after going from offline→online
 *                             (lets callers trigger a data refresh exactly once)
 * }}
 *
 * Usage:
 *   const { isOnline, justReconnected } = useOnlineStatus();
 *
 *   useEffect(() => {
 *     if (justReconnected) fetchData();
 *   }, [justReconnected]);
 */
import { useState, useEffect, useRef } from "react";

export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [justReconnected, setJustReconnected] = useState(false);
  // Track whether we were previously offline so we only fire justReconnected
  // when the transition is offline → online (not on the initial mount).
  const wasOfflineRef = useRef(false);

  useEffect(() => {
    function handleOnline() {
      setIsOnline(true);
      if (wasOfflineRef.current) {
        setJustReconnected(true);
        wasOfflineRef.current = false;
      }
    }

    function handleOffline() {
      setIsOnline(false);
      wasOfflineRef.current = true;
      setJustReconnected(false);
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Reset justReconnected after one render cycle so the caller's useEffect
  // with [justReconnected] fires once and stops looping.
  useEffect(() => {
    if (justReconnected) {
      const id = setTimeout(() => setJustReconnected(false), 0);
      return () => clearTimeout(id);
    }
  }, [justReconnected]);

  return { isOnline, justReconnected };
}
