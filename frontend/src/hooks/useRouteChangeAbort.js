/**
 * useRouteChangeAbort — Issue #6
 *
 * Provides an AbortController whose signal is automatically aborted when:
 *   1. The Next.js router begins navigating to a different route
 *      (routeChangeStart event), OR
 *   2. The component unmounts.
 *
 * A new AbortController is created for each navigation cycle, so re-mounting
 * the same page after back-navigation starts fresh with a live signal.
 *
 * Design rationale
 * ────────────────
 * Slow API calls can complete after the user has already navigated away.
 * Without cancellation this causes two problems:
 *
 *   1. setState() calls on an unmounted component — harmless since React 18
 *      but they still generate noisy console warnings in development.
 *   2. Error toasts shown for requests the user no longer cares about — these
 *      are jarring UX for network timeouts or 5xx responses that arrive after
 *      navigation.
 *
 * This hook solves both by aborting all in-flight requests the moment Next.js
 * announces a route change.  Callers should check for axios's ERR_CANCELED /
 * CanceledError and silently swallow them (the pattern already used throughout
 * this codebase for stale-request deduplication, e.g. dashboard.jsx).
 *
 * Usage
 * ─────
 *   const { signal } = useRouteChangeAbort();
 *
 *   useEffect(() => {
 *     getStudents({ signal })
 *       .then(({ data }) => setStudents(data.students))
 *       .catch((err) => {
 *         if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
 *         setError(t('dashboard.failedToLoadStudents'));
 *       });
 *   }, [signal]);
 *
 * Notes
 * ─────
 * • The signal reference is stable within a navigation cycle — it only changes
 *   after the controller is aborted and a new one is created.
 * • The hook does NOT attempt to cancel native fetch() requests — the codebase
 *   uses axios exclusively for API calls and fetch() only for /auth/me (which
 *   uses its own abort handling in useAdminAuth.js).
 * • routeChangeStart is chosen over routeChangeComplete because we want to
 *   abort as early as possible, not after the new page has already mounted.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';

/**
 * Returns a stable AbortController and its signal for the current
 * navigation cycle.
 *
 * @returns {{ controller: AbortController, signal: AbortSignal }}
 */
export function useRouteChangeAbort() {
  const router = useRouter();

  // We hold the controller in a ref so we can abort it imperatively from the
  // router event handler, and also expose it via state so React can re-render
  // consumers that read signal/controller when a new one is issued.
  const controllerRef = useRef(null);

  // Initialise on the first render.
  if (controllerRef.current === null) {
    controllerRef.current = new AbortController();
  }

  // Expose the current controller to callers.  Using useState here ensures
  // that when we swap to a new controller (after navigation) consumers that
  // depend on `signal` re-run their effects with the fresh signal.
  const [controller, setController] = useState(() => controllerRef.current);

  useEffect(() => {
    function handleRouteChangeStart() {
      // Abort the controller for the current page's in-flight requests.
      controllerRef.current.abort();

      // Issue a fresh controller for any requests that might be kicked off
      // during the transition (e.g. prefetch logic in the new page).
      const next = new AbortController();
      controllerRef.current = next;
      setController(next);
    }

    router.events.on('routeChangeStart', handleRouteChangeStart);
    return () => {
      router.events.off('routeChangeStart', handleRouteChangeStart);
      // Also abort when the component unmounts (e.g. navigating to a page
      // that doesn't use this hook, or the page is SSR-rendered).
      controllerRef.current.abort();
    };
  }, [router.events]);

  return { controller, signal: controller.signal };
}
