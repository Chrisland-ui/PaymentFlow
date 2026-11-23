/**
 * useAbortController — Issue #254
 *
 * Returns a stable AbortController whose signal is automatically aborted
 * when the component unmounts.  A new controller is created on each mount,
 * so re-mounting the component starts fresh with a live signal.
 *
 * Difference from useRouteChangeAbort
 * ────────────────────────────────────
 * useRouteChangeAbort (Issue #6) is designed for page-level components: it
 * aborts on both Next.js routeChangeStart events *and* unmount, which is the
 * right behaviour for top-level data-fetching effects on a page.
 *
 * useAbortController is the simpler primitive for components or hooks that
 * only need unmount-time cancellation — it does not listen to router events
 * and therefore has no dependency on next/router.  It is the right choice for:
 *   • Page components that fetch data in a single useEffect on mount
 *   • Hooks that issue one-shot requests (e.g. dispute list, fee list)
 *   • Any fetch that should be cancelled when the component is removed
 *     from the tree, regardless of how the navigation was triggered
 *
 * Usage
 * ─────
 *   const { signal } = useAbortController();
 *
 *   useEffect(() => {
 *     getDisputes({ signal })
 *       .then(({ data }) => setDisputes(data.disputes))
 *       .catch((err) => {
 *         if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
 *         setError(t('disputes.failedToLoad'));
 *       });
 *   }, [signal]);
 *
 * The signal reference is stable for the lifetime of the component — it only
 * changes if the component unmounts and remounts (at which point a fresh
 * AbortController is created).
 *
 * @returns {{ controller: AbortController, signal: AbortSignal }}
 */

import { useEffect, useRef } from 'react';

export function useAbortController() {
  const controllerRef = useRef(null);

  // Create a new controller on every mount.
  if (controllerRef.current === null) {
    controllerRef.current = new AbortController();
  }

  useEffect(() => {
    // Ensure the ref holds a live (non-aborted) controller on mount.
    // This guards against the edge case where React StrictMode double-invokes
    // effects: the first cleanup aborts the initial controller, so we issue a
    // fresh one before the second effect run.
    if (controllerRef.current.signal.aborted) {
      controllerRef.current = new AbortController();
    }

    return () => {
      // Abort all in-flight requests when the component unmounts.
      controllerRef.current.abort();
      // Reset to null so the next mount creates a new controller.
      controllerRef.current = null;
    };
  }, []); // run only on mount/unmount

  return {
    controller: controllerRef.current,
    signal: controllerRef.current?.signal ?? new AbortController().signal,
  };
}
