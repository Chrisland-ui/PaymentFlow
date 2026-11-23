/**
 * Reusable skeleton loading components (issue #13).
 *
 * All skeletons use the `skeleton-block` CSS class defined in globals.css,
 * which provides a pulse animation that is automatically suppressed for users
 * who have `prefers-reduced-motion: reduce` set in their OS/browser.
 *
 * At runtime, a JS media-query check is also performed so that components
 * rendered server-side (where CSS media queries are not evaluated) still
 * honour the user preference once hydrated.
 */

import { useMemo } from "react";

/**
 * Detect whether the user prefers reduced motion.
 * Returns false in SSR environments where `window` is not available.
 */
function useReducedMotion() {
  return useMemo(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);
}

// ─── Primitive block ─────────────────────────────────────────────────────────

/**
 * A single rectangular skeleton placeholder.
 *
 * @param {{ width?: number|string, height?: number|string, borderRadius?: number|string, style?: object, className?: string }} props
 */
export function SkeletonBlock({ width, height, borderRadius, style, className = "" }) {
  const reducedMotion = useReducedMotion();
  const cls = ["skeleton-block", reducedMotion ? "skeleton-static" : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={cls}
      aria-hidden="true"
      style={{
        width:        width        !== undefined ? width        : "100%",
        height:       height       !== undefined ? height       : 12,
        borderRadius: borderRadius !== undefined ? borderRadius : 4,
        ...style,
      }}
    />
  );
}

// ─── Text lines ───────────────────────────────────────────────────────────────

/**
 * One or more text-line placeholders.
 *
 * @param {{ lines?: number, width?: number|string, lastLineWidth?: number|string, className?: string }} props
 */
export function SkeletonText({ lines = 1, width = "100%", lastLineWidth = "65%", className = "" }) {
  return (
    <div className={className} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonBlock
          key={i}
          height={12}
          width={i === lines - 1 && lines > 1 ? lastLineWidth : width}
          style={i < lines - 1 ? { marginBottom: 8 } : undefined}
        />
      ))}
    </div>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────

/**
 * Skeleton that matches the exact dimensions of a `StatCard` from PageHero.
 * Preserves the card's layout so the stat-grid does not reflow when data loads.
 */
export function SkeletonStatCard() {
  return (
    <div className="stat-card" aria-hidden="true" aria-label="Loading stat">
      {/* Icon placeholder */}
      <SkeletonBlock width={42} height={42} borderRadius={12} style={{ marginBottom: 16 }} />
      {/* Label */}
      <SkeletonBlock width="60%" height={10} style={{ marginBottom: 12 }} />
      {/* Value */}
      <SkeletonBlock width="45%" height={30} />
    </div>
  );
}

// ─── Table row ────────────────────────────────────────────────────────────────

/**
 * A skeleton `<tr>` row whose cells match the dashboard student table columns:
 *   Student ID | Name | Class (sm) | Fee (sm) | Status (xs) | Action button
 *
 * @param {{ index?: number }} props
 */
export function SkeletonTableRow({ index = 0 }) {
  return (
    <tr aria-hidden="true" key={index}>
      <td><SkeletonBlock height={12} width={72} /></td>
      <td><SkeletonBlock height={12} width={130} /></td>
      <td className="col-hide-sm"><SkeletonBlock height={12} width={44} /></td>
      <td className="col-hide-sm"><SkeletonBlock height={12} width={56} /></td>
      <td className="col-hide-xs"><SkeletonBlock height={20} width={52} borderRadius={20} /></td>
      <td><SkeletonBlock height={28} width={42} borderRadius={6} /></td>
    </tr>
  );
}

export function SkeletonTable({ columns, rows = 5, className = "data-table" }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label="Loading...">
      <table className={className} aria-hidden="true">
        <thead>
          <tr>{columns.map((width, index) => <th key={index}><SkeletonBlock width={width} height={12} /></th>)}</tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, rowIndex) => (
            <tr key={rowIndex} aria-hidden="true">
              {columns.map((width, columnIndex) => <td key={columnIndex}><SkeletonBlock width={width} height={12} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Detail card ─────────────────────────────────────────────────────────────

/**
 * A skeleton for a generic card with a header bar and three body rows.
 * Useful for detail panels and summary sections.
 *
 * @param {{ rows?: number }} props
 */
export function SkeletonDetailCard({ rows = 3 }) {
  return (
    <div className="card" aria-hidden="true" aria-label="Loading content">
      {/* Card header */}
      <div className="card-header" style={{ alignItems: "center" }}>
        <SkeletonBlock width={160} height={14} />
        <SkeletonBlock width={60} height={10} style={{ marginLeft: "auto" }} />
      </div>
      {/* Card body rows */}
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <SkeletonBlock width={80} height={11} />
            <SkeletonBlock width="40%" height={11} />
            <SkeletonBlock width="25%" height={11} style={{ marginLeft: "auto" }} />
          </div>
        ))}
      </div>
    </div>
  );
}
