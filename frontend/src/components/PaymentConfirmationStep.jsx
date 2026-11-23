import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconAlertTriangle, IconCheck } from "./Icons";

/**
 * PaymentConfirmationStep — Issue #101
 *
 * A review step that appears after a student is looked up and before the
 * payment QR code / wallet details are revealed.
 *
 * Shows:
 *   - Recipient (school wallet address, truncated for readability)
 *   - Student name and ID
 *   - Amount and currency
 *   - Memo (the payment reference that auto-matches the student)
 *   - An explicit idempotency notice (this action cannot be un-sent from the blockchain)
 *
 * The user may click "Edit" to go back and change the student ID, or
 * "Confirm & View Payment Details" to proceed to the QR code step.
 *
 * States:
 *   - "review"    : The confirmation panel is visible, user can edit or confirm.
 *   - "confirmed" : The user clicked confirm; parent renders the full payment UI.
 *
 * Props:
 *   student        {Object}  — student record from API
 *   instructions   {Object}  — payment instructions from API
 *   onConfirm      {Function} — called when the user confirms
 *   onEdit         {Function} — called when the user clicks "Edit"
 */
export default function PaymentConfirmationStep({ student, instructions, onConfirm, onEdit }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);

  if (!student || !instructions) return null;

  const feeAmount  = instructions.feeAmount ?? student.feeAmount ?? "—";
  const currency   = instructions.acceptedAssets?.[0]?.code ?? "XLM";
  const walletAddr = instructions.walletAddress ?? "—";
  const memo       = instructions.memo ?? "—";

  // Truncate long wallet addresses for display readability.
  function truncate(addr, leading = 8, trailing = 8) {
    if (!addr || addr.length <= leading + trailing + 3) return addr;
    return `${addr.slice(0, leading)}…${addr.slice(-trailing)}`;
  }

  async function handleConfirm() {
    setConfirming(true);
    try {
      await onConfirm();
    } finally {
      setConfirming(false);
    }
  }

  return (
    <section
      aria-label={t("paymentConfirmation.sectionLabel", "Review payment details")}
      data-testid="payment-confirmation-step"
      style={{
        marginTop: "1.25rem",
        border: "2px solid var(--color-primary, #4f46e5)",
        borderRadius: "var(--radius-sm, 8px)",
        padding: "1.25rem",
        background: "var(--bg-subtle, #f8f9fa)",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1rem" }}>
        <IconAlertTriangle size={16} style={{ color: "var(--color-warning, #d97706)", flexShrink: 0 }} />
        <span style={{ fontWeight: 700, fontSize: "0.925rem" }}>
          {t("paymentConfirmation.title", "Review before sending payment")}
        </span>
      </div>

      {/* Review table */}
      <dl style={{ margin: 0, padding: 0 }}>
        <ConfirmRow label={t("paymentConfirmation.recipient", "Recipient (school wallet)")}>
          <span
            style={{ fontFamily: "monospace", fontSize: "0.8rem", wordBreak: "break-all" }}
            title={walletAddr}
          >
            {truncate(walletAddr)}
          </span>
        </ConfirmRow>

        <ConfirmRow label={t("paymentConfirmation.student", "Student")}>
          {student.name}
        </ConfirmRow>

        <ConfirmRow label={t("paymentConfirmation.studentId", "Student ID")}>
          <span style={{ fontFamily: "monospace", fontSize: "0.875rem" }}>{student.studentId}</span>
        </ConfirmRow>

        <ConfirmRow label={t("paymentConfirmation.amount", "Amount")}>
          <span style={{ fontWeight: 700 }}>
            {feeAmount}
            <span style={{ marginLeft: "0.25rem", fontSize: "0.75rem", color: "var(--text-muted)", fontWeight: 600 }}>
              {currency}
            </span>
          </span>
        </ConfirmRow>

        <ConfirmRow label={t("paymentConfirmation.memo", "Memo (payment reference)")}>
          <span style={{ fontFamily: "monospace", fontSize: "0.875rem" }}>{memo}</span>
        </ConfirmRow>
      </dl>

      {/* Idempotency / irreversibility notice */}
      <div
        role="note"
        aria-label={t("paymentConfirmation.noticeLabel", "Important notice")}
        style={{
          marginTop: "1rem",
          padding: "0.75rem 1rem",
          background: "var(--color-warning-bg, #fffbeb)",
          border: "1px solid var(--color-warning-border, #fbbf24)",
          borderRadius: "var(--radius-xs, 6px)",
          fontSize: "0.8125rem",
          lineHeight: 1.5,
        }}
      >
        <strong>{t("paymentConfirmation.noticeTitle", "Important: ")}</strong>
        {t(
          "paymentConfirmation.noticeBody",
          "Blockchain payments are irreversible. Verify the recipient wallet address and memo before sending. Once submitted to the Stellar network, the transaction cannot be cancelled."
        )}
      </div>

      {/* Actions */}
      <div
        style={{
          marginTop: "1.25rem",
          display: "flex",
          gap: "0.75rem",
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={onEdit}
          className="btn btn-ghost"
          disabled={confirming}
          aria-label={t("paymentConfirmation.editAriaLabel", "Edit student ID and search again")}
          style={{ flexShrink: 0 }}
        >
          {t("paymentConfirmation.editButton", "Edit")}
        </button>

        <button
          type="button"
          onClick={handleConfirm}
          disabled={confirming}
          className="btn btn-dark"
          aria-label={t(
            "paymentConfirmation.confirmAriaLabel",
            "Confirm details and view payment QR code"
          )}
          data-testid="confirm-payment-button"
          style={{ flexGrow: 1 }}
        >
          {confirming ? (
            t("paymentConfirmation.confirming", "Loading…")
          ) : (
            <>
              <IconCheck size={14} />
              {t("paymentConfirmation.confirmButton", "Confirm & View Payment Details")}
            </>
          )}
        </button>
      </div>
    </section>
  );
}

/** Internal: a single label/value row in the review table. */
function ConfirmRow({ label, children }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "0.5rem 0",
        borderBottom: "1px solid var(--border, #e5e7eb)",
        gap: "0.5rem",
        flexWrap: "wrap",
      }}
    >
      <dt
        style={{
          fontSize: "0.8rem",
          color: "var(--text-muted)",
          flexShrink: 0,
          margin: 0,
        }}
      >
        {label}
      </dt>
      <dd
        style={{
          margin: 0,
          fontWeight: 600,
          textAlign: "right",
          wordBreak: "break-word",
          overflowWrap: "anywhere",
        }}
      >
        {children}
      </dd>
    </div>
  );
}
