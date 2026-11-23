/**
 * dateTime.js — Timezone-aware date/time display utilities.
 *
 * All functions are pure (no React, no hooks) and safe for SSR.
 *
 * Display modes
 * ─────────────
 * LOCALE — Browser-locale-aware rendering via Intl; no extra timezone label.
 *          Good for non-critical, relative displays (e.g. "recently updated").
 * LOCAL  — Rendered in the user's browser timezone with an explicit TZ
 *          abbreviation appended (e.g. "Sep 28, 2026, 10:30 AM EST").
 *          Recommended for payment/audit timestamps where the operator must
 *          be able to cross-reference wall-clock time.
 * UTC    — Always rendered as UTC, with an explicit "UTC" label appended.
 *          Use for blockchain records, receipts, and support investigations
 *          where a single unambiguous reference time is required.
 */

// ─── Display mode constants ────────────────────────────────────────────────────

export const DISPLAY_MODE = Object.freeze({
  /** Intl locale-aware, no explicit timezone label. */
  LOCALE: 'locale',
  /** User's local timezone with explicit TZ abbreviation. */
  LOCAL: 'local',
  /** Always UTC with explicit "UTC" label. */
  UTC: 'utc',
});

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Returns the IANA timezone string for the current environment.
 * Falls back to 'UTC' if the Intl API is unavailable (e.g. older environments).
 *
 * @returns {string}
 */
export function getBrowserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Returns a short timezone abbreviation for the given IANA timezone and date.
 *
 * Uses the 'short' timeZoneName option of Intl.DateTimeFormat to extract the
 * localised abbreviation (e.g. "EST", "PDT", "CET", "UTC+5").  The output
 * follows the host platform's ICU data, so it correctly reflects DST offsets
 * — "EDT" during summer, "EST" during winter for America/New_York.
 *
 * Falls back to the raw timeZone string if Intl throws (e.g. invalid IANA id).
 *
 * @param {string} timeZone - IANA timezone identifier (e.g. "America/New_York")
 * @param {Date}   [date]   - Reference date for DST resolution; defaults to now
 * @returns {string}
 */
export function getTimezoneLabel(timeZone, date) {
  const ref = date instanceof Date ? date : new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'short',
    }).formatToParts(ref);
    const tz = parts.find((p) => p.type === 'timeZoneName');
    return tz ? tz.value : timeZone;
  } catch {
    return timeZone;
  }
}

/**
 * Parses an ISO string into a Date and validates it.
 *
 * @param {*} isoString
 * @returns {Date|null} — null when the input is falsy or produces NaN
 */
function parseISO(isoString) {
  if (!isoString) return null;
  const d = new Date(isoString);
  return isNaN(d.getTime()) ? null : d;
}

// ─── Core formatting functions ─────────────────────────────────────────────────

/**
 * Formats a timestamp ISO string for display.
 *
 * @param {string|null|undefined} isoString - ISO 8601 date-time string
 * @param {object} [options]
 * @param {string} [options.mode=DISPLAY_MODE.LOCALE]     - One of DISPLAY_MODE.*
 * @param {string} [options.locale]                       - BCP 47 locale tag; omit to use system locale
 * @param {string} [options.timeZone]                     - IANA timezone; defaults to browser timezone
 * @param {string} [options.fallback='—']                 - Returned when isoString is null/invalid
 * @returns {{ formatted: string, label: string, iso: string|null, mode: string }}
 *   formatted — human-readable date-time string
 *   label     — explicit timezone label ("UTC", "EST", …) or empty string for LOCALE mode
 *   iso       — original ISO string (for <time datetime> attributes) or null
 *   mode      — the effective display mode used
 */
export function formatTimestamp(isoString, options = {}) {
  const {
    mode = DISPLAY_MODE.LOCALE,
    locale,
    fallback = '—',
  } = options;

  // Resolve timeZone: prefer explicit option, then browser TZ
  const timeZone = options.timeZone || getBrowserTimeZone();

  const date = parseISO(isoString);
  if (!date) {
    return { formatted: fallback, label: '', iso: null, mode };
  }

  let formatted;
  let label;

  switch (mode) {
    case DISPLAY_MODE.UTC: {
      formatted = new Intl.DateTimeFormat(locale, {
        timeZone: 'UTC',
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
      label = 'UTC';
      break;
    }

    case DISPLAY_MODE.LOCAL: {
      formatted = new Intl.DateTimeFormat(locale, {
        timeZone,
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
      label = getTimezoneLabel(timeZone, date);
      break;
    }

    case DISPLAY_MODE.LOCALE:
    default: {
      formatted = new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
      label = '';
      break;
    }
  }

  return {
    formatted,
    label,
    iso: date.toISOString(),
    mode,
  };
}

/**
 * Formats a date-only ISO string for display (no time component).
 *
 * @param {string|null|undefined} isoString - ISO 8601 date string (or full date-time)
 * @param {object} [options]
 * @param {string} [options.mode=DISPLAY_MODE.LOCALE]
 * @param {string} [options.locale]
 * @param {string} [options.timeZone]
 * @param {string} [options.fallback='—']
 * @returns {{ formatted: string, label: string, iso: string|null, mode: string }}
 */
export function formatDateOnly(isoString, options = {}) {
  const {
    mode = DISPLAY_MODE.LOCALE,
    locale,
    fallback = '—',
  } = options;

  const timeZone = options.timeZone || getBrowserTimeZone();

  const date = parseISO(isoString);
  if (!date) {
    return { formatted: fallback, label: '', iso: null, mode };
  }

  let formatted;
  let label;

  switch (mode) {
    case DISPLAY_MODE.UTC: {
      formatted = new Intl.DateTimeFormat(locale, {
        timeZone: 'UTC',
        dateStyle: 'medium',
      }).format(date);
      label = 'UTC';
      break;
    }

    case DISPLAY_MODE.LOCAL: {
      formatted = new Intl.DateTimeFormat(locale, {
        timeZone,
        dateStyle: 'medium',
      }).format(date);
      label = getTimezoneLabel(timeZone, date);
      break;
    }

    case DISPLAY_MODE.LOCALE:
    default: {
      formatted = new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
      }).format(date);
      label = '';
      break;
    }
  }

  return {
    formatted,
    label,
    iso: date.toISOString(),
    mode,
  };
}

/**
 * Returns a human-readable relative time string (e.g. "5m ago", "2h ago").
 *
 * Deduplicates the identical pattern in dashboard.jsx and webhooks.jsx.
 * Requires a react-i18next `t` function so i18n strings are resolved at call
 * site (keeps this module free of React imports).
 *
 * Supported i18n keys (must exist in the active locale):
 *   time.never, time.justNow, time.minutesAgo, time.hoursAgo,
 *   time.daysAgo
 *
 * Falls back to a localised date string when the age exceeds 24 h so that
 * older timestamps remain readable even without a "daysAgo" key.
 *
 * @param {string|null|undefined} isoString
 * @param {function} t - react-i18next translation function
 * @returns {string}
 */
export function formatRelative(isoString, t) {
  if (!isoString) return t('time.never');
  const date = parseISO(isoString);
  if (!date) return t('time.never');

  const mins = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (mins < 1) return t('time.justNow');
  if (mins < 60) return t('time.minutesAgo', { mins });

  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t('time.hoursAgo', { hrs });

  const days = Math.floor(hrs / 24);
  // Use daysAgo key if available; fall back to a localized date string
  try {
    const result = t('time.daysAgo', { days });
    // react-i18next returns the key itself when missing — detect that
    if (result === 'time.daysAgo' || result === '{{days}}d ago') {
      return date.toLocaleDateString();
    }
    return result;
  } catch {
    return date.toLocaleDateString();
  }
}
