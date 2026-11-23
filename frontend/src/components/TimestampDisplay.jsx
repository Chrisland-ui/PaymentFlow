/**
 * TimestampDisplay — renders a formatted timestamp with an optional, explicit
 * timezone label and a machine-readable <time> element.
 *
 * Features
 * ────────
 * • Three display modes: LOCALE (browser default), LOCAL (user TZ + label),
 *   UTC (always UTC + "UTC" label).
 * • Renders a semantic <time datetime="…"> element so screen readers and
 *   search engines get the raw ISO timestamp.
 * • Timezone label rendered as a visually distinct <abbr> with full name as
 *   title tooltip.
 * • DST-correct: the label is derived from the date's actual offset at render
 *   time via Intl, so "EST" vs "EDT" are both handled correctly.
 * • Graceful fallback when the ISO string is null or invalid.
 *
 * Usage
 * ─────
 * // Plain locale display (default)
 * <TimestampDisplay iso={payment.confirmedAt} />
 *
 * // UTC for blockchain records
 * <TimestampDisplay iso={tx.timestamp} mode={DISPLAY_MODE.UTC} />
 *
 * // Local time with TZ label
 * <TimestampDisplay iso={log.createdAt} mode={DISPLAY_MODE.LOCAL} />
 *
 * // Date only
 * <TimestampDisplay iso={plan.dueDate} dateOnly />
 *
 * // Custom fallback
 * <TimestampDisplay iso={null} fallback="Pending" />
 */

import { DISPLAY_MODE, formatTimestamp, formatDateOnly } from '../utils/dateTime';
import { useAdminAuthContext } from '../hooks/AdminAuthContext';

export { DISPLAY_MODE };

/**
 * @param {object}  props
 * @param {string}  [props.iso]                  - ISO 8601 timestamp string
 * @param {string}  [props.mode=DISPLAY_MODE.LOCAL]
 * @param {string}  [props.locale]               - BCP 47 locale override
 * @param {string}  [props.timeZone]             - IANA timezone override
 * @param {string}  [props.fallback='—']         - Content when iso is null/invalid
 * @param {boolean} [props.dateOnly=false]       - Render date without time
 * @param {boolean} [props.showLabel=true]       - Show timezone label (LOCAL/UTC modes)
 * @param {string}  [props.className]            - Extra CSS class for the wrapper <time>
 * @param {object}  [props.style]                - Inline styles for the wrapper <time>
 * @param {string}  [props.labelClassName]       - CSS class for the label <abbr>
 */
export default function TimestampDisplay({
  iso,
  mode = DISPLAY_MODE.LOCAL,
  locale,
  timeZone,
  fallback = '—',
  dateOnly = false,
  showLabel = true,
  className,
  style,
  labelClassName,
}) {
  const { timeZone: schoolTimeZone } = useAdminAuthContext();
  const fn = dateOnly ? formatDateOnly : formatTimestamp;
  const { formatted, label, iso: isoOut } = fn(iso, {
    mode,
    locale,
    timeZone: timeZone || schoolTimeZone || 'UTC',
    fallback,
  });

  // When the value is the fallback (null/invalid input) just render a plain span.
  if (!isoOut) {
    return (
      <span className={className} style={style} aria-label={fallback}>
        {fallback}
      </span>
    );
  }

  const displayLabel = showLabel && label ? label : null;

  return (
    <time dateTime={isoOut} className={className} style={style}>
      {formatted}
      {displayLabel && (
        <>
          {' '}
          <abbr
            title={`Displayed in ${label} time`}
            className={labelClassName}
            style={{
              fontSize: '0.75em',
              fontWeight: 600,
              letterSpacing: '0.03em',
              color: 'var(--text-muted, inherit)',
              textDecoration: 'none',
              cursor: 'default',
            }}
          >
            {label}
          </abbr>
        </>
      )}
    </time>
  );
}
