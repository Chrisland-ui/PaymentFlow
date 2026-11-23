/**
 * TransactionDetail — Issue #106
 *
 * A scannable, section-based detail view for a single payment transaction.
 * Groups information into four logical sections:
 *   1. Summary strip  — status, amount, date (always visible)
 *   2. Parties section — student / payer and school / counterparty
 *   3. Technical details — transaction hash, memo, asset, blockchain link
 *   4. Reconciliation / audit — recorded by, sync time, notes
 *
 * Contextual actions (raise dispute, view receipt, verify) float in a
 * persistent action bar at the bottom so the user always knows what they
 * can do next without scrolling.
 *
 * Accessibility
 * -------------
 * - `role="dialog"` + `aria-modal` + focus trap when rendered as a modal.
 * - Section headings use <h3> so they nest correctly inside page <h2>s.
 * - Keyboard: Escape closes, Tab cycles within the dialog.
 * - Sensitive fields (full tx hash) masked by default with a reveal toggle.
 *
 * Usage
 * -----
 *   <TransactionDetail transaction={tx} onClose={fn} onDisputeRaised={fn} />
 *
 * `transaction` shape mirrors the backend /payments/:studentId response item:
 *   { _id, txHash, amount, asset, status, createdAt, studentId, memo,
 *     source, destination, validationStatus, notes, syncedAt, recordedBy }
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconCheck,
  IconAlertTriangle,
  IconExternalLink,
  IconDollarSign,
  IconChevronLeft,
} from "./Icons";
import PaymentStatusTimeline from "./PaymentStatusTimeline";
import TimestampDisplay from "./TimestampDisplay";

// ── helpers ───────────────────────────────────────────────────────────────────

const STELLAR_EXPLORER_BASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet"
    ? "https://stellar.expert/explorer/public/tx/"
    : "https://stellar.expert/explorer/testnet/tx/";

function truncateHash(hash, len = 16) {
  if (!hash) return "—";
  if (hash.length <= len) return hash;
  return `${hash.slice(0, len)}…`;
}

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  SUCCESS:   { cls: "badge-success", icon: "check",    color: "var(--success)" },
  CONFIRMED: { cls: "badge-success", icon: "check",    color: "var(--success)" },
  PENDING:   { cls: "badge-warning", icon: "warning",  color: "var(--warning)" },
  SUBMITTED: { cls: "badge-info",    icon: null,        color: "var(--info)" },
  FAILED:    { cls: "badge-danger",  icon: "warning",  color: "var(--danger)" },
  DISPUTED:  { cls: "badge-warning", icon: "warning",  color: "var(--warning)" },
  REFUNDED:  { cls: "badge-neutral", icon: null,        color: "var(--text-muted)" },
  INVALID:   { cls: "badge-danger",  icon: "warning",  color: "var(--danger)" },
};

function getStatusConfig(status) {
  return STATUS_CONFIG[(status || "").toUpperCase()] || { cls: "badge-neutral", icon: null, color: "var(--text-muted)" };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeading({ children }) {
  return (
    <h3 style={{
      margin: "0 0 0.75rem 0",
      fontSize: "0.7rem",
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: "0.08em",
      color: "var(--text-muted)",
      borderBottom: "1px solid var(--border)",
      paddingBottom: "0.4rem",
    }}>
      {children}
    </h3>
  );
}

function DetailRow({ label, value, mono = false, sensitive = false }) {
  const [revealed, setRevealed] = useState(false);
  const display = sensitive && !revealed
    ? "•".repeat(Math.min((value || "").length, 20))
    : value;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
      <span style={{
        fontSize: "0.68rem",
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.07em",
        color: "var(--text-muted)",
      }}>
        {label}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}>
        <span style={{
          fontSize: "0.875rem",
          color: "var(--text)",
          fontFamily: mono ? "monospace" : "inherit",
          wordBreak: "break-all",
        }}>
          {display || "—"}
        </span>
        {sensitive && value && (
          <button
            onClick={() => setRevealed(r => !r)}
            aria-label={revealed ? "Hide value" : "Reveal value"}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--text-muted)",
              fontSize: "0.7rem",
              padding: "0.1rem 0.25rem",
              borderRadius: "3px",
              flexShrink: 0,
            }}
          >
            {revealed ? "hide" : "show"}
          </button>
        )}
      </div>
    </div>
  );
}

function CopyButton({ value, label }) {
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation();

  function handleCopy() {
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  return (
    <button
      onClick={handleCopy}
      aria-label={label || t("actions.copyToClipboard")}
      title={copied ? t("actions.copied") : t("actions.copy")}
      style={{
        background: "none",
        border: "1px solid var(--border)",
        borderRadius: "4px",
        cursor: "pointer",
        color: copied ? "var(--success)" : "var(--text-muted)",
        fontSize: "0.7rem",
        padding: "0.2rem 0.45rem",
        display: "inline-flex",
        alignItems: "center",
        gap: "0.2rem",
        transition: "color 0.15s",
        flexShrink: 0,
      }}
    >
      {copied ? <IconCheck size={11} /> : null}
      {copied ? t("actions.copied") : t("actions.copy")}
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * @param {{ transaction: object, onClose: function, onDisputeRaised?: function }} props
 */
export default function TransactionDetail({ transaction, onClose, onDisputeRaised, payments = [] }) {
  const { t } = useTranslation();
  const dialogRef = useRef(null);
  const closeRef  = useRef(null);
  const tx = transaction || {};

  const statusCfg = getStatusConfig(tx.status);
  const explorerUrl = tx.txHash ? `${STELLAR_EXPLORER_BASE}${tx.txHash}` : null;

  // Focus the close button on mount; restore focus on unmount.
  useEffect(() => {
    const prev = document.activeElement;
    closeRef.current?.focus();
    return () => { prev?.focus(); };
  }, []);

  // Escape closes the dialog.
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Focus trap — keeps Tab/Shift+Tab cycling inside the dialog.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    function trapFocus(e) {
      if (e.key !== "Tab") return;
      const focusable = el.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) { e.preventDefault(); return; }
      const first = focusable[0];
      const last  = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
      }
    }
    el.addEventListener("keydown", trapFocus);
    return () => el.removeEventListener("keydown", trapFocus);
  }, []);

  return (
    <>
      <style>{`
        .txd-overlay {
          position: fixed; inset: 0;
          background: rgba(10, 15, 30, 0.55);
          backdrop-filter: blur(3px);
          z-index: 400;
          display: flex;
          align-items: flex-start;
          justify-content: center;
          padding: 1.5rem 1rem;
          overflow-y: auto;
        }
        .txd-dialog {
          background: var(--card-bg);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          box-shadow: var(--shadow-lg);
          width: 100%;
          max-width: 600px;
          display: flex;
          flex-direction: column;
          animation: txdSlideIn 0.2s ease both;
        }
        @keyframes txdSlideIn {
          from { opacity: 0; transform: translateY(-12px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        .txd-header {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 1rem 1.25rem;
          border-bottom: 1px solid var(--border);
        }
        .txd-status-dot {
          width: 10px; height: 10px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .txd-header-title {
          flex: 1;
          font-size: 1rem;
          font-weight: 700;
          color: var(--text);
          margin: 0;
        }
        .txd-header-sub {
          font-size: 0.75rem;
          color: var(--text-muted);
          font-weight: 400;
          margin-left: 0.25rem;
        }
        .txd-close {
          display: flex; align-items: center; justify-content: center;
          width: 30px; height: 30px;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
          font-size: 1rem;
          transition: background 0.12s, color 0.12s;
          flex-shrink: 0;
        }
        .txd-close:hover { background: var(--danger-bg); color: var(--danger-text); border-color: var(--danger-border); }
        .txd-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

        /* ── Summary strip ── */
        .txd-summary {
          display: flex;
          flex-wrap: wrap;
          gap: 0.75rem 2rem;
          padding: 1rem 1.25rem;
          background: var(--bg-subtle, var(--bg));
          border-bottom: 1px solid var(--border);
        }
        .txd-summary-item {
          display: flex;
          flex-direction: column;
          gap: 0.15rem;
        }
        .txd-summary-label {
          font-size: 0.62rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text-muted);
        }
        .txd-summary-value {
          font-size: 1.1rem;
          font-weight: 700;
          color: var(--text);
          line-height: 1.2;
        }
        .txd-summary-sub {
          font-size: 0.72rem;
          color: var(--text-muted);
        }

        /* ── Body sections ── */
        .txd-body {
          padding: 1.25rem;
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
          overflow-y: auto;
        }
        .txd-section {}
        .txd-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
          gap: 0.75rem 1.5rem;
        }
        .txd-hash-row {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex-wrap: wrap;
        }
        .txd-hash-value {
          font-family: monospace;
          font-size: 0.8125rem;
          color: var(--text);
          word-break: break-all;
          flex: 1;
          min-width: 0;
        }
        .txd-explorer-link {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          font-size: 0.8125rem;
          color: var(--accent);
          text-decoration: none;
          font-weight: 500;
          padding: 0.2rem 0;
          transition: opacity 0.12s;
        }
        .txd-explorer-link:hover { opacity: 0.75; }

        /* ── Action bar ── */
        .txd-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 0.625rem;
          padding: 0.875rem 1.25rem;
          border-top: 1px solid var(--border);
          background: var(--bg-subtle, var(--bg));
          border-radius: 0 0 var(--radius-md) var(--radius-md);
        }
        .txd-actions .btn { flex-shrink: 0; }

        /* ── Validation badge ── */
        .txd-validation-badge {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          font-size: 0.72rem;
          font-weight: 700;
          padding: 0.2rem 0.55rem;
          border-radius: 4px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
      `}</style>

      {/* Backdrop */}
      <div
        className="txd-overlay"
        onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}
        aria-hidden="true"
      />

      {/* Dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="txd-title"
        className="txd-overlay"
        style={{ pointerEvents: "none" }}
      >
        <div className="txd-dialog" style={{ pointerEvents: "auto" }}>

          {/* ── Header ── */}
          <div className="txd-header">
            <div
              className="txd-status-dot"
              style={{ background: statusCfg.color }}
              aria-hidden="true"
            />
            <h2 id="txd-title" className="txd-header-title">
              {t("transactionDetail.title")}
              {tx.studentId && (
                <span className="txd-header-sub">
                  {" — "}{tx.studentId}
                </span>
              )}
            </h2>
            <span className={`badge ${statusCfg.cls}`}>
              {statusCfg.icon === "check" && <IconCheck size={10} />}
              {statusCfg.icon === "warning" && <IconAlertTriangle size={10} />}
              {t(`status.payment.${tx.status}`) || tx.status || "—"}
            </span>
            <button
              ref={closeRef}
              className="txd-close"
              onClick={onClose}
              aria-label={t("actions.back")}
            >
              ✕
            </button>
          </div>

          {/* ── Summary strip ── */}
          <div className="txd-summary" role="region" aria-label={t("transactionDetail.summaryAria")}>
            <div className="txd-summary-item">
              <span className="txd-summary-label">{t("transactionDetail.amount")}</span>
              <span className="txd-summary-value">
                {tx.amount != null
                  ? Number(tx.amount).toLocaleString(undefined, { maximumFractionDigits: 7 })
                  : "—"}
              </span>
              {tx.asset && <span className="txd-summary-sub">{tx.asset}</span>}
            </div>

            <div className="txd-summary-item">
              <span className="txd-summary-label">{t("transactionDetail.status")}</span>
              <span className="txd-summary-value" style={{ fontSize: "0.9rem" }}>
                <span className={`badge ${statusCfg.cls}`}>
                  {t(`status.payment.${tx.status}`) || tx.status || "—"}
                </span>
              </span>
            </div>

            <div className="txd-summary-item">
              <span className="txd-summary-label">{t("transactionDetail.date")}</span>
              <span className="txd-summary-value" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                <TimestampDisplay iso={tx.createdAt} />
              </span>
            </div>

            {tx.validationStatus && (
              <div className="txd-summary-item">
                <span className="txd-summary-label">{t("transactionDetail.validation")}</span>
                <span
                  className={`txd-validation-badge ${
                    tx.validationStatus === "valid"
                      ? "badge-success"
                      : tx.validationStatus === "overpaid"
                      ? "badge-warning"
                      : "badge-danger"
                  }`}
                >
                  {t(`status.validation.${tx.validationStatus}`) || tx.validationStatus}
                </span>
              </div>
            )}
          </div>

          {/* ── Payment status timeline ── */}
          <PaymentStatusTimeline payments={payments} currentStatus={tx.status} compact />

          {/* ── Body ── */}
          <div className="txd-body" role="region" aria-label={t("transactionDetail.detailsAria")}>

            {/* Section 1: Counterparties */}
            <div className="txd-section">
              <SectionHeading>{t("transactionDetail.sectionParties")}</SectionHeading>
              <div className="txd-grid">
                <DetailRow
                  label={t("transactionDetail.studentId")}
                  value={tx.studentId}
                  mono
                />
                {tx.source && (
                  <DetailRow
                    label={t("transactionDetail.source")}
                    value={truncateHash(tx.source, 20)}
                    mono
                  />
                )}
                {tx.destination && (
                  <DetailRow
                    label={t("transactionDetail.destination")}
                    value={truncateHash(tx.destination, 20)}
                    mono
                  />
                )}
                {tx.memo && (
                  <DetailRow
                    label={t("transactionDetail.memo")}
                    value={tx.memo}
                    mono
                  />
                )}
              </div>
            </div>

            {/* Section 2: Technical details */}
            <div className="txd-section">
              <SectionHeading>{t("transactionDetail.sectionTechnical")}</SectionHeading>

              {/* Transaction hash with copy + explorer */}
              {tx.txHash && (
                <div style={{ marginBottom: "0.875rem" }}>
                  <span style={{
                    display: "block",
                    fontSize: "0.68rem",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                    color: "var(--text-muted)",
                    marginBottom: "0.3rem",
                  }}>
                    {t("transactionDetail.txHash")}
                  </span>
                  <div className="txd-hash-row">
                    <span className="txd-hash-value">{tx.txHash}</span>
                    <CopyButton value={tx.txHash} label={t("transactionDetail.copyHash")} />
                    {explorerUrl && (
                      <a
                        href={explorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="txd-explorer-link"
                        aria-label={t("blockchain.explorerAriaLabel", { hash: truncateHash(tx.txHash) })}
                      >
                        <IconExternalLink size={13} />
                        {t("blockchain.viewOnExplorer")}
                      </a>
                    )}
                  </div>
                </div>
              )}

              <div className="txd-grid">
                <DetailRow
                  label={t("transactionDetail.asset")}
                  value={tx.asset}
                  mono
                />
                {tx.ledger && (
                  <DetailRow
                    label={t("transactionDetail.ledger")}
                    value={String(tx.ledger)}
                    mono
                  />
                )}
                {tx.feeCharged && (
                  <DetailRow
                    label={t("transactionDetail.feeCharged")}
                    value={`${tx.feeCharged} stroops`}
                    mono
                  />
                )}
              </div>
            </div>

            {/* Section 3: Reconciliation & audit */}
            <div className="txd-section">
              <SectionHeading>{t("transactionDetail.sectionReconciliation")}</SectionHeading>
              <div className="txd-grid">
                {tx.syncedAt && (
                  <DetailRow
                    label={t("transactionDetail.syncedAt")}
                    value={formatDate(tx.syncedAt)}
                  />
                )}
                {tx.recordedBy && (
                  <DetailRow
                    label={t("transactionDetail.recordedBy")}
                    value={tx.recordedBy}
                  />
                )}
                {tx._id && (
                  <DetailRow
                    label={t("transactionDetail.recordId")}
                    value={tx._id}
                    mono
                  />
                )}
              </div>
              {tx.notes && (
                <div style={{ marginTop: "0.75rem" }}>
                  <span style={{
                    display: "block",
                    fontSize: "0.68rem",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                    color: "var(--text-muted)",
                    marginBottom: "0.3rem",
                  }}>
                    {t("transactionDetail.notes")}
                  </span>
                  <p style={{
                    margin: 0,
                    fontSize: "0.8125rem",
                    color: "var(--text)",
                    lineHeight: 1.55,
                    padding: "0.5rem 0.75rem",
                    background: "var(--bg-subtle, var(--bg))",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                  }}>
                    {tx.notes}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* ── Persistent action bar ── */}
          <div className="txd-actions" role="group" aria-label={t("transactionDetail.actionsAria")}>
            {explorerUrl && (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-sm btn-ghost"
                style={{ display: "inline-flex", alignItems: "center", gap: "0.375rem", textDecoration: "none" }}
                aria-label={t("blockchain.explorerAriaLabel", { hash: truncateHash(tx.txHash) })}
              >
                <IconExternalLink size={13} />
                {t("blockchain.viewOnExplorer")}
              </a>
            )}
            {tx.txHash && (
              <CopyButton
                value={tx.txHash}
                label={t("transactionDetail.copyHash")}
              />
            )}
            {/* Only show dispute action for non-disputed, non-refunded transactions */}
            {tx.status &&
              !["DISPUTED", "REFUNDED", "PENDING", "FAILED", "INVALID"].includes(
                (tx.status || "").toUpperCase()
              ) &&
              onDisputeRaised && (
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => onDisputeRaised?.(tx)}
                  style={{ marginLeft: "auto" }}
                >
                  {t("paymentForm.raiseDispute")}
                </button>
              )}
            <button
              className="btn btn-sm btn-ghost"
              onClick={onClose}
              style={{ marginLeft: onDisputeRaised ? undefined : "auto" }}
            >
              {t("actions.back")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
