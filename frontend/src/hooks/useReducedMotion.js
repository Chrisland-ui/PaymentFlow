/**
 * useReducedMotion — issue #20
 *
 * Returns `true` when the user has expressed a preference for reduced motion
 * via the `prefers-reduced-motion: reduce` media query, `false` otherwise.
 *
 * Usage
 * ─────
 *   import { useReducedMotion } from '../hooks/useReducedMotion';
 *
 *   function PollingSpinner() {
 *     const reducedMotion = useReducedMotion();
 *     return reducedMotion
 *       ? <span aria-label="Loading…">…</span>   // static fallback
 *       : <Spinner />;                            // animated spinner
 *   }
 *
 * Why a hook instead of only CSS?
 * ────────────────────────────────
 * The CSS @media (prefers-reduced-motion) block in globals.css and
 * redesign.css handles purely-CSS animations. The hook is needed when:
 *  • A component chooses between two JSX branches (spinner vs. static text).
 *  • A component drives animation via JS (requestAnimationFrame, GSAP, …).
 *  • A test needs to exercise the reduced-motion branch directly.
 *
 * SSR behaviour
 * ─────────────
 * During server-side rendering the hook returns `false` (no window/matchMedia).
 * The preference is detected on the client in the first useEffect, which runs
 * after hydration. This means there is one paint with full motion before the
 * preference is applied — acceptable because the initial render is invisible
 * to users with reduced motion preferences (it resolves within a frame).
 */

import { useState, useEffect } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Returns whether the user prefers reduced motion.
 * Updates reactively if the user changes their OS accessibility setting at runtime.
 *
 * @returns {boolean}
 */
export function useReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    // Guard against SSR environments where window is not defined.
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia(QUERY);

    // Set initial value.
    setPrefersReducedMotion(mediaQuery.matches);

    // Listen for changes (user switches OS accessibility setting at runtime).
    function handleChange(event) {
      setPrefersReducedMotion(event.matches);
    }

    // Use addEventListener with fallback for older browsers.
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    } else if (typeof mediaQuery.addListener === 'function') {
      // Safari < 14 uses deprecated addListener API.
      mediaQuery.addListener(handleChange);
      return () => mediaQuery.removeListener(handleChange);
    }
  }, []);

  return prefersReducedMotion;
}

export default useReducedMotion;
