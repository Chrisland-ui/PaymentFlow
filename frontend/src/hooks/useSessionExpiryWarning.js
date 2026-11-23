/**
 * useSessionExpiryWarning — Issue #253
 *
 * Reads the JWT expiry claim (`exp`) returned by GET /auth/me and schedules
 * a warning callback N minutes before the token expires.  The warning gives
 * the user a chance to save work or manually refresh before the session ends.
 *
 * Design notes
 * ────────────
 * • The JWT itself is an HttpOnly cookie and therefore inaccessible to JS.
 *   Instead we rely on the `exp` field returned by `/auth/me` (already called
 *   by `useAdminAuth`).  Callers pass this value as the `tokenExp` prop.
 * • Only a single timer is ever active at a time.  If `tokenExp` changes
 *   (e.g. after a token refresh), the previous timer is cancelled and a new
 *   one is scheduled.
 * • If the token has already expired, or will expire within the warning
 *   window, the callback fires on the next tick rather than setting a timer
 *   in the past (which setTimeout would silently ignore or fire immediately).
 * • The hook is purely side-effect based — it returns nothing and causes no
 *   re-renders of its own.
 *
 * Usage
 * ─────
 *   // In a component that already reads exp from useAdminAuth / auth/me:
 *   useSessionExpiryWarning({
 *     tokenExp: authData.exp,          // Unix timestamp (seconds), or null
 *     warningMinutes: 5,               // default
 *     onWarning: () => {
 *       showToast('Your session will expire in 5 minutes.');
 *     },
 *   });
 *
 * @param {object}   opts
 * @param {number|null} opts.tokenExp        Unix timestamp (seconds) of token expiry.
 *                                           Pass null/undefined to disable the timer.
 * @param {number}   [opts.warningMinutes=5] How many minutes before expiry to fire.
 * @param {Function} opts.onWarning          Called once when the warning threshold is crossed.
 */

import { useEffect, useRef } from 'react';

export const DEFAULT_WARNING_MINUTES = 5;

/**
 * Compute the number of milliseconds from now until `warningMinutes` before
 * the token expires.
 *
 * Returns:
 *   > 0   → schedule a timer for that many ms
 *   ≤ 0   → fire immediately (token is already near/past expiry)
 *
 * @param {number} tokenExpSeconds  Unix timestamp in seconds.
 * @param {number} warningMinutes
 * @returns {number} milliseconds until the warning should fire
 */
export function msUntilWarning(tokenExpSeconds, warningMinutes) {
  const nowMs       = Date.now();
  const expMs       = tokenExpSeconds * 1000;
  const warnAtMs    = expMs - warningMinutes * 60 * 1000;
  return warnAtMs - nowMs;
}

export function useSessionExpiryWarning({
  tokenExp,
  warningMinutes = DEFAULT_WARNING_MINUTES,
  onWarning,
} = {}) {
  // Keep the latest callback in a ref so we can update it without
  // clearing/resetting the timer on every render.
  const onWarningRef = useRef(onWarning);
  useEffect(() => {
    onWarningRef.current = onWarning;
  }, [onWarning]);

  useEffect(() => {
    // Nothing to schedule when there is no known expiry.
    if (!tokenExp || typeof tokenExp !== 'number') return;

    const delay = msUntilWarning(tokenExp, warningMinutes);

    if (delay <= 0) {
      // Token is already within the warning window (or expired) — fire now.
      onWarningRef.current?.();
      return;
    }

    const timerId = setTimeout(() => {
      onWarningRef.current?.();
    }, delay);

    return () => clearTimeout(timerId);
  }, [tokenExp, warningMinutes]); // re-schedule whenever exp or threshold changes
}
