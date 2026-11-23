/**
 * Pagination — Issue #23
 *
 * Shared accessible pagination controls used across all paginated lists
 * (student dashboard, disputes, etc.).
 *
 * Features:
 *   - First / Previous / Next / Last buttons with correct disabled states
 *   - Page-size selector (configurable, default: [10, 20, 50])
 *   - Current range display  e.g. "1–20 of 150"
 *   - Keyboard accessible — all controls are native <button> / <select>
 *   - Screen-reader announcements via aria-live="polite" on the range region
 *   - Filters are preserved by the parent; this component only fires callbacks
 *
 * Usage:
 *   <Pagination
 *     page={page}
 *     pages={pages}
 *     total={total}
 *     pageSize={pageSize}
 *     pageSizeOptions={[10, 20, 50]}
 *     onPageChange={setPage}
 *     onPageSizeChange={setPageSize}
 *     loading={loading}
 *   />
 */
import { useTranslation } from "react-i18next";
import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
} from "./Icons";

/**
 * @param {object}   props
 * @param {number}   props.page              Current 1-based page number.
 * @param {number}   props.pages             Total number of pages.
 * @param {number}   props.total             Total record count.
 * @param {number}   props.pageSize          Records shown per page.
 * @param {number[]} [props.pageSizeOptions] Available page-size choices.
 * @param {function} props.onPageChange      Called with new page number.
 * @param {function} [props.onPageSizeChange] Called with new page size.
 * @param {boolean}  [props.loading]         Disables controls while data is loading.
 * @param {string}   [props.className]       Extra CSS class on the container.
 */
export default function Pagination({
  page,
  pages,
  total,
  pageSize,
  pageSizeOptions = [10, 20, 50],
  onPageChange,
  onPageSizeChange,
  loading = false,
  className = "",
}) {
  const { t } = useTranslation();

  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd   = Math.min(page * pageSize, total);

  const isFirst = page <= 1;
  const isLast  = page >= pages;

  function handleFirst()    { if (!isFirst && !loading) onPageChange(1); }
  function handlePrev()     { if (!isFirst && !loading) onPageChange(page - 1); }
  function handleNext()     { if (!isLast  && !loading) onPageChange(page + 1); }
  function handleLast()     { if (!isLast  && !loading) onPageChange(pages); }

  function handleSizeChange(e) {
    const newSize = Number(e.target.value);
    if (onPageSizeChange) onPageSizeChange(newSize);
  }

  const btnBase = {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.2rem",
    padding: "0.35rem 0.6rem",
    border: "1.5px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    background: "var(--card-bg)",
    color: "var(--text)",
    fontSize: "0.8125rem",
    fontFamily: "inherit",
    cursor: "pointer",
    transition: "background 0.12s, border-color 0.12s, opacity 0.12s",
  };

  const btnDisabled = {
    opacity: 0.4,
    cursor: "not-allowed",
    pointerEvents: "none",
  };

  return (
    <div
      className={`pagination-root${className ? ` ${className}` : ""}`}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: "0.625rem",
        padding: "0.875rem 1.25rem",
        borderTop: "1px solid var(--border)",
      }}
    >
      {/* Left side: range announcement + optional page-size selector */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.875rem", flexWrap: "wrap" }}>
        {/* aria-live region — screen readers announce range on every page change */}
        <span
          aria-live="polite"
          aria-atomic="true"
          style={{ fontSize: "0.8125rem", color: "var(--text-muted)", minWidth: "9rem" }}
        >
          {loading
            ? t("actions.loading")
            : total === 0
              ? t("pagination.noResults", "No results")
              : t("pagination.rangeOf", {
                  start: rangeStart.toLocaleString(),
                  end:   rangeEnd.toLocaleString(),
                  total: total.toLocaleString(),
                  defaultValue: `${rangeStart.toLocaleString()}–${rangeEnd.toLocaleString()} of ${total.toLocaleString()}`,
                })}
        </span>

        {onPageSizeChange && (
          <label
            style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.8125rem", color: "var(--text-muted)" }}
          >
            {t("pagination.rowsPerPage", "Rows per page")}
            <select
              value={pageSize}
              onChange={handleSizeChange}
              disabled={loading}
              aria-label={t("pagination.rowsPerPageAria", "Rows per page")}
              style={{
                padding: "0.3rem 0.5rem",
                border: "1.5px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                background: "var(--card-bg)",
                color: "var(--text)",
                fontSize: "0.8125rem",
                fontFamily: "inherit",
                cursor: loading ? "not-allowed" : "pointer",
                opacity: loading ? 0.6 : 1,
              }}
            >
              {pageSizeOptions.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* Right side: navigation controls */}
      {pages > 1 && (
        <nav aria-label={t("pagination.navAria", "Pagination")} style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
          {/* First */}
          <button
            type="button"
            onClick={handleFirst}
            disabled={isFirst || loading}
            aria-label={t("pagination.firstPage", "First page")}
            title={t("pagination.firstPage", "First page")}
            style={{ ...btnBase, ...(isFirst || loading ? btnDisabled : {}) }}
          >
            <IconChevronsLeft size={15} />
          </button>

          {/* Previous */}
          <button
            type="button"
            onClick={handlePrev}
            disabled={isFirst || loading}
            aria-label={t("actions.previousPage")}
            style={{ ...btnBase, ...(isFirst || loading ? btnDisabled : {}), gap: "0.3rem" }}
          >
            <IconChevronLeft size={15} />
            <span>{t("actions.prev")}</span>
          </button>

          {/* Current page indicator */}
          <span
            aria-current="page"
            style={{
              padding: "0.35rem 0.6rem",
              fontSize: "0.8125rem",
              color: "var(--text-muted)",
              minWidth: "4.5rem",
              textAlign: "center",
            }}
          >
            {t("time.pageOf", { page, total: pages, defaultValue: `${page} / ${pages}` })}
          </span>

          {/* Next */}
          <button
            type="button"
            onClick={handleNext}
            disabled={isLast || loading}
            aria-label={t("actions.nextPage")}
            style={{ ...btnBase, ...(isLast || loading ? btnDisabled : {}), gap: "0.3rem" }}
          >
            <span>{t("actions.next")}</span>
            <IconChevronRight size={15} />
          </button>

          {/* Last */}
          <button
            type="button"
            onClick={handleLast}
            disabled={isLast || loading}
            aria-label={t("pagination.lastPage", "Last page")}
            title={t("pagination.lastPage", "Last page")}
            style={{ ...btnBase, ...(isLast || loading ? btnDisabled : {}) }}
          >
            <IconChevronsRight size={15} />
          </button>
        </nav>
      )}
    </div>
  );
}
