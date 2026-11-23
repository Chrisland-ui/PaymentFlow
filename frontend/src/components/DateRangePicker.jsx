/**
 * DateRangePicker
 *
 * A unified date range picker component used across all operational screens
 * (audit logs, analytics, reports). Resolves Issue #360.
 *
 * Features:
 *  - Consistent date presets: Today, Yesterday, Last 7 Days, This Month,
 *    Last Month, Custom.
 *  - Displays the school's configured timezone (falling back to the browser's
 *    IANA timezone).  All presets compute relative to that timezone.
 *  - Timezone override selector for advanced users.
 *  - Keyboard navigable and accessible to screen readers.
 *
 * Usage:
 *   <DateRangePicker
 *     startDate={startDate}          // "YYYY-MM-DD" string or ""
 *     endDate={endDate}              // "YYYY-MM-DD" string or ""
 *     timezone={timezone}            // IANA timezone string (optional)
 *     onChange={({ startDate, endDate, timezone }) => …}
 *   />
 */
import { useState, useCallback, useId } from "react";
import { useTranslation } from "react-i18next";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns a "YYYY-MM-DD" date string for `date` as seen in `timezone`.
 */
function toLocalDateString(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
    // en-CA returns "YYYY-MM-DD" by default
    return parts;
  } catch {
    // Fallback: ISO date portion
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Returns "UTC±HH:MM" offset label for a given IANA timezone.
 */
function getUtcOffsetLabel(timezone) {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "shortOffset",
    });
    const parts = formatter.formatToParts(now);
    const offsetPart = parts.find((p) => p.type === "timeZoneName");
    return offsetPart ? offsetPart.value : "";
  } catch {
    return "";
  }
}

/**
 * Compute preset start/end as "YYYY-MM-DD" strings relative to `timezone`.
 */
function computePreset(preset, timezone) {
  const now = new Date();
  const todayStr = toLocalDateString(now, timezone);

  // Compute yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = toLocalDateString(yesterday, timezone);

  // Compute first day of current month
  const firstOfMonthDate = new Date(now);
  firstOfMonthDate.setDate(1);
  const firstOfMonthStr = toLocalDateString(firstOfMonthDate, timezone);

  // Compute last day of previous month and first day of previous month
  const lastOfPrevMonth = new Date(firstOfMonthDate);
  lastOfPrevMonth.setDate(0); // day 0 of current month = last day of prev month
  const lastOfPrevMonthStr = toLocalDateString(lastOfPrevMonth, timezone);

  const firstOfPrevMonth = new Date(lastOfPrevMonth);
  firstOfPrevMonth.setDate(1);
  const firstOfPrevMonthStr = toLocalDateString(firstOfPrevMonth, timezone);

  // Last 7 days
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
  const sevenDaysAgoStr = toLocalDateString(sevenDaysAgo, timezone);

  switch (preset) {
    case "today":
      return { startDate: todayStr, endDate: todayStr };
    case "yesterday":
      return { startDate: yesterdayStr, endDate: yesterdayStr };
    case "last7":
      return { startDate: sevenDaysAgoStr, endDate: todayStr };
    case "thisMonth":
      return { startDate: firstOfMonthStr, endDate: todayStr };
    case "lastMonth":
      return { startDate: firstOfPrevMonthStr, endDate: lastOfPrevMonthStr };
    default:
      return { startDate: "", endDate: "" };
  }
}

// ── Common IANA timezone options ──────────────────────────────────────────

const COMMON_TIMEZONES = [
  "UTC",
  "Africa/Lagos",       // WAT  GMT+1
  "Africa/Nairobi",     // EAT  GMT+3
  "Africa/Johannesburg",// SAST GMT+2
  "Africa/Accra",       // GMT  GMT+0
  "America/New_York",   // EST  GMT-5
  "America/Chicago",    // CST  GMT-6
  "America/Denver",     // MST  GMT-7
  "America/Los_Angeles",// PST  GMT-8
  "Europe/London",      // GMT/BST
  "Europe/Paris",       // CET  GMT+1
  "Asia/Dubai",         // GST  GMT+4
  "Asia/Kolkata",       // IST  GMT+5:30
  "Asia/Singapore",     // SGT  GMT+8
  "Asia/Tokyo",         // JST  GMT+9
  "Australia/Sydney",   // AEST GMT+10
  "Pacific/Auckland",   // NZST GMT+12
];

/**
 * Get browser's IANA timezone.
 */
function getBrowserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// ── Component ────────────────────────────────────────────────────────────────

const PRESETS = ["today", "yesterday", "last7", "thisMonth", "lastMonth", "custom"];

export default function DateRangePicker({
  startDate = "",
  endDate = "",
  timezone: tzProp,
  onChange,
  className = "",
}) {
  const { t } = useTranslation();
  const uid = useId();

  // Resolve timezone: prop > localStorage (school TZ) > browser TZ
  const resolveInitialTz = () => {
    if (tzProp) return tzProp;
    try {
      const stored = localStorage.getItem("schoolTimezone");
      if (stored) return stored;
    } catch { /* ignore */ }
    return getBrowserTimezone();
  };

  const [timezone, setTimezone] = useState(resolveInitialTz);
  const [activePreset, setActivePreset] = useState("custom");
  const [showTzSelector, setShowTzSelector] = useState(false);

  // Determine whether a preset is active based on current dates
  const matchPreset = useCallback(
    (preset) => {
      if (preset === "custom") return false;
      const computed = computePreset(preset, timezone);
      return computed.startDate === startDate && computed.endDate === endDate;
    },
    [startDate, endDate, timezone]
  );

  const handlePreset = (preset) => {
    setActivePreset(preset);
    if (preset === "custom") {
      // Keep existing dates but allow manual editing
      if (onChange) onChange({ startDate, endDate, timezone });
      return;
    }
    const computed = computePreset(preset, timezone);
    if (onChange) onChange({ ...computed, timezone });
  };

  const handleStartDate = (e) => {
    setActivePreset("custom");
    if (onChange) onChange({ startDate: e.target.value, endDate, timezone });
  };

  const handleEndDate = (e) => {
    setActivePreset("custom");
    if (onChange) onChange({ startDate, endDate: e.target.value, timezone });
  };

  const handleTimezone = (e) => {
    const newTz = e.target.value;
    setTimezone(newTz);
    // Recompute the current active preset in the new timezone
    const currentPreset = PRESETS.find((p) => p !== "custom" && matchPreset(p)) || activePreset;
    if (currentPreset !== "custom") {
      const computed = computePreset(currentPreset, newTz);
      if (onChange) onChange({ ...computed, timezone: newTz });
    } else {
      if (onChange) onChange({ startDate, endDate, timezone: newTz });
    }
  };

  const utcLabel = getUtcOffsetLabel(timezone);

  return (
    <div className={`drp-root ${className}`} aria-label={t("dateRangePicker.ariaLabel")}>
      <style>{`
        .drp-root {
          display: flex;
          flex-direction: column;
          gap: 0.625rem;
        }

        .drp-tz-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          flex-wrap: wrap;
        }

        .drp-tz-badge {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          font-size: 0.72rem;
          font-weight: 700;
          color: var(--text-muted);
          letter-spacing: 0.04em;
          text-transform: uppercase;
          padding: 0.2rem 0.5rem;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: var(--bg-subtle, var(--bg));
          flex-shrink: 0;
        }

        .drp-tz-toggle {
          background: transparent;
          border: none;
          color: var(--accent);
          font-size: 0.72rem;
          font-family: inherit;
          font-weight: 600;
          cursor: pointer;
          padding: 0.2rem 0.3rem;
          border-radius: 4px;
          transition: background 0.12s;
          flex-shrink: 0;
        }
        .drp-tz-toggle:hover { background: var(--accent-subtle); }
        .drp-tz-toggle:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }

        .drp-tz-select {
          width: 100%;
          padding: 0.35rem 0.6rem;
          border: 1.5px solid var(--accent);
          border-radius: var(--radius-sm);
          font-size: 0.8rem;
          font-family: inherit;
          color: var(--text);
          background: var(--card-bg);
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .drp-tz-select:focus {
          box-shadow: 0 0 0 3px var(--accent-subtle);
        }

        .drp-presets {
          display: flex;
          flex-wrap: wrap;
          gap: 0.35rem;
        }

        .drp-preset-btn {
          padding: 0.3rem 0.7rem;
          border: 1.5px solid var(--border);
          border-radius: 20px;
          background: transparent;
          color: var(--text-muted);
          font-size: 0.775rem;
          font-family: inherit;
          font-weight: 500;
          cursor: pointer;
          transition: border-color 0.15s, background 0.15s, color 0.15s;
          white-space: nowrap;
        }
        .drp-preset-btn:hover {
          border-color: var(--accent);
          color: var(--accent);
          background: var(--accent-subtle);
        }
        .drp-preset-btn:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }
        .drp-preset-btn.active {
          border-color: var(--accent);
          background: var(--accent);
          color: #fff;
          font-weight: 600;
        }

        .drp-inputs {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 0.5rem;
        }

        .drp-input-group {
          display: flex;
          flex-direction: column;
          gap: 0.2rem;
        }

        .drp-label {
          font-size: 0.7rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text-muted);
        }

        .drp-date-input {
          width: 100%;
          padding: 0.425rem 0.65rem;
          border: 1.5px solid var(--border);
          border-radius: var(--radius-sm);
          font-size: 0.825rem;
          font-family: inherit;
          color: var(--text);
          background: var(--card-bg);
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
          box-sizing: border-box;
        }
        .drp-date-input:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-subtle);
        }

        @media (max-width: 480px) {
          .drp-inputs {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      {/* Timezone indicator */}
      <div className="drp-tz-header">
        <span className="drp-tz-badge" aria-label={t("dateRangePicker.timezoneLabel", { tz: timezone })}>
          🕐 {timezone} {utcLabel && `(${utcLabel})`}
        </span>
        <button
          type="button"
          className="drp-tz-toggle"
          onClick={() => setShowTzSelector((v) => !v)}
          aria-expanded={showTzSelector}
          aria-controls={`${uid}-tz-select`}
        >
          {showTzSelector
            ? t("dateRangePicker.hideTimezone")
            : t("dateRangePicker.changeTimezone")}
        </button>
      </div>

      {/* Timezone override selector */}
      {showTzSelector && (
        <div>
          <label
            id={`${uid}-tz-label`}
            className="drp-label"
            htmlFor={`${uid}-tz-select`}
          >
            {t("dateRangePicker.timezoneSelectLabel")}
          </label>
          <select
            id={`${uid}-tz-select`}
            className="drp-tz-select"
            value={timezone}
            onChange={handleTimezone}
            aria-labelledby={`${uid}-tz-label`}
          >
            {COMMON_TIMEZONES.map((tz) => {
              const offset = getUtcOffsetLabel(tz);
              return (
                <option key={tz} value={tz}>
                  {tz} {offset ? `(${offset})` : ""}
                </option>
              );
            })}
          </select>
        </div>
      )}

      {/* Presets */}
      <div className="drp-presets" role="group" aria-label={t("dateRangePicker.presetsLabel")}>
        {PRESETS.map((preset) => {
          const isActive =
            preset === "custom"
              ? !PRESETS.filter((p) => p !== "custom").some((p) => matchPreset(p))
              : matchPreset(preset);
          return (
            <button
              key={preset}
              type="button"
              className={`drp-preset-btn${isActive ? " active" : ""}`}
              onClick={() => handlePreset(preset)}
              aria-pressed={isActive}
            >
              {t(`dateRangePicker.preset.${preset}`)}
            </button>
          );
        })}
      </div>

      {/* Date inputs */}
      <div className="drp-inputs">
        <div className="drp-input-group">
          <label
            className="drp-label"
            htmlFor={`${uid}-start`}
          >
            {t("dateRangePicker.fromLabel")}
          </label>
          <input
            id={`${uid}-start`}
            type="date"
            value={startDate}
            onChange={handleStartDate}
            max={endDate || undefined}
            className="drp-date-input"
            aria-label={t("dateRangePicker.fromAriaLabel")}
          />
        </div>
        <div className="drp-input-group">
          <label
            className="drp-label"
            htmlFor={`${uid}-end`}
          >
            {t("dateRangePicker.toLabel")}
          </label>
          <input
            id={`${uid}-end`}
            type="date"
            value={endDate}
            onChange={handleEndDate}
            min={startDate || undefined}
            className="drp-date-input"
            aria-label={t("dateRangePicker.toAriaLabel")}
          />
        </div>
      </div>
    </div>
  );
}
