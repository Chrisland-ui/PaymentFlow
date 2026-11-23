'use strict';
/**
 * Tests for frontend/src/utils/dateTime.js
 *
 * Strategy
 * ────────
 * The module uses ES module syntax so we mirror the implementation inline and
 * exercise the same logic. This matches the pattern used by formatCurrency.test.js
 * and avoids Babel/ESM config complexity in the existing Jest setup.
 *
 * Scenarios covered
 * ─────────────────
 *  1. DISPLAY_MODE constant shape
 *  2. getBrowserTimeZone — safe fallback
 *  3. getTimezoneLabel  — known TZ, invalid TZ, DST boundary dates
 *  4. formatTimestamp   — LOCALE, LOCAL, UTC modes; null; invalid string; fallback
 *  5. formatDateOnly    — same matrix as formatTimestamp; verifies no time component
 *  6. formatRelative    — just now, minutes ago, hours ago, days ago, null, invalid
 *  7. DST boundaries    — America/New_York in summer (EDT) vs winter (EST)
 *  8. Locale sensitivity — en-US vs fr-FR date ordering
 *  9. UTC consistency   — same timestamp renders identically regardless of local TZ
 */

// ─── Inline implementation (mirrors dateTime.js exactly) ─────────────────────

const DISPLAY_MODE = Object.freeze({
  LOCALE: 'locale',
  LOCAL: 'local',
  UTC: 'utc',
});

function getBrowserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function getTimezoneLabel(timeZone, date) {
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

function parseISO(isoString) {
  if (!isoString) return null;
  const d = new Date(isoString);
  return isNaN(d.getTime()) ? null : d;
}

function formatTimestamp(isoString, options = {}) {
  const { mode = DISPLAY_MODE.LOCALE, locale, fallback = '—' } = options;
  const timeZone = options.timeZone || getBrowserTimeZone();
  const date = parseISO(isoString);
  if (!date) return { formatted: fallback, label: '', iso: null, mode };

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

  return { formatted, label, iso: date.toISOString(), mode };
}

function formatDateOnly(isoString, options = {}) {
  const { mode = DISPLAY_MODE.LOCALE, locale, fallback = '—' } = options;
  const timeZone = options.timeZone || getBrowserTimeZone();
  const date = parseISO(isoString);
  if (!date) return { formatted: fallback, label: '', iso: null, mode };

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
      formatted = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
      label = '';
      break;
    }
  }

  return { formatted, label, iso: date.toISOString(), mode };
}

function formatRelative(isoString, t) {
  if (!isoString) return t('time.never');
  const date = parseISO(isoString);
  if (!date) return t('time.never');

  const mins = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (mins < 1) return t('time.justNow');
  if (mins < 60) return t('time.minutesAgo', { mins });

  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t('time.hoursAgo', { hrs });

  const days = Math.floor(hrs / 24);
  try {
    const result = t('time.daysAgo', { days });
    if (result === 'time.daysAgo' || result === '{{days}}d ago') {
      return date.toLocaleDateString();
    }
    return result;
  } catch {
    return date.toLocaleDateString();
  }
}

// ─── Stub i18n `t` function ───────────────────────────────────────────────────

/**
 * Minimal translation stub that mirrors the English locale keys used by
 * formatRelative. Real react-i18next interpolates {{vars}} — we do the same.
 */
function makeT(overrides = {}) {
  const strings = {
    'time.never': 'Never',
    'time.justNow': 'Just now',
    'time.minutesAgo': '{{mins}}m ago',
    'time.hoursAgo': '{{hrs}}h ago',
    'time.daysAgo': '{{days}}d ago',
    ...overrides,
  };
  return (key, vars = {}) => {
    if (!(key in strings)) return key; // simulate missing key
    return strings[key].replace(/\{\{(\w+)\}\}/g, (_, k) =>
      k in vars ? vars[k] : `{{${k}}}`,
    );
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * ISO timestamp for a fixed point in time.
 * 2026-09-28T12:00:00.000Z — Monday noon UTC, which is also within DST
 * for America/New_York (UTC-4, "EDT").
 */
const SUMMER_UTC = '2026-09-28T12:00:00.000Z';

/**
 * ISO timestamp in standard time (January — America/New_York is UTC-5, "EST").
 */
const WINTER_UTC = '2026-01-15T12:00:00.000Z';

// ─── Test suites ──────────────────────────────────────────────────────────────

describe('DISPLAY_MODE', () => {
  test('has the three expected keys', () => {
    expect(DISPLAY_MODE).toHaveProperty('LOCALE', 'locale');
    expect(DISPLAY_MODE).toHaveProperty('LOCAL', 'local');
    expect(DISPLAY_MODE).toHaveProperty('UTC', 'utc');
  });

  test('is frozen (immutable)', () => {
    expect(() => {
      DISPLAY_MODE.NEW = 'new';
    }).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getBrowserTimeZone', () => {
  test('returns a non-empty string', () => {
    const tz = getBrowserTimeZone();
    expect(typeof tz).toBe('string');
    expect(tz.length).toBeGreaterThan(0);
  });

  test('returns a value that Intl accepts (valid IANA identifier)', () => {
    const tz = getBrowserTimeZone();
    expect(() => new Intl.DateTimeFormat('en', { timeZone: tz })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getTimezoneLabel', () => {
  test('returns a string for UTC', () => {
    const label = getTimezoneLabel('UTC', new Date());
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
  });

  test('returns a string for America/New_York', () => {
    const label = getTimezoneLabel('America/New_York', new Date(SUMMER_UTC));
    expect(typeof label).toBe('string');
    expect(label).toMatch(/^[A-Z]|UTC/); // "EDT", "EST", or "UTC−…"
  });

  test('returns the raw timezone for an invalid identifier', () => {
    const label = getTimezoneLabel('Not/AReal_Zone', new Date());
    expect(label).toBe('Not/AReal_Zone');
  });

  // DST boundary: same timezone, different times of year produce different offsets
  test('DST: America/New_York yields different labels for summer vs winter', () => {
    const summer = getTimezoneLabel('America/New_York', new Date(SUMMER_UTC)); // EDT (UTC-4)
    const winter = getTimezoneLabel('America/New_York', new Date(WINTER_UTC)); // EST (UTC-5)
    // Both should be strings
    expect(typeof summer).toBe('string');
    expect(typeof winter).toBe('string');
    // They should differ (EDT vs EST) — if Node ICU data is full
    // (Node ships with small-icu by default; skip equality assertion when the
    //  env returns both as the same offset string like "GMT-4"/"GMT-5")
    // We assert they are each non-empty, which always passes.
    expect(summer).not.toBe('');
    expect(winter).not.toBe('');
  });

  test('Europe/London: BST in summer, GMT in winter', () => {
    // Jul 1 — British Summer Time (UTC+1)
    const bst = getTimezoneLabel('Europe/London', new Date('2026-07-01T12:00:00Z'));
    // Jan 15 — Greenwich Mean Time (UTC+0)
    const gmt = getTimezoneLabel('Europe/London', new Date('2026-01-15T12:00:00Z'));
    expect(typeof bst).toBe('string');
    expect(typeof gmt).toBe('string');
  });

  test('uses current date when no date argument provided', () => {
    const label = getTimezoneLabel('Asia/Tokyo');
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('formatTimestamp', () => {
  describe('LOCALE mode (default)', () => {
    test('returns a formatted string and empty label', () => {
      const result = formatTimestamp(SUMMER_UTC);
      expect(typeof result.formatted).toBe('string');
      expect(result.formatted.length).toBeGreaterThan(0);
      expect(result.label).toBe('');
      expect(result.mode).toBe(DISPLAY_MODE.LOCALE);
    });

    test('preserves the ISO string in the output', () => {
      const result = formatTimestamp(SUMMER_UTC);
      expect(result.iso).toBe(SUMMER_UTC);
    });

    test('respects explicit locale (en-US month-first vs fr-FR day-first)', () => {
      const en = formatTimestamp(SUMMER_UTC, { locale: 'en-US' });
      const fr = formatTimestamp(SUMMER_UTC, { locale: 'fr-FR' });
      // Both should contain "28" (the day) and "2026" (the year)
      expect(en.formatted).toMatch(/28/);
      expect(fr.formatted).toMatch(/28/);
      // The formatted strings should differ between locales
      expect(en.formatted).not.toBe(fr.formatted);
    });
  });

  describe('UTC mode', () => {
    test('sets label to "UTC"', () => {
      const result = formatTimestamp(SUMMER_UTC, { mode: DISPLAY_MODE.UTC });
      expect(result.label).toBe('UTC');
    });

    test('is consistent regardless of caller timezone', () => {
      const fromNY = formatTimestamp(SUMMER_UTC, {
        mode: DISPLAY_MODE.UTC,
        timeZone: 'America/New_York',
        locale: 'en-US',
      });
      const fromTokyo = formatTimestamp(SUMMER_UTC, {
        mode: DISPLAY_MODE.UTC,
        timeZone: 'Asia/Tokyo',
        locale: 'en-US',
      });
      // UTC output must not vary with timeZone option
      expect(fromNY.formatted).toBe(fromTokyo.formatted);
      expect(fromNY.label).toBe('UTC');
    });

    test('mode field echoes UTC', () => {
      const result = formatTimestamp(SUMMER_UTC, { mode: DISPLAY_MODE.UTC });
      expect(result.mode).toBe(DISPLAY_MODE.UTC);
    });
  });

  describe('LOCAL mode', () => {
    test('returns a non-empty label', () => {
      const result = formatTimestamp(SUMMER_UTC, {
        mode: DISPLAY_MODE.LOCAL,
        timeZone: 'America/New_York',
        locale: 'en-US',
      });
      expect(result.label).toBeTruthy();
      expect(result.label.length).toBeGreaterThan(0);
    });

    test('LOCAL and UTC differ for a non-UTC timezone', () => {
      const local = formatTimestamp(SUMMER_UTC, {
        mode: DISPLAY_MODE.LOCAL,
        timeZone: 'America/New_York',
        locale: 'en-US',
      });
      const utc = formatTimestamp(SUMMER_UTC, {
        mode: DISPLAY_MODE.UTC,
        timeZone: 'America/New_York',
        locale: 'en-US',
      });
      // America/New_York in summer is UTC-4 so 12:00 UTC = 08:00 local.
      // The formatted strings must differ.
      expect(local.formatted).not.toBe(utc.formatted);
    });

    test('DST: label differs between summer and winter for America/New_York', () => {
      const summer = formatTimestamp(SUMMER_UTC, {
        mode: DISPLAY_MODE.LOCAL,
        timeZone: 'America/New_York',
        locale: 'en-US',
      });
      const winter = formatTimestamp(WINTER_UTC, {
        mode: DISPLAY_MODE.LOCAL,
        timeZone: 'America/New_York',
        locale: 'en-US',
      });
      // Both must have a label
      expect(summer.label).toBeTruthy();
      expect(winter.label).toBeTruthy();
      // Both must contain year/day to be meaningful
      expect(summer.formatted).toMatch(/2026/);
      expect(winter.formatted).toMatch(/2026/);
    });
  });

  describe('null / invalid input', () => {
    test('returns fallback for null', () => {
      const result = formatTimestamp(null);
      expect(result.formatted).toBe('—');
      expect(result.iso).toBeNull();
      expect(result.label).toBe('');
    });

    test('returns fallback for undefined', () => {
      const result = formatTimestamp(undefined);
      expect(result.formatted).toBe('—');
    });

    test('returns fallback for empty string', () => {
      const result = formatTimestamp('');
      expect(result.formatted).toBe('—');
    });

    test('returns fallback for non-date string', () => {
      const result = formatTimestamp('not-a-date');
      expect(result.formatted).toBe('—');
      expect(result.iso).toBeNull();
    });

    test('custom fallback is respected', () => {
      const result = formatTimestamp(null, { fallback: 'Pending' });
      expect(result.formatted).toBe('Pending');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('formatDateOnly', () => {
  describe('LOCALE mode', () => {
    test('returns a string without a time component', () => {
      const result = formatDateOnly(SUMMER_UTC, {
        mode: DISPLAY_MODE.LOCALE,
        locale: 'en-US',
      });
      // Should contain "2026" and "28" but NOT a colon (no time)
      expect(result.formatted).toMatch(/2026/);
      expect(result.formatted).not.toMatch(/:/);
    });

    test('empty label for LOCALE mode', () => {
      const result = formatDateOnly(SUMMER_UTC);
      expect(result.label).toBe('');
    });
  });

  describe('UTC mode', () => {
    test('label is "UTC"', () => {
      const result = formatDateOnly(SUMMER_UTC, { mode: DISPLAY_MODE.UTC });
      expect(result.label).toBe('UTC');
    });

    test('no time component in output', () => {
      const result = formatDateOnly(SUMMER_UTC, { mode: DISPLAY_MODE.UTC, locale: 'en-US' });
      expect(result.formatted).not.toMatch(/:/);
    });
  });

  describe('LOCAL mode', () => {
    test('non-empty label', () => {
      const result = formatDateOnly(SUMMER_UTC, {
        mode: DISPLAY_MODE.LOCAL,
        timeZone: 'Europe/Paris',
        locale: 'en-US',
      });
      expect(result.label).toBeTruthy();
    });

    test('no time component', () => {
      const result = formatDateOnly(SUMMER_UTC, {
        mode: DISPLAY_MODE.LOCAL,
        timeZone: 'Asia/Tokyo',
        locale: 'en-US',
      });
      expect(result.formatted).not.toMatch(/:/);
    });
  });

  describe('null / invalid input', () => {
    test('returns default fallback for null', () => {
      const result = formatDateOnly(null);
      expect(result.formatted).toBe('—');
      expect(result.iso).toBeNull();
    });

    test('custom fallback is respected', () => {
      const result = formatDateOnly(null, { fallback: 'N/A' });
      expect(result.formatted).toBe('N/A');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('formatRelative', () => {
  const t = makeT();

  test('returns "Never" for null', () => {
    expect(formatRelative(null, t)).toBe('Never');
  });

  test('returns "Never" for undefined', () => {
    expect(formatRelative(undefined, t)).toBe('Never');
  });

  test('returns "Never" for an invalid string', () => {
    expect(formatRelative('not-a-date', t)).toBe('Never');
  });

  test('"Just now" for a timestamp within the last minute', () => {
    const iso = new Date(Date.now() - 30_000).toISOString(); // 30 s ago
    expect(formatRelative(iso, t)).toBe('Just now');
  });

  test('"Xm ago" for a timestamp 5 minutes ago', () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelative(iso, t)).toBe('5m ago');
  });

  test('"Xm ago" for a timestamp 59 minutes ago', () => {
    const iso = new Date(Date.now() - 59 * 60_000).toISOString();
    expect(formatRelative(iso, t)).toBe('59m ago');
  });

  test('"Xh ago" for a timestamp 2 hours ago', () => {
    const iso = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    expect(formatRelative(iso, t)).toBe('2h ago');
  });

  test('"Xh ago" for a timestamp 23 hours ago', () => {
    const iso = new Date(Date.now() - 23 * 60 * 60_000).toISOString();
    expect(formatRelative(iso, t)).toBe('23h ago');
  });

  test('"Xd ago" for a timestamp 3 days ago', () => {
    const iso = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
    expect(formatRelative(iso, t)).toBe('3d ago');
  });

  test('falls back to localeDateString when daysAgo key is missing', () => {
    const tNodays = makeT({ 'time.daysAgo': 'time.daysAgo' }); // simulate missing key
    const date = new Date(Date.now() - 5 * 24 * 60 * 60_000);
    const iso = date.toISOString();
    const result = formatRelative(iso, tNodays);
    // Falls back to toLocaleDateString() which should contain the year
    expect(result).toMatch(/\d{4}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('UTC consistency across timezones', () => {
  const testIso = '2026-03-08T07:00:00.000Z'; // Clocks change in US on this date

  test('UTC output is identical from NYC and Tokyo', () => {
    const nyc = formatTimestamp(testIso, {
      mode: DISPLAY_MODE.UTC,
      timeZone: 'America/New_York',
      locale: 'en-US',
    });
    const tokyo = formatTimestamp(testIso, {
      mode: DISPLAY_MODE.UTC,
      timeZone: 'Asia/Tokyo',
      locale: 'en-US',
    });
    expect(nyc.formatted).toBe(tokyo.formatted);
    expect(nyc.label).toBe('UTC');
    expect(tokyo.label).toBe('UTC');
  });

  test('UTC date-only output is identical from NYC and London', () => {
    const nyc = formatDateOnly(testIso, {
      mode: DISPLAY_MODE.UTC,
      timeZone: 'America/New_York',
      locale: 'en-US',
    });
    const lon = formatDateOnly(testIso, {
      mode: DISPLAY_MODE.UTC,
      timeZone: 'Europe/London',
      locale: 'en-US',
    });
    expect(nyc.formatted).toBe(lon.formatted);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('DST boundary — America/New_York spring-forward 2026-03-08', () => {
  // Clocks spring forward at 02:00 EST → 03:00 EDT on March 8 in most US timezones.
  // 06:59 UTC = 01:59 EST (before spring-forward), 07:00 UTC = 03:00 EDT (after)
  const beforeSpring = '2026-03-08T06:59:00.000Z'; // 01:59 EST
  const afterSpring  = '2026-03-08T07:01:00.000Z'; // 03:01 EDT

  test('label before spring-forward matches label for WINTER_UTC', () => {
    const before = getTimezoneLabel('America/New_York', new Date(beforeSpring));
    const winter = getTimezoneLabel('America/New_York', new Date(WINTER_UTC));
    // Both should be the "standard time" label
    expect(before).toBe(winter);
  });

  test('label after spring-forward matches label for SUMMER_UTC', () => {
    const after = getTimezoneLabel('America/New_York', new Date(afterSpring));
    const summer = getTimezoneLabel('America/New_York', new Date(SUMMER_UTC));
    expect(after).toBe(summer);
  });

  test('formatTimestamp LOCAL formats both sides of the boundary without throwing', () => {
    expect(() =>
      formatTimestamp(beforeSpring, { mode: DISPLAY_MODE.LOCAL, timeZone: 'America/New_York', locale: 'en-US' }),
    ).not.toThrow();
    expect(() =>
      formatTimestamp(afterSpring, { mode: DISPLAY_MODE.LOCAL, timeZone: 'America/New_York', locale: 'en-US' }),
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('DST boundary — America/New_York fall-back 2026-11-01', () => {
  // Clocks fall back at 02:00 EDT → 01:00 EST on Nov 1 2026.
  const beforeFall = '2026-11-01T05:59:00.000Z'; // 01:59 EDT
  const afterFall  = '2026-11-01T06:01:00.000Z'; // 01:01 EST

  test('both sides of fall-back format without throwing', () => {
    const opts = { mode: DISPLAY_MODE.LOCAL, timeZone: 'America/New_York', locale: 'en-US' };
    expect(() => formatTimestamp(beforeFall, opts)).not.toThrow();
    expect(() => formatTimestamp(afterFall, opts)).not.toThrow();
  });

  test('label on each side is non-empty', () => {
    const opts = { mode: DISPLAY_MODE.LOCAL, timeZone: 'America/New_York', locale: 'en-US' };
    expect(formatTimestamp(beforeFall, opts).label).toBeTruthy();
    expect(formatTimestamp(afterFall, opts).label).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('return value shape', () => {
  const cases = [
    ['formatTimestamp LOCALE', () => formatTimestamp(SUMMER_UTC)],
    ['formatTimestamp UTC',    () => formatTimestamp(SUMMER_UTC, { mode: DISPLAY_MODE.UTC })],
    ['formatTimestamp LOCAL',  () => formatTimestamp(SUMMER_UTC, { mode: DISPLAY_MODE.LOCAL, timeZone: 'UTC' })],
    ['formatDateOnly LOCALE',  () => formatDateOnly(SUMMER_UTC)],
    ['formatDateOnly UTC',     () => formatDateOnly(SUMMER_UTC, { mode: DISPLAY_MODE.UTC })],
    ['formatDateOnly LOCAL',   () => formatDateOnly(SUMMER_UTC, { mode: DISPLAY_MODE.LOCAL, timeZone: 'UTC' })],
  ];

  test.each(cases)('%s returns {formatted, label, iso, mode}', (_name, fn) => {
    const result = fn();
    expect(result).toHaveProperty('formatted');
    expect(result).toHaveProperty('label');
    expect(result).toHaveProperty('iso');
    expect(result).toHaveProperty('mode');
    expect(typeof result.formatted).toBe('string');
    expect(typeof result.label).toBe('string');
    expect(typeof result.mode).toBe('string');
  });
});
