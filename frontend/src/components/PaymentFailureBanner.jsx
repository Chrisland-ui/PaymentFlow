/**
 * PaymentFailureBanner — Issue #104
 *
 * Displays a contextual, accessible banner for payment failure states.
 *
 * Four severity levels, each with a distinct icon + label + colour token so
 * severity is never conveyed by colour alone:
 *
 *  - "warning"   : Recoverable, user-correctable (e.g. underpayment, wrong asset)
 *  - "recoverable": System-side failure the user can retry (e.g. network error)
 *  - "terminal"  : Permanent failure — no further action possible
 *  - "security"  : Security / fraud block — requires admin intervention
 *
 * Props:
 *  severity  "warning" | "recoverable" | "terminal" | "security"
 *  title     string  — short headline (required)
 *  message   string  — detail copy (optional)
 *  action    { label: string, onClick?: fn, href?: string } — next-action CTA
 *  onDismiss fn      — show an ✕ dismiss button if provided
 *  compact   bool    — single-line inline variant (default false)
 */

const WarningIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/>
    <line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>
);

const RetryIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <polyline points="23 4 23 10 17 10"/>
    <polyline points="1 20 1 14 7 14"/>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
  </svg>
);

const TerminalIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="10"/>
    <line x1="15" y1="9" x2="9" y2="15"/>
    <line x1="9" y1="9" x2="15" y2="15"/>
  </svg>
);

const SecurityIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    <line x1="12" y1="8" x2="12" y2="12"/>
    <line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>
);

const DismissIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <line x1="18" y1="6" x2="6" y2="18"/>
    <line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

/**
 * Severity config — each entry defines:
 *   icon       React element
 *   label      Short accessible prefix (read before the title by screen-readers)
 *   bg         CSS var for background
 *   border     CSS var for border
 *   iconColor  CSS var for icon / text color
 *   role       ARIA role to use on the container
 */
const SEVERITY_CONFIG = {
  warning: {
    Icon:       WarningIcon,
    label:      "Warning",
    bg:         "var(--warning-bg, #fffbeb)",
    border:     "var(--warning-border, #fde68a)",
    iconColor:  "var(--warning-text, #b45309)",
    role:       "status",
    ariaLive:   "polite",
  },
  recoverable: {
    Icon:       RetryIcon,
    label:      "Retry required",
    bg:         "var(--info-bg, #eff6ff)",
    border:     "var(--info-border, #bfdbfe)",
    iconColor:  "var(--info-text, #1d4ed8)",
    role:       "status",
    ariaLive:   "polite",
  },
  terminal: {
    Icon:       TerminalIcon,
    label:      "Payment failed",
    bg:         "var(--danger-bg, #fff1f2)",
    border:     "var(--danger-border, #fecdd3)",
    iconColor:  "var(--danger-text, #be123c)",
    role:       "alert",
    ariaLive:   "assertive",
  },
  security: {
    Icon:       SecurityIcon,
    label:      "Security block",
    bg:         "var(--danger-bg, #fff1f2)",
    border:     "var(--danger-border, #fecdd3)",
    iconColor:  "var(--danger-text, #be123c)",
    role:       "alert",
    ariaLive:   "assertive",
  },
};

export default function PaymentFailureBanner({
  severity = "warning",
  title,
  message,
  action,
  onDismiss,
  compact = false,
}) {
  const config = SEVERITY_CONFIG[severity] || SEVERITY_CONFIG.warning;
  const { Icon, label, bg, border, iconColor, role, ariaLive } = config;

  if (!title) return null;

  return (
    <>
      <style>{`
        .pfb-wrap {
          border-radius: var(--radius, 10px);
          border-left-width: 4px;
          border-left-style: solid;
          border-top: 1px solid;
          border-right: 1px solid;
          border-bottom: 1px solid;
          padding: 0.875rem 1rem;
          display: flex;
          align-items: flex-start;
          gap: 0.75rem;
          position: relative;
          font-size: 0.875rem;
          line-height: 1.5;
        }
        .pfb-wrap.compact {
          padding: 0.5rem 0.875rem;
          align-items: center;
          border-radius: var(--radius-sm, 8px);
        }
        .pfb-icon-wrap {
          flex-shrink: 0;
          margin-top: 1px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .pfb-wrap.compact .pfb-icon-wrap {
          margin-top: 0;
        }
        .pfb-body {
          flex: 1;
          min-width: 0;
        }
        .pfb-header {
          display: flex;
          align-items: baseline;
          gap: 0.5rem;
          flex-wrap: wrap;
        }
        .pfb-severity-label {
          font-size: 0.68rem;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          padding: 0.1rem 0.45rem;
          border-radius: 4px;
          background: currentColor;
          /* Use background with opacity trick so it respects the iconColor */
          opacity: 0.9;
          white-space: nowrap;
        }
        .pfb-title {
          font-weight: 600;
          color: var(--text, #0f172a);
        }
        .pfb-message {
          margin-top: 0.2rem;
          color: var(--text-muted, #64748b);
          font-size: 0.8375rem;
        }
        .pfb-action {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          margin-top: 0.6rem;
          padding: 0.375rem 0.875rem;
          border-radius: 7px;
          font-size: 0.8125rem;
          font-weight: 600;
          font-family: inherit;
          cursor: pointer;
          transition: filter 0.13s, background 0.13s;
          text-decoration: none;
          border: 1.5px solid currentColor;
          background: transparent;
        }
        .pfb-action:hover { filter: brightness(0.88); }
        .pfb-action:focus-visible {
          outline: 2px solid currentColor;
          outline-offset: 2px;
        }
        .pfb-wrap.compact .pfb-action {
          margin-top: 0;
        }
        .pfb-dismiss {
          flex-shrink: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 26px; height: 26px;
          border-radius: 6px;
          background: transparent;
          border: none;
          cursor: pointer;
          opacity: 0.6;
          transition: opacity 0.12s, background 0.12s;
          margin-left: 0.25rem;
        }
        .pfb-dismiss:hover { opacity: 1; background: rgba(0,0,0,0.06); }
        .pfb-dismiss:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }
      `}</style>

      <div
        className={`pfb-wrap${compact ? " compact" : ""}`}
        role={role}
        aria-live={ariaLive}
        aria-atomic="true"
        style={{
          background: bg,
          borderColor: border,
          borderLeftColor: iconColor,
        }}
      >
        {/* Icon */}
        <div className="pfb-icon-wrap" style={{ color: iconColor }}>
          <Icon />
        </div>

        {/* Body */}
        <div className="pfb-body">
          <div className="pfb-header">
            {/* Severity label — not colour-only, it's a text badge */}
            <span
              className="pfb-severity-label"
              style={{
                background: iconColor,
                color: "#fff",
              }}
              aria-hidden="true"
            >
              {label}
            </span>
            <span className="pfb-title">{title}</span>
          </div>

          {message && !compact && (
            <div className="pfb-message">{message}</div>
          )}

          {action && !compact && (
            action.href ? (
              <a
                href={action.href}
                className="pfb-action"
                style={{ color: iconColor }}
                target={action.external ? "_blank" : undefined}
                rel={action.external ? "noopener noreferrer" : undefined}
              >
                {action.label}
              </a>
            ) : (
              <button
                type="button"
                className="pfb-action"
                style={{ color: iconColor }}
                onClick={action.onClick}
              >
                {action.label}
              </button>
            )
          )}
        </div>

        {/* Compact inline action */}
        {action && compact && (
          action.href ? (
            <a
              href={action.href}
              className="pfb-action"
              style={{ color: iconColor, marginLeft: "auto", flexShrink: 0 }}
            >
              {action.label}
            </a>
          ) : (
            <button
              type="button"
              className="pfb-action"
              style={{ color: iconColor, marginLeft: "auto", flexShrink: 0 }}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          )
        )}

        {/* Dismiss button */}
        {onDismiss && (
          <button
            type="button"
            className="pfb-dismiss"
            onClick={onDismiss}
            aria-label="Dismiss notification"
            style={{ color: iconColor }}
          >
            <DismissIcon />
          </button>
        )}
      </div>
    </>
  );
}

/**
 * PaymentStatusBadge — inline severity badge for table cells / status columns.
 *
 * Maps a PAYMENT_STATUS value to a severity level and renders a compact badge
 * with icon + text so status is never colour-only.
 */
const STATUS_SEVERITY_MAP = {
  PENDING:   "warning",
  SUBMITTED: "recoverable",
  SUCCESS:   null,          // handled by existing success badge
  FAILED:    "terminal",
  DISPUTED:  "warning",
  REFUNDED:  "recoverable",
  INVALID:   "terminal",
};

const STATUS_LABELS = {
  PENDING:   "Pending",
  SUBMITTED: "Submitted",
  FAILED:    "Failed",
  DISPUTED:  "Disputed",
  REFUNDED:  "Refunded",
  INVALID:   "Invalid",
};

export function PaymentStatusBadge({ status }) {
  if (!status) return null;
  const severity = STATUS_SEVERITY_MAP[status];
  if (!severity) return null; // SUCCESS uses the existing success badge

  const config = SEVERITY_CONFIG[severity];
  const { Icon, iconColor, bg, border } = config;
  const label = STATUS_LABELS[status] || status;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.3rem",
        padding: "0.2rem 0.55rem",
        borderRadius: "6px",
        background: bg,
        border: `1px solid ${border}`,
        color: iconColor,
        fontSize: "0.78rem",
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
      aria-label={label}
    >
      <Icon />
      {label}
    </span>
  );
}
