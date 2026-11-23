/**
 * VerifyPayment — updated for Issue #352
 * Uses PaymentAlert for structured severity on payment failure messages.
 */
import { useState, useRef } from "react";
import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { verifyPayment } from "../services/api";
import { parseStellarError } from "../utils/stellarErrors";
import { getErrorMessage } from "../utils/errorMessages";
import { IconCheck, IconExternalLink, IconShield } from "./Icons";
import PaymentAlert, { getSeverityForCode } from "./PaymentAlert";
/* Suggested "what to do next" steps keyed by error code */
const RECOVERY_STEPS = {
  STELLAR_NETWORK_ERROR: [
    "Wait a few minutes for the Stellar network to recover.",
    "Check the Stellar network status page.",
    "Use the retry button below.",
  ],
  HORIZON_UNREACHABLE: [
    "Check your internet connection.",
    "Wait a few minutes, then retry.",
  HORIZON_UNAVAILABLE: [
    "The Stellar network is temporarily down.",
  tx_insufficient_fee: [
    "The network is congested — wait a few minutes.",
    "Retry with a higher transaction fee in your wallet.",
  op_underfunded: [
    "Add more XLM to your wallet to cover the payment and the transaction fee.",
    "Then retry the payment.",
  TX_FAILED: [
    "Review the transaction on Stellar Explorer.",
    "If the failure was temporary, retry verification.",
    "Contact support if the issue persists.",
  MISSING_MEMO: [
    "Ask the sender to resend with your Student ID in the memo field.",
    "Your Student ID is required for automatic matching.",
  UNDERPAID: [
    "Send the remaining balance to complete the fee.",
    "Use your Student ID as the memo.",
  INVALID_DESTINATION: [
    "Ensure the payment was sent to the school's wallet address.",
    "Contact the school if unsure of the correct address.",
};
const CRITICAL_STEPS = [
  "Do not retry — this requires manual intervention.",
  "Note the reference number shown below.",
  "Contact support with the reference number for assistance.",
];
import { IconAlertTriangle, IconCheck, IconExternalLink, IconShield } from "./Icons";
import TimestampDisplay from "./TimestampDisplay";
import { generateIdempotencyKey } from "../utils/idempotencyKey";
import TimestampDisplay, { DISPLAY_MODE } from "./TimestampDisplay";
import PaymentFailureBanner from "./PaymentFailureBanner";
const FEE_VALIDATION_SEVERITY = {
  valid:     null,
  overpaid:  "warning",
  underpaid: "warning",
  unknown:   "recoverable",
const FEE_VALIDATION_LABELS = {
  overpaid:  "Overpayment detected",
  underpaid: "Underpayment detected",
  unknown:   "Validation inconclusive",

const STATUS_BADGE = {
  valid:     { cls: "badge badge-success", key: "status.validation.valid" },
  overpaid:  { cls: "badge badge-warning", key: "status.validation.overpaid" },
  underpaid: { cls: "badge badge-danger",  key: "status.validation.underpaid" },
  unknown:   { cls: "badge badge-neutral", key: "status.validation.unknown" },
};

function InfoRow({ label, children, mono }) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-start",
      padding: "0.625rem 0",
      borderBottom: "1px solid var(--border)",
      gap: "0.5rem",
    }}>
      <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", flexShrink: 0 }}>{label}</span>
      <span style={{
        fontWeight: 600,
        textAlign: "right",
        wordBreak: "break-all",
        fontFamily: mono ? "monospace" : "inherit",
        fontSize: mono ? "0.8rem" : "inherit",
      }}>
        {children}
      </span>
    </div>
  );
}

export default function VerifyPayment({ disabled = false }) {
  const { t } = useTranslation();
  const [txHash, setTxHash]               = useState("");
  const [result, setResult]               = useState(null);
  const [error, setError]                 = useState(null); // { message, code, stellarStatusUrl }
  const [loading, setLoading]             = useState(false);
  const alertRef = useRef(null);

  // One idempotency key per form session — generated on mount, cleared only
  // after a confirmed 2xx success. Retries reuse the same key so the backend
  // deduplicates duplicate verification requests.
  const idempotencyKeyRef = useRef(null);
  useEffect(() => {
    idempotencyKeyRef.current = generateIdempotencyKey();
    return () => {
      // Reset the key when the component unmounts so a fresh mount gets a new one.
      idempotencyKeyRef.current = null;
    };
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const res = await verifyPayment(txHash.trim(), idempotencyKeyRef.current);
      setResult(res.data);
      // Confirmed success — clear the key so a subsequent submission (new
      // transaction hash) gets a fresh key rather than reusing the old one.
      idempotencyKeyRef.current = generateIdempotencyKey();
    } catch (err) {
      // 409 Conflict means the backend already processed this idempotency key
      // (duplicate submission). Treat it as a successful deduplication.
      if (err.response?.status === 409) {
        const existingResult = err.response?.data?.data ?? err.response?.data;
        if (existingResult) {
          setResult(existingResult);
          idempotencyKeyRef.current = generateIdempotencyKey();
          return;
        }
        setError(t("verifyPayment.alreadyCreated"));
        errorRef.current?.focus();
        return;
      }
      const stellar = parseStellarError(err);
      if (stellar) {
        const code = err.response?.data?.code || "STELLAR_NETWORK_ERROR";
        setError({
          message: stellar.message,
          code,
          stellarStatusUrl: stellar.stellarStatusUrl,
        });
      } else {
        const code = err.response?.data?.code;
        setError({
          message: getErrorMessage(code, err.response?.data?.error) || t("verifyPayment.verificationFailed"),
          code,
          stellarStatusUrl: null,
        });
      }
      setTimeout(() => alertRef.current?.focus(), 50);
    } finally {
      setLoading(false);
    }
  }

  function handleRetry() {
    handleSubmit({ preventDefault: () => {} });
  }

  const st = result?.feeValidation?.status || "unknown";
  const badge = STATUS_BADGE[st] || STATUS_BADGE.unknown;

  /* Resolve severity and steps for the current error */
  const errorSeverity = error ? getSeverityForCode(error.code) : null;
  const errorSteps = error
    ? (errorSeverity === "critical"
        ? CRITICAL_STEPS
        : RECOVERY_STEPS[error.code] || null)
    : null;

  /* Append a Stellar status link as an extra step if available */
  const stepsWithLink = error?.stellarStatusUrl && errorSteps
    ? [...errorSteps, `Check Stellar network status: ${error.stellarStatusUrl}`]
    : errorSteps;

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <IconShield size={15} /> {t("verifyPayment.title")}
        </div>
      </div>
      <div className="card-body">
        <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "1.25rem" }}>
          {t("verifyPayment.intro")}
        </p>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="txin" className="form-label">{t("verifyPayment.txHashLabel")}</label>
            <input
              id="txin"
              type="text"
              placeholder={t("verifyPayment.txHashPlaceholder")}
              value={txHash}
              onChange={e => setTxHash(e.target.value)}
              required
              className="form-input"
              style={{ fontFamily: "monospace", fontSize: "0.85rem" }}
            />
          </div>
          <button
            type="submit"
            disabled={loading || !txHash.trim() || disabled}
            className="btn btn-dark"
            style={{ width: "100%" }}
          >
            {loading ? t("verifyPayment.verifying") : t("verifyPayment.submit")}
          </button>
        </form>

        {/* Structured severity alert — replaces generic red banner */}
        {error && (
          <div ref={alertRef} tabIndex="-1" style={{ marginTop: "1rem", outline: "none" }}>
            <PaymentAlert
              severity={errorSeverity}
              title={error.message}
              steps={stepsWithLink}
              onRetry={
                errorSeverity === "error" ? handleRetry : undefined
              }
              correlationId={
                errorSeverity === "critical"
                  ? (error.code || "UNKNOWN")
                  : undefined
              }
              supportLink={
                errorSeverity === "critical"
                  ? "mailto:support@stellaredupay.example"
                  : undefined
              }
              onDismiss={() => setError(null)}
            />
          </div>
        )}

        {result && (
          <div style={{ marginTop: "1.25rem" }} role="status">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <IconCheck size={15} style={{ color: "var(--success-text)" }} />
                <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>{t("verifyPayment.transactionFound")}</span>
              </div>
              <span className={badge.cls}>{t(badge.key)}</span>
            </div>

            <InfoRow label={t("verifyPayment.amount")}>
              {result.amount}{" "}
              <span style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" }}>
                {result.assetCode || "XLM"}
              </span>
            </InfoRow>
            <InfoRow label={t("verifyPayment.memoLabel")} mono>{result.memo}</InfoRow>
            <InfoRow label={t("verifyPayment.date")}>
              {result.date
                ? <TimestampDisplay iso={result.date} />
                : "—"}
            </InfoRow>
            {result.feeValidation?.message && st !== "valid" && (
              <div style={{ marginTop: "0.875rem" }}>
                <PaymentFailureBanner
                  severity={FEE_VALIDATION_SEVERITY[st] || "warning"}
                  title={FEE_VALIDATION_LABELS[st] || "Validation issue"}
                  message={result.feeValidation.message}
                  compact={false}
                />
              </div>
            )}
            <div style={{ padding: "0.625rem 0" }}>
              <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "0.25rem" }}>{t("verifyPayment.txHash")}</div>
              <div style={{ fontFamily: "monospace", fontSize: "0.78rem", wordBreak: "break-all", color: "var(--text)" }}>
                {result.hash}
              </div>
              {result.stellarExplorerUrl && (
                <a
                  href={result.stellarExplorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", marginTop: "0.5rem", color: "var(--accent)", fontSize: "0.8125rem", fontWeight: 600 }}
                >
                  {t("verifyPayment.viewExplorer")} <IconExternalLink size={12} />
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
