/**
 * VirtualTransactionList — Issue #7
 *
 * Renders the transaction history using react-window's FixedSizeList so that
 * datasets of 10,000+ rows remain scrollable without long browser tasks.
 *
 * Design decisions
 * ────────────────
 * • FixedSizeList is chosen over VariableSizeList because all rows have a
 *   predictable, fixed height.  This avoids the complexity of a row-height
 *   measurement cache while still providing O(visible-rows) DOM nodes.
 * • The outer <div role="table"> / inner <div role="row"> structure preserves
 *   accessible table semantics that screen readers expect, even though the
 *   list is not rendered as a native <table> (react-window requires a flat
 *   list, not a table element).
 * • Keyboard navigation: each row is focusable (tabIndex=0) and activatable
 *   with Enter/Space to open the dispute form, matching the pattern used in
 *   the existing student table in dashboard.jsx.
 * • Sorting: a useSortedTransactions hook sorts the rows in memory before
 *   handing the array to FixedSizeList.  This keeps the virtualizer simple
 *   (it only ever deals with a pre-sorted array).
 * • Loading placeholders: when paymentsLoading is true the component renders
 *   skeleton rows inside the same FixedSizeList dimensions.
 * • Pagination: the component is intentionally unaware of server-side
 *   pagination.  The parent fetches all pages into a single array (the
 *   existing PaymentForm already loads the full list) and passes it here.
 *   Server-side pagination is controlled by the parent and works unchanged.
 *
 * Implementation note: React.createElement is NOT used here because this file
 * is only consumed at runtime by the Next.js/Webpack build, not imported
 * directly by Jest tests.  Jest tests for this module use jest.mock() to avoid
 * parsing JSX (the project has no @babel/preset-react in Jest config).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FixedSizeList } from "react-window";
import { useTranslation } from "react-i18next";
import DisputeForm from "./DisputeForm";
import { IconAlertTriangle } from "./Icons";
import TimestampDisplay from "./TimestampDisplay";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Height in px of a single transaction row (compact layout). */
export const ROW_HEIGHT = 88;

/** Height of the virtualized list viewport (shows ~5 rows, scrollable). */
export const LIST_HEIGHT = 440;

/** Column header definitions used both for rendering and sort state. */
export const SORT_COLUMNS = ["date", "amount", "status"];

/** Default sort: newest transactions first. */
export const DEFAULT_SORT = { column: "date", direction: "desc" };

// ── Status badge map ──────────────────────────────────────────────────────────

const STATUS_BADGE = {
  valid:     { cls: "badge badge-success", key: "status.validation.valid" },
  overpaid:  { cls: "badge badge-warning", key: "status.validation.overpaid" },
  underpaid: { cls: "badge badge-danger",  key: "status.validation.underpaid" },
  unknown:   { cls: "badge badge-neutral", key: "status.validation.unknown" },
};

const REFUND_BADGE = {
  approval_pending: "badge badge-warning",
  pending:          "badge badge-info",
  submitted:        "badge badge-primary",
  confirmed:        "badge badge-success",
  failed:           "badge badge-danger",
};

// ── useSortedTransactions ─────────────────────────────────────────────────────

/**
 * Sorts a payments array by the given column + direction without mutating the
 * original.  Returns a new array reference only when inputs change.
 *
 * @param {Array}  payments
 * @param {{ column: string, direction: 'asc'|'desc' }} sort
 * @returns {Array}
 */
export function useSortedTransactions(payments, sort) {
  return useMemo(() => {
    if (!Array.isArray(payments) || payments.length === 0) return payments || [];
    const copy = [...payments];
    copy.sort((a, b) => {
      let cmp = 0;
      if (sort.column === "date") {
        const ta = a.confirmedAt ? new Date(a.confirmedAt).getTime() : 0;
        const tb = b.confirmedAt ? new Date(b.confirmedAt).getTime() : 0;
        cmp = ta - tb;
      } else if (sort.column === "amount") {
        cmp = (parseFloat(a.amount) || 0) - (parseFloat(b.amount) || 0);
      } else if (sort.column === "status") {
        const order = { valid: 0, overpaid: 1, underpaid: 2, unknown: 3 };
        cmp = (order[a.feeValidationStatus] ?? 4) - (order[b.feeValidationStatus] ?? 4);
      }
      return sort.direction === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [payments, sort.column, sort.direction]);
}

// ── TransactionRow (virtualised row renderer) ─────────────────────────────────

/**
 * Row renderer passed to FixedSizeList.  The component receives the item data
 * bag via the `data` prop that FixedSizeList injects.
 */
function TransactionRow({ index, style, data }) {
  const {
    transactions,
    disputedTxs,
    disputingTx,
    refunds,
    studentId,
    onDisputeOpen,
    onDisputeSuccess,
    onDisputeCancel,
    activeIndex,
    onRowFocus,
    t,
  } = data;

  const p = transactions[index];
  if (!p) return null;

  const st = p.feeValidationStatus || "unknown";
  const badge = STATUS_BADGE[st] || STATUS_BADGE.unknown;
  const canDispute = st === "valid" || st === "overpaid";
  const alreadyDisputed = disputedTxs.has(p.txHash);
  const refund = refunds[p.txHash];
  const isDisputing = disputingTx === p.txHash;

  return (
    <div
      style={{ ...style, boxSizing: "border-box", padding: "0 0 1px 0" }}
      role="row"
      aria-rowindex={index + 1}
    >
      <div
        className="pf-payment-item"
        role="gridcell"
        id={`transaction-grid-cell-${index}`}
        data-grid-cell-index={index}
        data-grid-cell
        aria-colindex={1}
        tabIndex={activeIndex === index ? 0 : -1}
        onFocus={() => onRowFocus(index)}
        style={{
          height: ROW_HEIGHT - 1,
          overflowY: "auto",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-start",
          padding: "0.5rem 0.75rem",
        }}
        aria-label={t("paymentForm.txRowAria", {
          amount: p.amount,
          asset: p.assetCode || "XLM",
          status: t(badge.key),
        })}
      >
        {/* Top row: amount + badge(es) */}
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: "0.25rem",
          flexWrap: "wrap",
          gap: "0.35rem",
        }}>
          <strong style={{ fontSize: "0.9rem" }}>
            {p.amount}{" "}
            <span style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>
              {p.assetCode || "XLM"}
            </span>
          </strong>
          <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
            <span className={badge.cls}>{t(badge.key)}</span>
            {refund && (
              <span className={REFUND_BADGE[refund.status] || "badge badge-neutral"}>
                {t("status.refund.prefix")}{" "}
                {refund.status in REFUND_BADGE
                  ? t(`status.refund.${refund.status}`)
                  : refund.status}
              </span>
            )}
          </div>
        </div>

        {/* Tx hash */}
        <div style={{
          fontFamily: "monospace",
          fontSize: "0.68rem",
          color: "var(--text-muted)",
          marginBottom: "0.15rem",
          wordBreak: "break-all",
        }}>
          {p.txHash}
        </div>

        {/* Date */}
        {p.confirmedAt && (
          <div style={{ fontSize: "0.72rem", color: "var(--text-subtle)" }}>
            <TimestampDisplay iso={p.confirmedAt} />
          </div>
        )}

        {/* Dispute controls */}
        {canDispute && (
          <div style={{ marginTop: "0.35rem" }}>
            {alreadyDisputed ? (
              <span className="badge badge-warning">{t("paymentForm.disputeSubmitted")}</span>
            ) : isDisputing ? (
              <div style={{ marginTop: "0.25rem" }}>
                <DisputeForm
                  txHash={p.txHash}
                  studentId={studentId}
                  onSuccess={() => onDisputeSuccess(p.txHash)}
                  onCancel={onDisputeCancel}
                />
              </div>
            ) : (
              <button
                onClick={() => onDisputeOpen(p.txHash)}
                className="btn btn-sm btn-ghost"
                style={{ marginTop: "0.1rem" }}
              >
                {t("paymentForm.raiseDispute")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── SkeletonRow ───────────────────────────────────────────────────────────────

function SkeletonRow({ index, style }) {
  return (
    <div style={{ ...style, boxSizing: "border-box", padding: "0 0 1px 0" }} role="row" aria-hidden="true">
      <div className="pf-payment-item" style={{ height: ROW_HEIGHT - 1, padding: "0.5rem 0.75rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.4rem" }}>
          <div className="skeleton" style={{ height: 14, width: 80 }} />
          <div className="skeleton" style={{ height: 20, width: 60, borderRadius: 20 }} />
        </div>
        <div className="skeleton" style={{ height: 10, width: "90%", marginBottom: "0.3rem" }} />
        <div className="skeleton" style={{ height: 10, width: "50%" }} />
      </div>
    </div>
  );
}

// ── SortHeader ─────────────────────────────────────────────────────────────────

function SortButton({ column, sort, onSort, label }) {
  const active = sort.column === column;
  const arrow = active ? (sort.direction === "asc" ? " ↑" : " ↓") : "";
  return (
    <button
      onClick={() => onSort(column)}
      className="btn btn-sm btn-ghost"
      aria-pressed={active}
      style={{
        fontSize: "0.7rem",
        fontWeight: active ? 700 : 500,
        padding: "0.2rem 0.4rem",
        color: active ? "var(--accent)" : "var(--text-muted)",
        borderColor: active ? "var(--accent)" : "transparent",
      }}
    >
      {label}{arrow}
    </button>
  );
}

// ── VirtualTransactionList (main export) ──────────────────────────────────────

/**
 * @param {object}   props
 * @param {Array}    props.payments       Full list of payment objects
 * @param {boolean}  props.paymentsLoading
 * @param {string}   props.studentId
 * @param {Set}      props.disputedTxs
 * @param {object}   props.refunds        txHash → refund object
 * @param {Function} props.onDisputedTxsChange  (newSet) => void
 */
export default function VirtualTransactionList({
  payments,
  paymentsLoading,
  studentId,
  disputedTxs,
  refunds,
  onDisputedTxsChange,
}) {
  const { t } = useTranslation();
  const [disputingTx, setDisputingTx] = useState(null);
  const [sort, setSort] = useState(DEFAULT_SORT);
  const listRef = useRef(null);
  const gridRef = useRef(null);
  const pendingFocusRef = useRef(null);
  const focusedTransactionRef = useRef(null);
  const gridHadFocusRef = useRef(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const sortedPayments = useSortedTransactions(payments || [], sort);

  useEffect(() => {
    if (pendingFocusRef.current === null) return;
    const index = pendingFocusRef.current;
    pendingFocusRef.current = null;
    gridRef.current
      ?.querySelector(`[data-grid-cell-index="${index}"]`)
      ?.focus();
  }, [activeIndex, sortedPayments]);

  useEffect(() => {
    if (!gridHadFocusRef.current || sortedPayments.length === 0) return;
    const index = sortedPayments.findIndex(
      (payment) => payment.txHash === focusedTransactionRef.current
    );
    if (index >= 0 && index !== activeIndex) {
      pendingFocusRef.current = index;
      setActiveIndex(index);
      listRef.current?.scrollToItem(index, "smart");
    } else if (index < 0) {
      const nextIndex = Math.min(activeIndex, sortedPayments.length - 1);
      pendingFocusRef.current = nextIndex;
      focusedTransactionRef.current = sortedPayments[nextIndex]?.txHash;
      setActiveIndex(nextIndex);
      listRef.current?.scrollToItem(nextIndex, "smart");
    }
  }, [activeIndex, sortedPayments]);

  const focusRow = useCallback((index) => {
    if (sortedPayments.length === 0) return;
    const nextIndex = Math.max(0, Math.min(index, sortedPayments.length - 1));
    pendingFocusRef.current = nextIndex;
    setActiveIndex(nextIndex);
    listRef.current?.scrollToItem(nextIndex, "smart");
  }, [sortedPayments.length]);

  const handleGridKeyDown = useCallback((event) => {
    if (event.target.closest("button, input, select, textarea, a")) {
      if (event.key !== "Escape") return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRow(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(activeIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusRow(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusRow(sortedPayments.length - 1);
    } else if (event.key === "Escape" && disputingTx) {
      event.preventDefault();
      setDisputingTx(null);
      const index = sortedPayments.findIndex((payment) => payment.txHash === disputingTx);
      focusRow(index);
    } else if (event.key === "Enter" || event.key === " ") {
      const primaryAction = gridRef.current?.querySelector(
        `[data-grid-cell-index="${activeIndex}"] button`
      );
      if (primaryAction) {
        event.preventDefault();
        primaryAction.click();
      }
    }
  }, [activeIndex, disputingTx, focusRow, sortedPayments]);

  const handleRowFocus = useCallback((index) => {
    setActiveIndex(index);
    focusedTransactionRef.current = sortedPayments[index]?.txHash;
  }, [sortedPayments]);

  const handleSort = useCallback((column) => {
    setSort((prev) => ({
      column,
      direction: prev.column === column && prev.direction === "asc" ? "desc" : "asc",
    }));
  }, []);

  const handleDisputeOpen = useCallback((txHash) => {
    setDisputingTx(txHash);
  }, []);

  const handleDisputeSuccess = useCallback((txHash) => {
    onDisputedTxsChange?.(new Set([...(disputedTxs || []), txHash]));
    setDisputingTx(null);
  }, [disputedTxs, onDisputedTxsChange]);

  const handleDisputeCancel = useCallback(() => {
    setDisputingTx(null);
  }, []);

  // Item data is memoised so FixedSizeList's renderItem doesn't re-render
  // all visible rows when unrelated parent state changes.
  const itemData = useMemo(() => ({
    transactions: sortedPayments,
    disputedTxs: disputedTxs || new Set(),
    disputingTx,
    refunds: refunds || {},
    studentId,
    onDisputeOpen: handleDisputeOpen,
    onDisputeSuccess: handleDisputeSuccess,
    onDisputeCancel: handleDisputeCancel,
    activeIndex,
    onRowFocus: handleRowFocus,
    t,
  }), [
    sortedPayments, disputedTxs, disputingTx, refunds, studentId,
    handleDisputeOpen, handleDisputeSuccess, handleDisputeCancel,
    activeIndex, handleRowFocus, t,
  ]);

  const rowCount = paymentsLoading
    ? 3
    : (sortedPayments.length || 0);

  const listHeight = Math.min(LIST_HEIGHT, rowCount * ROW_HEIGHT || ROW_HEIGHT);

  return (
    <div>
      {/* Sort controls */}
      {!paymentsLoading && sortedPayments.length > 1 && (
        <div
          role="toolbar"
          aria-label={t("paymentForm.sortBy")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.25rem",
            padding: "0.25rem 0 0.5rem 0",
            borderBottom: "1px solid var(--border)",
            marginBottom: "0.25rem",
          }}
        >
          <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginRight: "0.25rem" }}>
            {t("paymentForm.sortBy")}
          </span>
          <SortButton column="date"   sort={sort} onSort={handleSort} label={t("paymentForm.colDate")}   />
          <SortButton column="amount" sort={sort} onSort={handleSort} label={t("paymentForm.colAmount")} />
          <SortButton column="status" sort={sort} onSort={handleSort} label={t("paymentForm.colStatus")} />
        </div>
      )}

      {/* Virtualised list */}
      <div
        ref={gridRef}
        role="grid"
        aria-colcount={1}
        aria-label={t("paymentForm.paymentHistory")}
        aria-rowcount={rowCount}
        aria-busy={paymentsLoading}
        onKeyDown={handleGridKeyDown}
        onFocusCapture={(event) => {
          if (event.target.closest("[data-grid-cell]")) gridHadFocusRef.current = true;
        }}
        onBlur={(event) => {
          if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
            gridHadFocusRef.current = false;
          }
        }}
      >
        {paymentsLoading ? (
          <FixedSizeList
            ref={listRef}
            height={listHeight}
            itemCount={rowCount}
            itemSize={ROW_HEIGHT}
            width="100%"
            style={{ outline: "none" }}
            itemKey={(index) => `loading-${index}`}
          >
            {SkeletonRow}
          </FixedSizeList>
        ) : sortedPayments.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: "0.875rem", padding: "0.5rem 0" }}>
            {t("paymentForm.noPayments")}
          </p>
        ) : (
          <FixedSizeList
            ref={listRef}
            height={listHeight}
            itemCount={sortedPayments.length}
            itemSize={ROW_HEIGHT}
            itemData={itemData}
            width="100%"
            style={{ outline: "none" }}
            overscanCount={10}
            itemKey={(index, data) => data.transactions[index]?.txHash || data.transactions[index]?._id || index}
          >
            {TransactionRow}
          </FixedSizeList>
        )}
      </div>

      {/* Row count summary — aria-live keeps screen readers informed */}
      {!paymentsLoading && sortedPayments.length > 0 && (
        <div
          aria-live="polite"
          aria-atomic="true"
          style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.4rem", textAlign: "right" }}
        >
          {t("paymentForm.txCount", { count: sortedPayments.length })}
        </div>
      )}
    </div>
  );
}
