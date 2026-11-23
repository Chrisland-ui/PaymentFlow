import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import RequireAdmin from "../../components/RequireAdmin";
import PageHero from "../../components/PageHero";
import {
  IconCheck,
  IconAlertTriangle,
  IconX,
  IconChevronLeft,
  IconChevronRight,
  IconExternalLink,
  IconCopy,
  IconRefreshCw,
  IconShield,
  IconCreditCard,
} from "../../components/Icons";
import { getStudentPayments, flagDispute, initiateRefund } from "../../services/api";
import { PAYMENT_STATUS } from "../../utils/paymentStatus";

const STELLAR_EXPLORER_BASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet"
    ? "https://stellar.expert/explorer/public/tx/"
    : "https://stellar.expert/explorer/testnet/tx/";

// Status metadata for the hero section
const STATUS_META = {
  [PAYMENT_STATUS.SUCCESS]:   { cls: "status-hero-success",  icon: IconCheck,          color: "var(--success)",  bg: "var(--success-bg)",  border: "var(--success-border)" },
  [PAYMENT_STATUS.PENDING]:   { cls: "status-hero-warning",  icon: IconAlertTriangle,  color: "var(--warning)",  bg: "var(--warning-bg)",  border: "var(--warning-border)" },
  [PAYMENT_STATUS.SUBMITTED]: { cls: "status-hero-info",     icon: IconRefreshCw,      color: "var(--info)",     bg: "var(--info-bg)",     border: "var(--info-border)"    },
  [PAYMENT_STATUS.FAILED]:    { cls: "status-hero-danger",   icon: IconX,              color: "var(--danger)",   bg: "var(--danger-bg)",   border: "var(--danger-border)"  },
  [PAYMENT_STATUS.DISPUTED]:  { cls: "status-hero-warning",  icon: IconAlertTriangle,  color: "var(--warning)",  bg: "var(--warning-bg)",  border: "var(--warning-border)" },
  [PAYMENT_STATUS.REFUNDED]:  { cls: "status-hero-info",     icon: IconChevronLeft,    color: "var(--info)",     bg: "var(--info-bg)",     border: "var(--info-border)"    },
  [PAYMENT_STATUS.INVALID]:   { cls: "status-hero-danger",   icon: IconX,              color: "var(--danger)",   bg: "var(--danger-bg)",   border: "var(--danger-border)"  },
};

// Actions available per status
const STATUS_ACTIONS = {
  [PAYMENT_STATUS.SUCCESS]:   ["refund", "dispute"],
  [PAYMENT_STATUS.PENDING]:   ["dispute"],
  [PAYMENT_STATUS.SUBMITTED]: ["dispute"],
  [PAYMENT_STATUS.FAILED]:    [],
  [PAYMENT_STATUS.DISPUTED]:  [],
  [PAYMENT_STATUS.REFUNDED]:  [],
  [PAYMENT_STATUS.INVALID]:   [],
};

function CopyButton({ value, label }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <button
      onClick={handleCopy}
      aria-label={`Copy ${label}`}
      title={copied ? "Copied!" : `Copy ${label}`}
      style={{
        background: "none",
        border: "none",
        cursor: "pointer",
        padding: "2px 4px",
        borderRadius: "4px",
        color: copied ? "var(--success)" : "var(--text-muted)",
        display: "inline-flex",
        alignItems: "center",
        transition: "color 0.15s",
        flexShrink: 0,
      }}
    >
      {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  );
}

function SectionCard({ title, icon: Icon, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div style={{
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-md)",
      background: "var(--card-bg)",
      overflow: "hidden",
      marginBottom: "1rem",
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0.875rem 1.25rem",
          background: "none",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          borderBottom: open ? "1px solid var(--border)" : "none",
          transition: "border-color 0.15s",
        }}
        aria-expanded={open}
      >
        <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          {Icon && <Icon size={15} style={{ color: "var(--text-muted)" }} />}
          <span style={{ fontWeight: 600, fontSize: "0.875rem", color: "var(--text)" }}>
            {title}
          </span>
        </span>
        <span style={{
          transform: open ? "rotate(90deg)" : "rotate(0deg)",
          transition: "transform 0.2s",
          color: "var(--text-muted)",
          display: "flex",
        }}>
          <IconChevronRight size={14} />
        </span>
      </button>
      {open && (
        <div style={{ padding: "1rem 1.25rem" }}>
          {children}
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value, mono = false, copiable = false }) {
  if (value == null || value === "") return null;
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-start",
      padding: "0.5rem 0",
      borderBottom: "1px solid var(--border)",
      gap: "1rem",
    }}>
      <span style={{
        fontSize: "0.8125rem",
        color: "var(--text-muted)",
        fontWeight: 500,
        flexShrink: 0,
        minWidth: "140px",
      }}>
        {label}
      </span>
      <span style={{
        fontSize: "0.8125rem",
        color: "var(--text)",
        fontFamily: mono ? "monospace" : "inherit",
        wordBreak: "break-all",
        textAlign: "right",
        display: "flex",
        alignItems: "center",
        gap: "0.25rem",
      }}>
        {value}
        {copiable && typeof value === "string" && (
          <CopyButton value={value} label={label} />
        )}
      </span>
    </div>
  );
}

function PaymentHero({ payment }) {
  const { t } = useTranslation();
  const status = payment.status || PAYMENT_STATUS.PENDING;
  const meta = STATUS_META[status] || STATUS_META[PAYMENT_STATUS.PENDING];
  const StatusIcon = meta.icon;

  return (
    <div style={{
      background: meta.bg,
      border: `1px solid ${meta.border}`,
      borderRadius: "var(--radius-lg)",
      padding: "2rem 2rem 1.5rem",
      marginBottom: "1.5rem",
      position: "relative",
      overflow: "hidden",
    }}>
      {/* Background accent */}
      <div style={{
        position: "absolute",
        top: -40,
        right: -40,
        width: 160,
        height: 160,
        borderRadius: "50%",
        background: meta.color,
        opacity: 0.06,
        pointerEvents: "none",
      }} />

      <div style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "1.25rem",
        flexWrap: "wrap",
      }}>
        {/* Status icon bubble */}
        <div style={{
          width: 52,
          height: 52,
          borderRadius: "50%",
          background: meta.color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          color: "#fff",
          boxShadow: `0 8px 24px -6px ${meta.color}66`,
        }}>
          <StatusIcon size={24} />
        </div>

        {/* Main info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
            <span style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.375rem",
              padding: "0.25rem 0.75rem",
              borderRadius: "20px",
              background: meta.color,
              color: "#fff",
              fontSize: "0.75rem",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}>
              <StatusIcon size={11} />
              {status}
            </span>
          </div>

          {/* Amount — primary emphasis */}
          <div style={{
            fontSize: "2.25rem",
            fontWeight: 800,
            color: "var(--text)",
            lineHeight: 1.1,
            letterSpacing: "-0.02em",
            marginBottom: "0.375rem",
          }}>
            {payment.amount != null ? (
              <>
                {parseFloat(payment.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 7 })}
                <span style={{ fontSize: "1rem", fontWeight: 600, marginLeft: "0.375rem", color: "var(--text-muted)" }}>
                  {payment.asset || "XLM"}
                </span>
              </>
            ) : (
              <span style={{ color: "var(--text-muted)", fontSize: "1.25rem" }}>
                {t("paymentDetail.amountUnknown")}
              </span>
            )}
          </div>

          {/* Key dates row */}
          <div style={{
            display: "flex",
            gap: "1.5rem",
            flexWrap: "wrap",
            marginTop: "0.5rem",
          }}>
            {payment.createdAt && (
              <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                <strong style={{ color: "var(--text)" }}>{t("paymentDetail.submitted")}: </strong>
                {new Date(payment.createdAt).toLocaleString()}
              </span>
            )}
            {payment.confirmedAt && (
              <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                <strong style={{ color: "var(--text)" }}>{t("paymentDetail.confirmed")}: </strong>
                {new Date(payment.confirmedAt).toLocaleString()}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ActionPanel({ payment, onActionComplete }) {
  const { t } = useTranslation();
  const status = payment.status || PAYMENT_STATUS.PENDING;
  const actions = STATUS_ACTIONS[status] || [];

  const [showRefundForm, setShowRefundForm]   = useState(false);
  const [showDisputeForm, setShowDisputeForm] = useState(false);
  const [refundNote, setRefundNote]           = useState("");
  const [disputeReason, setDisputeReason]     = useState("");
  const [submitting, setSubmitting]           = useState(false);
  const [actionError, setActionError]         = useState(null);
  const [actionSuccess, setActionSuccess]     = useState(null);

  if (actions.length === 0) return null;

  async function handleRefund(e) {
    e.preventDefault();
    if (!refundNote.trim()) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await initiateRefund(payment.txHash, { reason: refundNote.trim() });
      setActionSuccess(t("paymentDetail.refundInitiated"));
      setShowRefundForm(false);
      setRefundNote("");
      onActionComplete?.();
    } catch (err) {
      setActionError(err?.response?.data?.error || t("paymentDetail.actionFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDispute(e) {
    e.preventDefault();
    if (!disputeReason.trim()) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await flagDispute({ txHash: payment.txHash, reason: disputeReason.trim() });
      setActionSuccess(t("paymentDetail.disputeFiled"));
      setShowDisputeForm(false);
      setDisputeReason("");
      onActionComplete?.();
    } catch (err) {
      setActionError(err?.response?.data?.error || t("paymentDetail.actionFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-md)",
      background: "var(--card-bg)",
      padding: "1.25rem",
      marginBottom: "1rem",
    }}>
      <div style={{ fontWeight: 600, fontSize: "0.875rem", color: "var(--text)", marginBottom: "0.875rem" }}>
        {t("paymentDetail.actionsTitle")}
      </div>

      {actionSuccess && (
        <div style={{
          display: "flex", alignItems: "center", gap: "0.5rem",
          padding: "0.625rem 0.875rem",
          background: "var(--success-bg)",
          border: "1px solid var(--success-border)",
          borderRadius: "var(--radius-sm)",
          color: "var(--success-text)",
          fontSize: "0.8125rem",
          marginBottom: "0.875rem",
        }}>
          <IconCheck size={14} />
          {actionSuccess}
        </div>
      )}
      {actionError && (
        <div style={{
          display: "flex", alignItems: "center", gap: "0.5rem",
          padding: "0.625rem 0.875rem",
          background: "var(--danger-bg)",
          border: "1px solid var(--danger-border)",
          borderRadius: "var(--radius-sm)",
          color: "var(--danger-text)",
          fontSize: "0.8125rem",
          marginBottom: "0.875rem",
        }}>
          <IconAlertTriangle size={14} />
          {actionError}
        </div>
      )}

      {/* Action buttons */}
      {!showRefundForm && !showDisputeForm && (
        <div style={{ display: "flex", gap: "0.625rem", flexWrap: "wrap" }}>
          {actions.includes("refund") && (
            <button
              onClick={() => { setShowRefundForm(true); setShowDisputeForm(false); setActionError(null); }}
              style={{
                padding: "0.5rem 1rem",
                background: "var(--warning-bg)",
                border: "1px solid var(--warning-border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--warning-text)",
                fontSize: "0.8125rem",
                fontWeight: 600,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "0.375rem",
              }}
            >
              <IconChevronLeft size={13} />
              {t("paymentDetail.initiateRefund")}
            </button>
          )}
          {actions.includes("dispute") && (
            <button
              onClick={() => { setShowDisputeForm(true); setShowRefundForm(false); setActionError(null); }}
              style={{
                padding: "0.5rem 1rem",
                background: "var(--danger-bg)",
                border: "1px solid var(--danger-border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--danger-text)",
                fontSize: "0.8125rem",
                fontWeight: 600,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "0.375rem",
              }}
            >
              <IconAlertTriangle size={13} />
              {t("paymentDetail.flagDispute")}
            </button>
          )}
        </div>
      )}

      {/* Refund form */}
      {showRefundForm && (
        <form onSubmit={handleRefund}>
          <label style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.375rem", color: "var(--text-muted)" }}>
            {t("paymentDetail.refundReasonLabel")}
          </label>
          <textarea
            value={refundNote}
            onChange={e => setRefundNote(e.target.value)}
            placeholder={t("paymentDetail.refundReasonPlaceholder")}
            required
            style={{
              width: "100%",
              minHeight: 72,
              padding: "0.5rem 0.75rem",
              border: "1.5px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg)",
              color: "var(--text)",
              fontSize: "0.8125rem",
              fontFamily: "inherit",
              resize: "vertical",
              boxSizing: "border-box",
              marginBottom: "0.75rem",
            }}
          />
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="submit"
              disabled={submitting || !refundNote.trim()}
              style={{
                padding: "0.5rem 1rem",
                background: "var(--warning)",
                color: "#fff",
                border: "none",
                borderRadius: "var(--radius-sm)",
                fontSize: "0.8125rem",
                fontWeight: 600,
                cursor: submitting || !refundNote.trim() ? "not-allowed" : "pointer",
                opacity: submitting || !refundNote.trim() ? 0.6 : 1,
              }}
            >
              {submitting ? t("actions.loading") : t("paymentDetail.confirmRefund")}
            </button>
            <button
              type="button"
              onClick={() => { setShowRefundForm(false); setRefundNote(""); setActionError(null); }}
              disabled={submitting}
              style={{
                padding: "0.5rem 1rem",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text)",
                fontSize: "0.8125rem",
                cursor: "pointer",
              }}
            >
              {t("actions.cancel")}
            </button>
          </div>
        </form>
      )}

      {/* Dispute form */}
      {showDisputeForm && (
        <form onSubmit={handleDispute}>
          <label style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.375rem", color: "var(--text-muted)" }}>
            {t("paymentDetail.disputeReasonLabel")}
          </label>
          <textarea
            value={disputeReason}
            onChange={e => setDisputeReason(e.target.value)}
            placeholder={t("paymentDetail.disputeReasonPlaceholder")}
            required
            style={{
              width: "100%",
              minHeight: 72,
              padding: "0.5rem 0.75rem",
              border: "1.5px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg)",
              color: "var(--text)",
              fontSize: "0.8125rem",
              fontFamily: "inherit",
              resize: "vertical",
              boxSizing: "border-box",
              marginBottom: "0.75rem",
            }}
          />
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="submit"
              disabled={submitting || !disputeReason.trim()}
              style={{
                padding: "0.5rem 1rem",
                background: "var(--danger)",
                color: "#fff",
                border: "none",
                borderRadius: "var(--radius-sm)",
                fontSize: "0.8125rem",
                fontWeight: 600,
                cursor: submitting || !disputeReason.trim() ? "not-allowed" : "pointer",
                opacity: submitting || !disputeReason.trim() ? 0.6 : 1,
              }}
            >
              {submitting ? t("actions.loading") : t("paymentDetail.confirmDispute")}
            </button>
            <button
              type="button"
              onClick={() => { setShowDisputeForm(false); setDisputeReason(""); setActionError(null); }}
              disabled={submitting}
              style={{
                padding: "0.5rem 1rem",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text)",
                fontSize: "0.8125rem",
                cursor: "pointer",
              }}
            >
              {t("actions.cancel")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function PaymentDetailContent({ studentId, txHash }) {
  const { t } = useTranslation();
  const router = useRouter();

  const [payment, setPayment]   = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);

  const load = useCallback(() => {
    if (!studentId) return;
    setLoading(true);
    setError(null);
    getStudentPayments(studentId)
      .then(({ data }) => {
        const payments = Array.isArray(data) ? data : data?.payments ?? [];
        const found = payments.find(p => p.txHash === txHash);
        if (found) {
          setPayment(found);
        } else {
          setError(t("paymentDetail.notFound"));
        }
      })
      .catch(() => setError(t("paymentDetail.loadError")))
      .finally(() => setLoading(false));
  }, [studentId, txHash, t]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
        {t("actions.loading")}
      </div>
    );
  }

  if (error || !payment) {
    return (
      <div className="page-wrap">
        <div className="alert alert-danger" role="alert" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <IconAlertTriangle size={16} />
          {error || t("paymentDetail.notFound")}
        </div>
        <Link href="/dashboard" style={{ color: "var(--accent)", textDecoration: "none", fontSize: "0.875rem" }}>
          ← {t("paymentDetail.backToDashboard")}
        </Link>
      </div>
    );
  }

  return (
    <>
      <style>{`
        @media (max-width: 768px) {
          .pd-layout { flex-direction: column !important; }
          .pd-sidebar { width: 100% !important; }
        }
        @media (max-width: 375px) {
          .pd-hero-amount { font-size: 1.5rem !important; }
        }
      `}</style>

      <div className="page-wrap">
        {/* Back navigation */}
        <div style={{ marginBottom: "1rem" }}>
          <button
            onClick={() => router.back()}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.375rem",
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--text-muted)",
              fontSize: "0.8125rem",
              padding: 0,
              fontFamily: "inherit",
            }}
          >
            <IconChevronLeft size={14} />
            {t("paymentDetail.back")}
          </button>
        </div>

        {/* Hero: amount + status */}
        <PaymentHero payment={payment} />

        {/* Two-column layout at ≥768px */}
        <div className="pd-layout" style={{ display: "flex", gap: "1rem", alignItems: "flex-start" }}>

          {/* Main column */}
          <div style={{ flex: 1, minWidth: 0 }}>

            {/* Student & School */}
            <SectionCard title={t("paymentDetail.sectionStudentSchool")} icon={IconShield}>
              <DetailRow label={t("paymentDetail.studentId")}   value={payment.studentId}   mono copiable />
              <DetailRow label={t("paymentDetail.studentName")} value={payment.studentName || payment.student?.name} />
              <DetailRow label={t("paymentDetail.className")}   value={payment.className    || payment.student?.class} />
              <DetailRow label={t("paymentDetail.schoolId")}    value={payment.schoolId}    mono />
            </SectionCard>

            {/* Transaction Details */}
            <SectionCard title={t("paymentDetail.sectionTransaction")} icon={IconCreditCard}>
              <DetailRow label={t("paymentDetail.txHash")}       value={payment.txHash}       mono copiable />
              <DetailRow label={t("paymentDetail.amount")}
                value={payment.amount != null
                  ? `${parseFloat(payment.amount).toLocaleString(undefined, { maximumFractionDigits: 7 })} ${payment.asset || "XLM"}`
                  : undefined
                }
              />
              <DetailRow label={t("paymentDetail.asset")}        value={payment.asset || "XLM"} />
              <DetailRow label={t("paymentDetail.memo")}         value={payment.memo}         mono />
              <DetailRow label={t("paymentDetail.paymentType")}  value={payment.paymentType} />
              <DetailRow label={t("paymentDetail.submittedAt")}  value={payment.createdAt  ? new Date(payment.createdAt).toLocaleString()  : undefined} />
              <DetailRow label={t("paymentDetail.confirmedAt")}  value={payment.confirmedAt ? new Date(payment.confirmedAt).toLocaleString() : undefined} />
            </SectionCard>

            {/* Blockchain Confirmation */}
            <SectionCard title={t("paymentDetail.sectionBlockchain")} icon={IconExternalLink}>
              <DetailRow label={t("paymentDetail.sourceWallet")}      value={payment.sourceWallet}      mono copiable />
              <DetailRow label={t("paymentDetail.destinationWallet")} value={payment.destinationWallet} mono copiable />
              <DetailRow label={t("paymentDetail.ledger")}            value={payment.ledger?.toString()} mono />
              <DetailRow label={t("paymentDetail.paging_token")}      value={payment.paging_token} mono />
              {payment.txHash && (
                <div style={{ marginTop: "0.875rem" }}>
                  <a
                    href={`${STELLAR_EXPLORER_BASE}${payment.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.375rem",
                      color: "var(--accent)",
                      fontSize: "0.8125rem",
                      fontWeight: 600,
                      textDecoration: "none",
                    }}
                  >
                    <IconExternalLink size={13} />
                    {t("paymentDetail.viewOnStellar")}
                  </a>
                </div>
              )}
            </SectionCard>

            {/* Advanced / Raw data — collapsed by default (progressive disclosure) */}
            <SectionCard title={t("paymentDetail.sectionAdvanced")} icon={IconRefreshCw} defaultOpen={false}>
              <DetailRow label={t("paymentDetail.internalId")}     value={payment._id}        mono copiable />
              <DetailRow label={t("paymentDetail.idempotencyKey")} value={payment.idempotencyKey} mono />
              <DetailRow label={t("paymentDetail.rawStatus")}      value={payment.status} />
              <DetailRow label={t("paymentDetail.retryCount")}     value={payment.retryCount?.toString()} />
              <DetailRow label={t("paymentDetail.errorMsg")}       value={payment.errorMessage} />
              {payment.rawData && (
                <div style={{ marginTop: "0.75rem" }}>
                  <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text-muted)", marginBottom: "0.375rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    {t("paymentDetail.rawPayload")}
                  </div>
                  <pre style={{
                    background: "var(--bg-subtle)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    padding: "0.75rem",
                    fontSize: "0.75rem",
                    fontFamily: "monospace",
                    overflowX: "auto",
                    color: "var(--text)",
                    margin: 0,
                    maxHeight: 240,
                    overflow: "auto",
                  }}>
                    {JSON.stringify(payment.rawData, null, 2)}
                  </pre>
                </div>
              )}
            </SectionCard>

          </div>

          {/* Sidebar: contextual actions */}
          <div className="pd-sidebar" style={{ width: 280, flexShrink: 0 }}>
            <ActionPanel payment={payment} onActionComplete={load} />

            {/* Audit trail summary */}
            <SectionCard title={t("paymentDetail.sectionAuditTrail")} icon={IconShield} defaultOpen={false}>
              <DetailRow label={t("paymentDetail.createdAt")}  value={payment.createdAt  ? new Date(payment.createdAt).toLocaleString()  : undefined} />
              <DetailRow label={t("paymentDetail.updatedAt")}  value={payment.updatedAt  ? new Date(payment.updatedAt).toLocaleString()  : undefined} />
              <DetailRow label={t("paymentDetail.verifiedBy")} value={payment.verifiedBy} />
            </SectionCard>
          </div>

        </div>
      </div>
    </>
  );
}

export default function PaymentDetailPage() {
  const router = useRouter();
  const { txHash, studentId } = router.query;
  const { t } = useTranslation();

  return (
    <RequireAdmin>
      <Head>
        <title>{t("paymentDetail.pageTitle")} | StellarEduPay</title>
      </Head>
      {router.isReady ? (
        <PaymentDetailContent studentId={studentId} txHash={txHash} />
      ) : (
        <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
          {t("actions.loading")}
        </div>
      )}
    </RequireAdmin>
  );
}
