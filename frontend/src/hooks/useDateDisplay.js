/**
 * useDateDisplay — React hook that resolves the active display mode, locale,
 * and browser timezone so components don't have to do it themselves.
 *
 * The hook reads the i18next language and the browser timezone once on mount.
 * It re-resolves when the i18next language changes (e.g. user switches locale
 * in the language picker) so all consumers update automatically.
 *
 * Usage
 * ─────
 * const { formatTimestamp, formatDateOnly, formatRelative, mode, locale, timeZone } =
 *   useDateDisplay({ mode: DISPLAY_MODE.LOCAL });
 *
 * const { formatted, label, iso } = formatTimestamp(payment.confirmedAt);
 * // → { formatted: "Sep 28, 2026, 10:30 AM", label: "EST", iso: "2026-09-28T…" }
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DISPLAY_MODE,
  getBrowserTimeZone,
  formatTimestamp as coreFormatTimestamp,
  formatDateOnly as coreFormatDateOnly,
  formatRelative as coreFormatRelative,
} from '../utils/dateTime';

export { DISPLAY_MODE };

/**
 * @typedef {Object} DateDisplayResult
 * @property {function} formatTimestamp  - (isoString, overrides?) → {formatted,label,iso,mode}
 * @property {function} formatDateOnly   - (isoString, overrides?) → {formatted,label,iso,mode}
 * @property {function} formatRelative   - (isoString) → string
 * @property {string}   mode             - Active display mode
 * @property {string}   locale           - Active BCP 47 locale tag
 * @property {string}   timeZone         - Active IANA timezone string
 */

/**
 * @param {object} [options]
 * @param {string} [options.mode=DISPLAY_MODE.LOCALE]   - Default display mode
 * @param {string} [options.timeZone]                   - Override browser timezone
 * @param {string} [options.fallback='—']               - Fallback for null/invalid
 * @returns {DateDisplayResult}
 */
export function useDateDisplay(options = {}) {
  const {
    mode = DISPLAY_MODE.LOCALE,
    fallback = '—',
  } = options;

  const { i18n, t } = useTranslation();

  // The browser timezone is stable for the session but resolve it lazily so
  // SSR (where window/Intl may differ) doesn't cause hydration mismatches.
  const [timeZone, setTimeZone] = useState(() => options.timeZone || getBrowserTimeZone());

  useEffect(() => {
    // Re-read after mount so hydration is stable, then update if the explicit
    // override was not provided.
    if (!options.timeZone) {
      setTimeZone(getBrowserTimeZone());
    }
  }, [options.timeZone]);

  // Use the i18n language as the Intl locale.
  const locale = i18n.language || undefined;

  const formatTimestamp = useCallback(
    (isoString, overrides = {}) =>
      coreFormatTimestamp(isoString, { mode, locale, timeZone, fallback, ...overrides }),
    [mode, locale, timeZone, fallback],
  );

  const formatDateOnly = useCallback(
    (isoString, overrides = {}) =>
      coreFormatDateOnly(isoString, { mode, locale, timeZone, fallback, ...overrides }),
    [mode, locale, timeZone, fallback],
  );

  const formatRelative = useCallback(
    (isoString) => coreFormatRelative(isoString, t),
    [t],
  );

  return { formatTimestamp, formatDateOnly, formatRelative, mode, locale, timeZone };
}
