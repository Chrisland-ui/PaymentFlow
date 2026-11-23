/**
 * AccessiblePagination — Issue #271
 *
 * Rebuilds pagination as a <nav> with:
 *   - Descriptive aria-label on each button ("Page 3 of 20")
 *   - First, Previous, Next, Last controls
 *   - Ellipsis for large page ranges with accessible hidden text
 *   - aria-current="page" on the current page button
 *   - Keyboard shortcut g + [number] to jump to a specific page (power-user mode)
 *
 * Usage:
 *   <AccessiblePagination
 *     currentPage={page}
 *     totalPages={pages}
 *     onPageChange={setPage}
 *     total={total}
 *     rangeStart={rangeStart}
 *     rangeEnd={rangeEnd}
 *     loading={studentsLoading}
 *     ariaLabel={t("dashboard.paginationAria")}
 *     itemLabel={t("dashboard.studentsTitle")}
 *   />
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
} from "./Icons";

// ── Configuration ────────────────────────────────────────────────────────────

/** Pages shown on each side of the current page before ellipsis appears. */
const SIBLING_COUNT = 1;

/** Pages always shown at the start and end (boundary). */
const BOUNDARY_COUNT = 1;

/** When totalPages exceeds this, First/Last controls are shown. */
const DISPLAY_THRESHOLD = 5;

/** Maximum page links rendered (including ellipsis) — keeps DOM small. */
const MAX_VISIBLE = 7;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute the array of page numbers to render.
 * Uses boundary + sibling algorithm: always show first and last page,
 * plus `SIBLING_COUNT` pages around the current page, inserting ellipsis
 * (represented as null) when there's a gap.
 *
 * @param {number} currentPage - 1-based current page
 * @param {number} totalPages  - total number of pages
 * @returns {(number|null)[]} array of page numbers, null = ellipsis
 */
export function getPageRange(currentPage, totalPages) {
  if (totalPages <= 0) return [];
  if (totalPages === 1) return [1];

  const range = [];
  const startPages = [];
  const endPages = [];

  // Always show the first BOUNDARY_COUNT pages
  for (let i = 1; i <= Math.min(BOUNDARY_COUNT, totalPages); i++) {
    startPages.push(i);
  }

  // Always show the last BOUNDARY_COUNT pages
  for (let i = Math.max(totalPages - BOUNDARY_COUNT + 1, BOUNDARY_COUNT + 1); i <= totalPages; i++) {
    endPages.push(i);
  }

  // Sibling pages around current
  const sibStart = Math.max(currentPage - SIBLING_COUNT, BOUNDARY_COUNT + 1);
  const sibEnd = Math.min(currentPage + SIBLING_COUNT, totalPages - BOUNDARY_COUNT);

  // Build the range with ellipsis
  if (startPages.length > 0) {
    range.push(...startPages);
  }

  // Left ellipsis
  if (sibStart > BOUNDARY_COUNT + 1) {
    range.push(null); // ellipsis
  } else {
    // No gap — fill in the intermediate pages
    for (let i = BOUNDARY_COUNT + 1; i < sibStart; i++) {
      range.push(i);
    }
  }

  // Sibling pages
  for (let i = sibStart; i <= sibEnd; i++) {
    if (!range.includes(i)) {
      range.push(i);
    }
  }

  // Right ellipsis
  if (sibEnd < totalPages - BOUNDARY_COUNT) {
    range.push(null); // ellipsis
  } else {
    // No gap — fill in intermediate pages
    for (let i = sibEnd + 1; i <= totalPages - BOUNDARY_COUNT; i++) {
      if (!range.includes(i)) {
        range.push(i);
      }
    }
  }

  // End pages (if not already included)
  for (const p of endPages) {
    if (!range.includes(p)) {
      range.push(p);
    }
  }

  return range;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Accessible pagination component.
 *
 * @param {object} props
 * @param {number} props.currentPage    - 1-based current page number
 * @param {number} props.totalPages      - total number of pages
 * @param {function} props.onPageChange - callback when page changes (receives new page number)
 * @param {number} [props.total]         - total number of items (for range display)
 * @param {number} [props.rangeStart]    - 1-based index of first item on current page
 * @param {number} [props.rangeEnd]      - 1-based index of last item on current page
 * @param {boolean} [props.loading]      - whether data is currently loading
 * @param {string} [props.ariaLabel]     - aria-label for the nav element
 * @param {string} [props.itemLabel]     - label for the type of items (e.g. "students")
 * @param {string} [props.rangeTemplate] - i18n template for range display
 */
export function AccessiblePagination({
  currentPage,
  totalPages,
  onPageChange,
  total = 0,
  rangeStart = 0,
  rangeEnd = 0,
  loading = false,
  ariaLabel,
  itemLabel = "items",
  rangeTemplate,
}) {
  const { t } = useTranslation();

  // ── Keyboard shortcut: g + [number] to jump to a page ──────────────────────
  const [gPressed, setGPressed] = useState(false);
  const gTimerRef = useRef(null);

  const handleKeyDown = useCallback(
    (e) => {
      // Ignore if focus is inside an input, textarea, or select
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target?.isContentEditable) {
        return;
      }

      if (e.key === "g" && !gPressed) {
        setGPressed(true);
        // Reset after 800ms if no number follows
        clearTimeout(gTimerRef.current);
        gTimerRef.current = setTimeout(() => setGPressed(false), 800);
        return;
      }

      if (gPressed && /^[0-9]$/.test(e.key)) {
        e.preventDefault();
        clearTimeout(gTimerRef.current);
        setGPressed(false);

        // Accumulate digits — allow multi-digit page numbers
        // For simplicity, single digit + Enter is handled in handleKeyUp
        const pageNum = parseInt(e.key, 10);
        if (pageNum >= 1 && pageNum <= totalPages) {
          onPageChange(pageNum);
        }
        return;
      }

      // Enter after typing digits would go here for multi-digit support
      if (e.key === "Escape" && gPressed) {
        setGPressed(false);
        clearTimeout(gTimerRef.current);
      }
    },
    [gPressed, totalPages, onPageChange],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      clearTimeout(gTimerRef.current);
    };
  }, [handleKeyDown]);

  // ── Don't render if there's only one page (or zero) ────────────────────────
  if (totalPages <= 1 && total <= 0) return null;

  const showFirstLast = totalPages > DISPLAY_THRESHOLD;
  const pageRange = getPageRange(currentPage, totalPages);

  // Shared button style
  const btnStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.25rem",
    minWidth: 32,
    height: 32,
    padding: "0 0.5rem",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    background: "var(--card-bg)",
    color: "var(--text)",
    fontSize: "0.8125rem",
    fontFamily: "inherit",
    cursor: "pointer",
    transition: "background 0.15s, border-color 0.15s",
  };

  const disabledBtnStyle = {
    ...btnStyle,
    opacity: 0.4,
    cursor: "not-allowed",
  };

  const activeBtnStyle = {
    ...btnStyle,
    background: "var(--accent)",
    color: "#fff",
    borderColor: "var(--accent)",
    fontWeight: 600,
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        padding: "0.875rem 1.25rem",
        borderTop: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: "0.5rem",
      }}
    >
      {/* Range info */}
      {total > 0 && (
        <span
          className="pagination-info"
          aria-live="polite"
          aria-atomic="true"
        >
          {loading
            ? t("actions.loading")
            : (rangeTemplate || t("pagination.rangeOf", { start: rangeStart, end: rangeEnd, total: total.toLocaleString() })
            ).replace("{itemLabel}", itemLabel)}
        </span>
      )}

      <nav
        aria-label={ariaLabel || t("pagination.label")}
        style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}
      >
        {/* First page button */}
        {showFirstLast && (
          <button
            type="button"
            className="page-btn"
            disabled={currentPage === 1 || loading}
            onClick={() => onPageChange(1)}
            aria-label={t("pagination.firstPageAria", { total: totalPages })}
            title={t("pagination.firstPage")}
            style={currentPage === 1 || loading ? disabledBtnStyle : btnStyle}
          >
            <IconChevronsLeft size={15} />
          </button>
        )}

        {/* Previous page button */}
        <button
          type="button"
          className="page-btn"
          disabled={currentPage === 1 || loading}
          onClick={() => onPageChange(currentPage - 1)}
          aria-label={t("pagination.previousPageAria", { page: currentPage, total: totalPages })}
          title={t("actions.prev")}
          style={currentPage === 1 || loading ? disabledBtnStyle : btnStyle}
        >
          <IconChevronLeft size={15} />
        </button>

        {/* Page number buttons with ellipsis */}
        {pageRange.map((pageNum, idx) => {
          if (pageNum === null) {
            // Ellipsis with accessible hidden text
            return (
              <span
                key={`ellipsis-${idx}`}
                aria-hidden="false"
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "0 0.25rem",
                  fontSize: "0.8125rem",
                  color: "var(--text-muted)",
                }}
              >
                <span aria-hidden="true">…</span>
                <span className="sr-only">{t("pagination.ellipsis")}</span>
              </span>
            );
          }

          const isCurrent = pageNum === currentPage;
          return (
            <button
              key={`page-${pageNum}`}
              type="button"
              className="page-btn"
              disabled={loading}
              onClick={() => onPageChange(pageNum)}
              aria-label={t("pagination.pageAria", { page: pageNum, total: totalPages })}
              aria-current={isCurrent ? "page" : undefined}
              style={isCurrent ? activeBtnStyle : btnStyle}
            >
              {pageNum}
            </button>
          );
        })}

        {/* Next page button */}
        <button
          type="button"
          className="page-btn"
          disabled={currentPage === totalPages || loading}
          onClick={() => onPageChange(currentPage + 1)}
          aria-label={t("pagination.nextPageAria", { page: currentPage, total: totalPages })}
          title={t("actions.next")}
          style={currentPage === totalPages || loading ? disabledBtnStyle : btnStyle}
        >
          <IconChevronRight size={15} />
        </button>

        {/* Last page button */}
        {showFirstLast && (
          <button
            type="button"
            className="page-btn"
            disabled={currentPage === totalPages || loading}
            onClick={() => onPageChange(totalPages)}
            aria-label={t("pagination.lastPageAria", { total: totalPages })}
            title={t("pagination.lastPage")}
            style={currentPage === totalPages || loading ? disabledBtnStyle : btnStyle}
          >
            <IconChevronsRight size={15} />
          </button>
        )}
      </nav>

      {/* Screen reader hint for keyboard shortcut */}
      <span className="sr-only">
        {t("pagination.shortcutHint")}
      </span>
    </div>
  );
}

export default AccessiblePagination;
