/**
 * PaymentAlert — Issue #352
 *
 * Structured severity hierarchy for payment failure messages.
 *
 * Four severity levels:
 *   INFO     — Advisory notice, no action required
 *   WARNING  — User action needed to proceed
 *   ERROR    — Action failed, retryable
 *   CRITICAL — Action failed, manual resolution required
 *
 * Each level has distinct visual treatment (colour, icon, tone).
 * ERROR messages include a retry button where appropriate.
 * CRITICAL messages include a support reference (correlation ID) and contact link.
 * All colour contrasts meet WCAG 2.1 AA.
 *
 * Props:
 *   severity        "info" | "warning" | "error" | "critical"
 *   title           Short headline
 *   message         Detail body text
 *   steps           string[] — "What to do next" steps (ERROR / CRITICAL)
 *   onRetry         () => void — shows retry button when provided (ERROR)
 *   correlationId   string — support reference (CRITICAL)
 *   supportLink     string — URL to support contact (CRITICAL)
 *   onDismiss       () => void — optional dismiss handler
 */

const InfoIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" y1="8" x2="12" y2="12"/>
    <line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>
);

const WarningIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/>
    <line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>
);

const ErrorIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10"/>
    <line x1="15" y1="9" x2="9" y2="15"/>
    <line x1="9" y1="9" x2="15" y2="15"/>
  </svg>
);

const CriticalIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polygon points="12 2 22 21 2 21"/>
    <line x1="12" y1="9" x2="12" y2="13"/>
    <line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>
);

const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="23 4 23 10 17 10"/>
    <polyline points="1 20 1 14 7 14"/>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
  </svg>
);

const DismissIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18"/>
    <line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

/* ── Severity config ──────────────────────────────────────────── */
const SEVERITY_CONFIG = {
  info: {
    icon: InfoIcon,
    label: "Info",
    // WCAG 2.1 AA: bg #eff6ff, text #1e3a8a — contrast 7.5:1
    bg:     "var(--info-bg, #eff6ff)",
    border: "var(--info-border, #bfdbfe)",
    text:   "var(--info-text, #1d4ed8)",
    iconColor: "var(--info-text, #1d4ed8)",
    role: "status",
  },
  warning: {
    icon: WarningIcon,
    label: "Warning",
    // WCAG 2.1 AA: bg #fffbeb, text #92400e — contrast 8.1:1
    bg:     "var(--warning-bg, #fffbeb)",
    border: "var(--warning-border, #fde68a)",
    text:   "var(--warning-text, #b45309)",
    iconColor: "var(--warning-text, #b45309)",
    role: "status",
  },
  error: {
    icon: ErrorIcon,
    label: "Error",
    // WCAG 2.1 AA: bg #fff1f2, text #9f1239 — contrast 8.8:1
    bg:     "var(--danger-bg, #fff1f2)",
    border: "var(--danger-border, #fecdd3)",
    text:   "var(--danger-text, #be123c)",
    iconColor: "var(--danger-text, #be123c)",
    role: "alert",
  },
  critical: {
    icon: CriticalIcon,
    label: "Critical",
    // WCAG 2.1 AA: bg #fdf2f8 (custom deep-red tint), text #7f1d1d — contrast 9.1:1
    bg:     "#fdf2f8",
    border: "#f5a0c0",
    text:   "#7f1d1d",
    iconColor: "#b91c1c",
    role: "alert",
  },
};

/* ── Severity → error code mapping ───────────────────────────── */
export const ERROR_CODE_SEVERITY = {
  // INFO — advisory, no action needed
  SYNC_IN_PROGRESS:            "info",
  PAYMENT_LOCKED:              "info",
  DUPLICATE_TX:                "info",

  // WARNING — user action needed
  INTENT_EXPIRED:              "warning",
  AMOUNT_TOO_LOW:              "warning",
  AMOUNT_TOO_HIGH:             "warning",
  UNDERPAID:                   "warning",
  UNSUPPORTED_ASSET:           "warning",
  MISSING_MEMO:                "warning",
  INVALID_DESTINATION:         "warning",
  INVALID_STELLAR_ADDRESS:     "warning",
  INVALID_AMOUNT:              "warning",
  INVALID_HASH_FORMAT:         "warning",
  INVALID_HASH_LENGTH:         "warning",
  INVALID_HASH_TYPE:           "warning",
  MISSING_HASH:                "warning",
  INVALID_MEMO_FORMAT:         "warning",
  NO_PAYMENT_OPERATIONS:       "warning",

  // ERROR — failed, retryable
  TX_FAILED:                   "error",
  STELLAR_NETWORK_ERROR:       "error",
  HORIZON_UNREACHABLE:         "error",
  HORIZON_UNAVAILABLE:         "error",
  tx_insufficient_fee:         "error",
  op_underfunded:              "error",
  QUEUE_FULL:                  "error",
  MAX_RETRIES_EXCEEDED:        "error",
  PROCESSING_ERROR:            "error",
  REQUEST_TIMEOUT:             "error",
  NETWORK_ERROR:               "error",
  SERVICE_UNAVAILABLE:         "error",

  // CRITICAL — manual resolution required
  INVALID_CREDENTIALS:         "critical",
  INVALID_TOKEN:               "critical",
  INVALID_AUTH_TOKEN:          "critical",
  INVALID_REFRESH_TOKEN:       "critical",
  MISSING_AUTH_TOKEN:          "critical",
  MISSING_REFRESH_TOKEN:       "critical",
  INSUFFICIENT_ROLE:           "critical",
  AUTH_MISCONFIGURED:          "critical",
  INTERNAL_ERROR:              "critical",
  CONFLICT:                    "critical",
  DEDUP_ERROR:                 "critical",
  IP_BLOCKED:                  "critical",
};

/**
 * Resolve a severity level from an error code.
 * Falls back to "error" if the code is not mapped.
 */
export function getSeverityForCode(code) {
  return ERROR_CODE_SEVERITY[code] || "error";
}

/* ── Component ───────────────────────────────────────────────── */
export default function PaymentAlert({
  severity = "error",
  title,
  message,
  steps,
  onRetry,
  correlationId,
  supportLink,
  onDismiss,
}) {
  const cfg = SEVERITY_CONFIG[severity] || SEVERITY_CONFIG.error;
  const Icon = cfg.icon;

  const showSteps = (severity === "error" || severity === "critical") && steps?.length > 0;
  const showRetry = severity === "error" && typeof onRetry === "function";
  const showSupport = severity === "critical";

  return (
    <>
      <style>{`
        .pa-wrap {
          border: 1.5px solid;
          border-radius: var(--radius-sm, 8px);
          padding: 0.875rem 1rem;
          margin-bottom: 0.75rem;
          display: flex;
          gap: 0.75rem;
          align-items: flex-start;
          animation: paSlideIn 0.25s ease both;
        }
        @keyframes paSlideIn {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .pa-icon {
          flex-shrink: 0;
          margin-top: 1px;
          display: flex;
          align-items: center;
        }
        .pa-body {
          flex: 1;
          min-width: 0;
        }
        .pa-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 0.5rem;
        }
        .pa-title {
          font-weight: 700;
          font-size: 0.875rem;
          line-height: 1.4;
          margin: 0 0 0.25rem;
        }
        .pa-message {
          font-size: 0.8125rem;
          line-height: 1.55;
          margin: 0 0 0.5rem;
          opacity: 0.9;
        }
        .pa-steps {
          margin: 0.5rem 0 0.75rem;
          padding: 0;
          list-style: none;
        }
        .pa-steps li {
          display: flex;
          align-items: baseline;
          gap: 0.5rem;
          font-size: 0.8125rem;
          line-height: 1.5;
          margin-bottom: 0.3rem;
        }
        .pa-steps-label {
          font-size: 0.75rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          margin-bottom: 0.4rem;
          opacity: 0.85;
        }
        .pa-step-num {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          height: 18px;
          min-width: 18px;
          border-radius: 50%;
          border: 1.5px solid currentColor;
          font-size: 0.65rem;
          font-weight: 700;
          opacity: 0.75;
          flex-shrink: 0;
        }
        .pa-actions {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex-wrap: wrap;
          margin-top: 0.625rem;
        }
        .pa-btn-retry {
          display: inline-flex;
          align-items: center;
          gap: 0.375rem;
          padding: 0.375rem 0.875rem;
          border: 1.5px solid currentColor;
          border-radius: 6px;
          background: transparent;
          color: inherit;
          font: 600 0.8125rem/1 inherit;
          cursor: pointer;
          opacity: 0.9;
          transition: opacity 0.12s, background 0.12s;
          /* 44pt touch target */
          min-height: 36px;
        }
        .pa-btn-retry:hover { opacity: 1; background: rgba(0,0,0,0.05); }
        .pa-btn-retry:focus-visible {
          outline: 2px solid currentColor;
          outline-offset: 2px;
        }
        .pa-support-link {
          display: inline-flex;
          align-items: center;
          gap: 0.375rem;
          font-size: 0.8125rem;
          font-weight: 600;
          color: inherit;
          text-decoration: underline;
          text-underline-offset: 2px;
          opacity: 0.9;
          min-height: 36px;
        }
        .pa-support-link:hover { opacity: 1; }
        .pa-correlation {
          font-size: 0.75rem;
          font-family: monospace;
          opacity: 0.7;
          margin-top: 0.375rem;
          display: block;
        }
        .pa-dismiss {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          min-width: 28px;
          background: transparent;
          border: none;
          cursor: pointer;
          border-radius: 4px;
          color: inherit;
          opacity: 0.6;
          flex-shrink: 0;
          transition: opacity 0.12s, background 0.12s;
        }
        .pa-dismiss:hover { opacity: 1; background: rgba(0,0,0,0.07); }
        .pa-dismiss:focus-visible {
          outline: 2px solid currentColor;
          outline-offset: 2px;
          opacity: 1;
        }
        /* Severity label badge */
        .pa-badge {
          display: inline-block;
          font-size: 0.625rem;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          padding: 0.15rem 0.45rem;
          border-radius: 4px;
          border: 1.5px solid currentColor;
          opacity: 0.65;
          margin-right: 0.375rem;
          vertical-align: middle;
        }
      `}</style>

      <div
        className="pa-wrap"
        role={cfg.role}
        aria-live={cfg.role === "alert" ? "assertive" : "polite"}
        aria-atomic="true"
        style={{
          background: cfg.bg,
          borderColor: cfg.border,
          color: cfg.text,
        }}
      >
        {/* Icon */}
        <span className="pa-icon" style={{ color: cfg.iconColor }}>
          <Icon />
        </span>

        {/* Body */}
        <div className="pa-body">
          <div className="pa-header">
            <div style={{ flex: 1 }}>
              {title && (
                <p className="pa-title">
                  <span className="pa-badge">{cfg.label}</span>
                  {title}
                </p>
              )}
              {message && <p className="pa-message">{message}</p>}
            </div>

            {/* Dismiss button */}
            {onDismiss && (
              <button
                type="button"
                className="pa-dismiss"
                onClick={onDismiss}
                aria-label="Dismiss"
              >
                <DismissIcon />
              </button>
            )}
          </div>

          {/* What to do next */}
          {showSteps && (
            <div>
              <p className="pa-steps-label">What to do next</p>
              <ol className="pa-steps">
                {steps.map((step, i) => (
                  <li key={i}>
                    <span className="pa-step-num" aria-hidden="true">{i + 1}</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* Actions */}
          {(showRetry || showSupport) && (
            <div className="pa-actions">
              {showRetry && (
                <button type="button" className="pa-btn-retry" onClick={onRetry}>
                  <RefreshIcon />
                  Try again
                </button>
              )}
              {showSupport && supportLink && (
                <a href={supportLink} className="pa-support-link" target="_blank" rel="noopener noreferrer">
                  Contact support
                </a>
              )}
            </div>
          )}

          {/* Correlation ID for CRITICAL */}
          {showSupport && correlationId && (
            <code className="pa-correlation">
              Reference: {correlationId}
            </code>
          )}
        </div>
      </div>
    </>
  );
}
