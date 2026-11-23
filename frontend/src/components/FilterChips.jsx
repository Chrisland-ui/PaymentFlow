/**
 * FilterChips — Issue #355
 *
 * Displays active filters as removable chips below the search/filter toolbar.
 * Each chip shows the filter name + value and has an accessible remove button.
 * A "Clear all" chip appears when 2+ filters are active.
 *
 * Props:
 *  - filters: Array of { key, label, value, displayValue? }
 *    key         — unique identifier for this filter (used in onRemove callback)
 *    label       — human-readable filter name (e.g. "Status", "Class")
 *    value       — raw filter value (used for equality check; falsy = inactive)
 *    displayValue — optional formatted display string (falls back to value)
 *  - onRemove(key)  — called when a chip's × button is clicked
 *  - onClearAll()   — called when the "Clear all" chip is clicked
 */

import { IconX } from "./Icons";

export default function FilterChips({ filters = [], onRemove, onClearAll }) {
  // Only show chips for active filters (non-empty, non-"all" values)
  const activeFilters = filters.filter(
    (f) => f.value && f.value !== "all" && f.value !== ""
  );

  if (activeFilters.length === 0) return null;

  const showClearAll = activeFilters.length >= 2;

  return (
    <>
      <style>{`
        .filter-chip-bar {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 0.5rem;
          padding: 0.625rem 0;
          /* Ensure it never breaks layout on 375px */
          max-width: 100%;
        }

        .filter-chip {
          display: inline-flex;
          align-items: center;
          gap: 0.375rem;
          padding: 0.3rem 0.375rem 0.3rem 0.625rem;
          border-radius: 20px;
          font-size: 0.78rem;
          font-weight: 500;
          line-height: 1;
          white-space: nowrap;
          background: var(--accent-subtle);
          border: 1.5px solid var(--accent-ring);
          color: var(--accent);
          max-width: 220px;
          overflow: hidden;
          text-overflow: ellipsis;
          transition: background 0.12s, border-color 0.12s;
        }
        .filter-chip:hover {
          background: var(--accent-subtle);
          border-color: var(--accent);
        }

        .filter-chip-label {
          font-weight: 600;
          color: var(--text-muted);
          margin-right: 1px;
        }

        .filter-chip-value {
          color: var(--text);
          max-width: 120px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .filter-chip-key {
          font-weight: 400;
          opacity: 0.75;
          margin-right: 0.125rem;
        }
        .filter-chip-remove {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          border: none;
          background: none;
          cursor: pointer;
          color: var(--text-muted);
          padding: 0;
          flex-shrink: 0;
          transition: background 0.12s, color 0.12s;
          margin-left: 1px;
        }
        .filter-chip-remove:hover {
          background: var(--danger-bg);
          color: var(--danger-text);
        }
        .filter-chip-remove:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 1px;
        }
        .filter-chip-clear {
          display: inline-flex;
          align-items: center;
          gap: 0.25rem;
          padding: 0.3rem 0.625rem;
          border-radius: 20px;
          font-size: 0.78rem;
          font-weight: 600;
          border: 1.5px solid var(--border-strong);
          background: var(--bg-subtle);
          color: var(--text-muted);
          cursor: pointer;
          transition: background 0.12s, border-color 0.12s, color 0.12s;
          white-space: nowrap;
        }
        .filter-chip-clear:hover {
          background: var(--danger-bg);
          border-color: var(--danger-border);
          color: var(--danger-text);
        }
        .filter-chip-clear:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 1px;
        }

        @media (max-width: 375px) {
          .filter-chip { max-width: 160px; }
          .filter-chip-value { max-width: 80px; }
        }
      `}</style>

      <div
        className="filter-chip-bar"
        role="group"
        aria-label="Active filters"
      >
        {activeFilters.map((f) => {
          const display = f.displayValue ?? f.value;
          return (
            <span
              key={f.key}
              className="filter-chip"
              role="listitem"
            >
              <span className="filter-chip-label">{f.label}:</span>
              <span className="filter-chip-value" title={display}>
                {display}
              </span>
              <button
                type="button"
                className="filter-chip-remove"
                onClick={() => onRemove?.(f.key)}
                aria-label={`Remove ${f.label}: ${display} filter`}
                title={`Remove ${f.label}: ${display} filter`}
              >
                <IconX size={10} />
              </button>
            </span>
          );
        })}

        {showClearAll && (
          <button
            type="button"
            className="filter-chip-clear"
            onClick={() => onClearAll?.()}
            aria-label="Clear all active filters"
          >
            <IconX size={10} />
            Clear all
          </button>
        )}
      </div>
    </>
  );
}
