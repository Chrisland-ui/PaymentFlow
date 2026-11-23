import { useTableDensity, DENSITY_LEVELS } from "../hooks/useTableDensity";

/**
 * DataTable — #361
 *
 * A standardised data table with:
 *   - Three density levels (compact / default / comfortable)
 *   - Column priority system for responsive hiding
 *   - Density toggle toolbar
 *   - Consistent padding, font size and row height across the platform
 *
 * Column priority system:
 *   1 — Always visible
 *   2 — Hidden at ≤ 768 px (tablet)
 *   3 — Hidden at ≤ 480 px (mobile)
 *
 * Usage:
 *   <DataTable
 *     tableId="payments"          // optional — enables per-table density preference
 *     columns={[
 *       { key: "date",     header: "Date",   priority: 1 },
 *       { key: "student",  header: "Student",priority: 1 },
 *       { key: "amount",   header: "Amount", priority: 1 },
 *       { key: "class",    header: "Class",  priority: 2 },  // hidden ≤ 768px
 *       { key: "txHash",   header: "Tx Hash",priority: 3 },  // hidden ≤ 480px
 *     ]}
 *     rows={payments}
 *     renderCell={(row, col) => row[col.key]}
 *     showDensityToggle             // optional — renders density switcher
 *     caption="Payment records"     // optional accessible caption
 *     emptyMessage="No records"     // optional
 *   />
 *
 * @param {object}   props
 * @param {string}   [props.tableId]           - Per-table density scope
 * @param {object[]} props.columns             - Column definitions (key, header, priority, style, align)
 * @param {object[]} props.rows                - Row data array
 * @param {Function} props.renderCell          - (row, column, rowIndex) => ReactNode
 * @param {Function} [props.getRowKey]         - (row, index) => string key (defaults to index)
 * @param {boolean}  [props.showDensityToggle] - Show density switcher above the table
 * @param {string}   [props.caption]           - Accessible table caption (visually hidden by default)
 * @param {boolean}  [props.showCaption]       - Make caption visible
 * @param {string}   [props.emptyMessage]      - Message when rows is empty
 * @param {object}   [props.style]             - Extra style on the wrapper div
 */
export default function DataTable({
  tableId,
  columns = [],
  rows = [],
  renderCell,
  getRowKey,
  showDensityToggle = false,
  caption,
  showCaption = false,
  emptyMessage = "No data available.",
  style,
}) {
  const { density, setDensity, rowHeight, cellPadding, fontSize } = useTableDensity(tableId);

  return (
    <div style={{ ...style }}>
      {/* Density toggle toolbar */}
      {showDensityToggle && (
        <DensityToggle density={density} onSelect={setDensity} />
      )}

      {/* Responsive scroll wrapper */}
      <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
        <table
          className="data-table"
          style={{ fontSize, width: "100%", borderCollapse: "collapse" }}
        >
          {caption && (
            <caption
              style={
                showCaption
                  ? { textAlign: "left", fontSize: "0.875rem", fontWeight: 600, padding: "0.5rem 0", color: "var(--text)" }
                  : { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0,0,0,0)", whiteSpace: "nowrap" }
              }
            >
              {caption}
            </caption>
          )}

          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  data-priority={col.priority ?? 1}
                  style={{
                    height:      rowHeight,
                    padding:     cellPadding,
                    textAlign:   col.align || "left",
                    fontWeight:  600,
                    fontSize:    "0.8rem",
                    color:       "var(--text-muted)",
                    whiteSpace:  "nowrap",
                    borderBottom:"1px solid var(--border)",
                    ...getResponsiveStyle(col.priority),
                    ...col.style,
                  }}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  style={{
                    textAlign: "center",
                    padding: "2.5rem 1rem",
                    color: "var(--text-muted)",
                    fontSize: "0.875rem",
                  }}
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row, rowIndex) => (
                <tr
                  key={getRowKey ? getRowKey(row, rowIndex) : rowIndex}
                  style={{ transition: "background 0.1s ease" }}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      data-priority={col.priority ?? 1}
                      style={{
                        height:     rowHeight,
                        padding:    cellPadding,
                        textAlign:  col.align || "left",
                        borderBottom: "1px solid var(--border)",
                        verticalAlign: "middle",
                        ...getResponsiveStyle(col.priority),
                        ...col.cellStyle,
                      }}
                    >
                      {renderCell ? renderCell(row, col, rowIndex) : row[col.key]}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Responsive breakpoint CSS */}
      <style>{`
        /* Priority-2 columns — hide at tablet breakpoint */
        @media (max-width: 768px) {
          [data-priority="2"] { display: none; }
        }
        /* Priority-3 columns — hide at mobile breakpoint */
        @media (max-width: 480px) {
          [data-priority="3"] { display: none; }
        }
        /* Ensure table is usable at 375px with graceful horizontal scroll */
        @media (max-width: 375px) {
          .data-table { min-width: 320px; }
        }
      `}</style>
    </div>
  );
}

/* ── DensityToggle ────────────────────────────────────────────────────────── */

/**
 * DensityToggle
 *
 * A compact segmented control for switching between the three density levels.
 * Keyboard-accessible: uses role="group" + individual buttons.
 */
export function DensityToggle({ density, onSelect, className }) {
  const levels = Object.values(DENSITY_LEVELS);

  return (
    <div
      role="group"
      aria-label="Table row density"
      className={className}
      style={{
        display: "inline-flex",
        gap: "0",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        overflow: "hidden",
        marginBottom: "0.75rem",
      }}
    >
      {levels.map((level) => {
        const isActive = density === level.id;
        return (
          <button
            key={level.id}
            onClick={() => onSelect(level.id)}
            aria-pressed={isActive}
            title={level.description}
            style={{
              padding: "0.3rem 0.75rem",
              fontSize: "0.775rem",
              fontWeight: isActive ? 600 : 400,
              background: isActive ? "var(--accent)" : "var(--card-bg)",
              color:      isActive ? "#fff" : "var(--text-muted)",
              border:     "none",
              borderRight:"1px solid var(--border)",
              cursor:     "pointer",
              transition: "background 0.15s ease, color 0.15s ease",
              display:    "flex",
              alignItems: "center",
              gap:        "0.3rem",
              outline:    isActive ? "none" : undefined,
            }}
          >
            <RowIcon height={level.rowHeight} />
            {level.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

/**
 * Returns a CSS style object that hides elements at responsive breakpoints.
 * Because we use a <style> block for @media queries, this function returns
 * {} so individual cell styles don't conflict with media-query class rules.
 * The data-priority attribute carries the value for the stylesheet to act on.
 */
function getResponsiveStyle() {
  return {};
}

/** Tiny icon representing row height visually */
function RowIcon({ height }) {
  const gap = height <= 28 ? 2 : height <= 40 ? 4 : 6;
  return (
    <svg
      aria-hidden="true"
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="currentColor"
    >
      <rect x="0" y="1"      width="14" height="2" rx="1" />
      <rect x="0" y={3 + gap} width="14" height="2" rx="1" />
      <rect x="0" y={5 + gap * 2} width="14" height="2" rx="1" />
    </svg>
  );
}
