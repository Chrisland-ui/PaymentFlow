import { IconCheck, IconExternalLink } from "./Icons";

/**
 * BlockchainConfirmationStatus
 *
 * Translates raw Stellar transaction states into plain-language steps that
 * are meaningful to school administrators — no blockchain jargon required.
 *
 * States (mapped from backend confirmation_state field):
 *   submitted   → "Sending to network"
 *   processing  → "Network is processing"
 *   confirmed   → "Payment confirmed"
 *   settled     → "Receipt secured on blockchain"  (final)
 *
 * Accessibility: colour is never the only differentiator — each step also
 * carries an icon and a descriptive aria-label.
 *
 * @param {object}  props
 * @param {string}  props.state              - One of: submitted | processing | confirmed | settled
 * @param {string}  [props.explorerUrl]      - Optional Stellar explorer URL (de-emphasised)
 * @param {string}  [props.explorerLabel]    - Override link text (default: "View on explorer")
 * @param {string}  [props.className]        - Additional CSS class on wrapper
 */
export default function BlockchainConfirmationStatus({
  state = "submitted",
  explorerUrl,
  explorerLabel = "View on explorer",
  className,
}) {
  const STEPS = [
    {
      id: "submitted",
      label: "Sending to network",
      description: "Your payment is being sent to the Stellar network.",
      shortLabel: "Sending",
    },
    {
      id: "processing",
      label: "Network is processing",
      description: "The Stellar network has received the transaction and is processing it.",
      shortLabel: "Processing",
    },
    {
      id: "confirmed",
      label: "Payment confirmed",
      description: "The transaction has been recorded in the blockchain ledger.",
      shortLabel: "Confirmed",
    },
    {
      id: "settled",
      label: "Receipt secured on blockchain",
      description: "The payment is permanently and immutably recorded. The receipt is now final.",
      shortLabel: "Secured",
    },
  ];

  const currentIndex = STEPS.findIndex((s) => s.id === state);
  // Fall back to first step for unknown states
  const activeIndex = currentIndex === -1 ? 0 : currentIndex;
  const isComplete = state === "settled";

  const stepStateFor = (index) => {
    if (index < activeIndex) return "complete";
    if (index === activeIndex) return "active";
    return "pending";
  };

  return (
    <div
      className={className}
      role="region"
      aria-label="Blockchain confirmation progress"
      style={{ fontFamily: "inherit" }}
    >
      {/* Stepper */}
      <ol
        aria-label="Confirmation steps"
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: 0,
        }}
      >
        {STEPS.map((step, index) => {
          const stepState = stepStateFor(index);
          const isLast = index === STEPS.length - 1;

          return (
            <li
              key={step.id}
              aria-current={stepState === "active" ? "step" : undefined}
              style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start" }}
            >
              {/* Step indicator column */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  flexShrink: 0,
                }}
              >
                <StepDot state={stepState} index={index} />

                {/* Connector line between steps */}
                {!isLast && (
                  <div
                    aria-hidden="true"
                    style={{
                      width: "2px",
                      height: "2rem",
                      background:
                        stepState === "complete"
                          ? "var(--success)"
                          : "var(--border)",
                      margin: "2px 0",
                      transition: "background 0.3s ease",
                    }}
                  />
                )}
              </div>

              {/* Step content */}
              <div style={{ paddingBottom: isLast ? 0 : "0.5rem", paddingTop: "1px" }}>
                <p
                  style={{
                    margin: 0,
                    fontWeight: stepState === "active" ? 600 : 500,
                    fontSize: "0.875rem",
                    color:
                      stepState === "complete"
                        ? "var(--success-text)"
                        : stepState === "active"
                        ? "var(--text)"
                        : "var(--text-muted)",
                    lineHeight: 1.4,
                  }}
                >
                  {step.label}
                </p>
                {stepState === "active" && (
                  <p
                    style={{
                      margin: "0.2rem 0 0",
                      fontSize: "0.775rem",
                      color: "var(--text-muted)",
                      lineHeight: 1.5,
                    }}
                  >
                    {step.description}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {/* Progress ring summary bar */}
      <ProgressBar activeIndex={activeIndex} total={STEPS.length} isComplete={isComplete} />

      {/* De-emphasised explorer link — for advanced users only */}
      {explorerUrl && (
        <div style={{ marginTop: "1rem" }}>
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${explorerLabel} (opens in new tab)`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.3rem",
              fontSize: "0.775rem",
              color: "var(--text-muted)",
              textDecoration: "none",
              borderBottom: "1px dashed var(--border)",
              paddingBottom: "1px",
              transition: "color 0.15s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--accent)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            <IconExternalLink size={11} />
            {explorerLabel}
          </a>
        </div>
      )}
    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────────────────────── */

function StepDot({ state, index }) {
  const size = 24;

  if (state === "complete") {
    return (
      <span
        aria-label="Step complete"
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: "var(--success)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          transition: "background 0.3s ease",
        }}
      >
        <IconCheck size={12} style={{ color: "#fff" }} />
      </span>
    );
  }

  if (state === "active") {
    return (
      <span
        aria-label="Current step"
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: "var(--accent)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          boxShadow: "0 0 0 4px var(--accent-ring)",
          transition: "box-shadow 0.2s ease",
          position: "relative",
        }}
      >
        {/* Pulsing ring to indicate live activity */}
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            width: size,
            height: size,
            borderRadius: "50%",
            border: "2px solid var(--accent)",
            opacity: 0,
            animation: "bcsPulse 1.8s ease-out infinite",
          }}
        />
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "#fff",
          }}
        />
      </span>
    );
  }

  // pending
  return (
    <span
      aria-label={`Step ${index + 1} pending`}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: "2px solid var(--border)",
        background: "var(--card-bg)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--text-subtle)",
        fontSize: "0.7rem",
        fontWeight: 600,
      }}
    >
      {index + 1}
    </span>
  );
}

function ProgressBar({ activeIndex, total, isComplete }) {
  const pct = isComplete ? 100 : Math.round(((activeIndex) / (total - 1)) * 100);

  return (
    <div style={{ marginTop: "1.25rem" }}>
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Confirmation progress: ${pct}%`}
        style={{
          height: "6px",
          borderRadius: "999px",
          background: "var(--border)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            borderRadius: "999px",
            background: isComplete ? "var(--success)" : "var(--accent)",
            transition: "width 0.5s ease, background 0.3s ease",
          }}
        />
      </div>
      <p
        aria-live="polite"
        style={{
          fontSize: "0.75rem",
          color: isComplete ? "var(--success-text)" : "var(--text-muted)",
          marginTop: "0.375rem",
          textAlign: "right",
          fontWeight: isComplete ? 600 : 400,
        }}
      >
        {isComplete ? "Fully secured on blockchain ✓" : `${pct}% complete`}
      </p>
      {/* Keyframe for pulse animation — injected once */}
      <style>{`
        @keyframes bcsPulse {
          0%   { transform: scale(1);   opacity: 0.6; }
          100% { transform: scale(2.2); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
