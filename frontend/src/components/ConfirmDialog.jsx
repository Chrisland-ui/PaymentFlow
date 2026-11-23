/**
 * ConfirmDialog — Issue #356
 *
 * Tiered confirmation dialog system for destructive actions.
 *
 * Tiers:
 *  LOW      — standard confirm/cancel dialog. Backdrop click closes.
 *  HIGH     — user must type a specific phrase to enable the confirm button.
 *             Backdrop click disabled.
 *  CRITICAL — requires admin password re-entry before proceeding.
 *             Backdrop click disabled. Escape key disabled.
 *
 * Usage:
 *  <ConfirmDialog
 *    open={showDialog}
 *    tier="HIGH"
 *    title="Void Payment"
 *    description="This will permanently void the payment and cannot be undone."
 *    confirmPhrase="void payment"   // required for HIGH tier
 *    confirmLabel="Void Payment"
 *    onConfirm={handleVoid}
 *    onCancel={() => setShowDialog(false)}
 *  />
 *
 *  For CRITICAL tier, onConfirm receives the entered password:
 *    onConfirm={(password) => submitWithPassword(password)}
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { IconAlertTriangle, IconX, IconShield, IconCheck } from "./Icons";

export const CONFIRM_TIER = Object.freeze({
  LOW:      "LOW",
  HIGH:     "HIGH",
  CRITICAL: "CRITICAL",
});

// Tier metadata
const TIER_META = {
  [CONFIRM_TIER.LOW]: {
    headerBg:     "var(--bg-subtle)",
    headerBorder: "var(--border)",
    iconBg:       "var(--info-bg)",
    iconColor:    "var(--info-text)",
    Icon:         IconAlertTriangle,
    backdropClose: true,
    escapeClose:   true,
  },
  [CONFIRM_TIER.HIGH]: {
    headerBg:     "var(--warning-bg)",
    headerBorder: "var(--warning-border)",
    iconBg:       "var(--warning-bg)",
    iconColor:    "var(--warning-text)",
    Icon:         IconAlertTriangle,
    backdropClose: false,
    escapeClose:   true,
  },
  [CONFIRM_TIER.CRITICAL]: {
    headerBg:     "var(--danger-bg)",
    headerBorder: "var(--danger-border)",
    iconBg:       "var(--danger-bg)",
    iconColor:    "var(--danger-text)",
    Icon:         IconShield,
    backdropClose: false,
    escapeClose:   false,
  },
};

export default function ConfirmDialog({
  open = false,
  tier = CONFIRM_TIER.LOW,
  title,
  description,
  confirmPhrase,    // Required for HIGH tier — user must type this exactly
  confirmLabel = "Confirm",
  cancelLabel  = "Cancel",
  onConfirm,
  onCancel,
  loading = false,
}) {
  const [typed, setTyped]       = useState("");
  const [password, setPassword] = useState("");
  const [pwError, setPwError]   = useState(null);
  const dialogRef               = useRef(null);
  const inputRef                = useRef(null);

  const meta = TIER_META[tier] || TIER_META[CONFIRM_TIER.LOW];

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setTyped("");
      setPassword("");
      setPwError(null);
      // Focus the type-to-confirm input or dialog itself when it opens
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Keyboard handler
  const handleKeyDown = useCallback((e) => {
    if (!open) return;
    if (e.key === "Escape" && meta.escapeClose) {
      onCancel?.();
    }
    // Trap focus inside dialog
    if (e.key === "Tab" && dialogRef.current) {
      const focusable = dialogRef.current.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      const first = focusable[0];
      const last  = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  }, [open, meta.escapeClose, onCancel]);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Lock body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  if (!open) return null;

  // Determine whether confirm button is enabled
  const phraseMatch = tier === CONFIRM_TIER.HIGH
    ? typed.trim().toLowerCase() === (confirmPhrase || "").toLowerCase()
    : true;
  const passwordFilled = tier === CONFIRM_TIER.CRITICAL
    ? password.trim().length > 0
    : true;
  const canConfirm = phraseMatch && passwordFilled && !loading;

  function handleConfirm() {
    if (!canConfirm) return;
    setPwError(null);
    if (tier === CONFIRM_TIER.CRITICAL) {
      onConfirm?.(password);
    } else {
      onConfirm?.();
    }
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget && meta.backdropClose) {
      onCancel?.();
    }
  }

  const TierIcon = meta.Icon;

  return (
    <>
      <style>{`
        .confirm-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.55);
          backdrop-filter: blur(2px);
          z-index: 9999;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1rem;
          animation: confirmFadeIn 0.15s ease both;
        }
        @keyframes confirmFadeIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        .confirm-dialog {
          background: var(--card-bg);
          border: 1px solid var(--border);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-lg);
          width: 100%;
          max-width: 440px;
          overflow: hidden;
          animation: confirmSlideUp 0.18s ease both;
        }
        @keyframes confirmSlideUp {
          from { opacity: 0; transform: translateY(16px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        .confirm-header {
          padding: 1.25rem 1.25rem 1rem;
          border-bottom: 1px solid var(--border);
          display: flex;
          align-items: flex-start;
          gap: 0.875rem;
        }
        .confirm-icon-wrap {
          width: 38px;
          height: 38px;
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .confirm-title {
          font-size: 1rem;
          font-weight: 700;
          color: var(--text);
          line-height: 1.2;
          margin-bottom: 0.25rem;
        }
        .confirm-desc {
          font-size: 0.8375rem;
          color: var(--text-muted);
          line-height: 1.5;
        }
        .confirm-body {
          padding: 1rem 1.25rem;
        }
        .confirm-tier-badge {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          padding: 0.2rem 0.5rem;
          border-radius: 6px;
          font-size: 0.7rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          margin-bottom: 0.875rem;
        }
        .confirm-phrase-input,
        .confirm-password-input {
          width: 100%;
          padding: 0.5rem 0.75rem;
          border: 1.5px solid var(--border);
          border-radius: var(--radius-sm);
          background: var(--bg);
          color: var(--text);
          font-size: 0.875rem;
          font-family: monospace;
          box-sizing: border-box;
          transition: border-color 0.15s, box-shadow 0.15s;
          outline: none;
        }
        .confirm-phrase-input:focus,
        .confirm-password-input:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-subtle);
        }
        .confirm-phrase-input.match {
          border-color: var(--success);
          box-shadow: 0 0 0 3px var(--success-bg);
        }
        .confirm-footer {
          padding: 0.875rem 1.25rem;
          border-top: 1px solid var(--border);
          display: flex;
          justify-content: flex-end;
          gap: 0.625rem;
        }
        .confirm-btn-cancel {
          padding: 0.5rem 1rem;
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          background: var(--bg);
          color: var(--text);
          font-size: 0.875rem;
          font-weight: 500;
          cursor: pointer;
          font-family: inherit;
          transition: background 0.12s, border-color 0.12s;
        }
        .confirm-btn-cancel:hover {
          background: var(--bg-subtle);
          border-color: var(--border-strong);
        }
        .confirm-btn-confirm {
          padding: 0.5rem 1.125rem;
          border: none;
          border-radius: var(--radius-sm);
          font-size: 0.875rem;
          font-weight: 700;
          cursor: pointer;
          font-family: inherit;
          transition: opacity 0.12s, filter 0.12s;
        }
        .confirm-btn-confirm:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .confirm-btn-confirm:not(:disabled):hover {
          filter: brightness(1.1);
        }
      `}</style>

      {/* Backdrop */}
      <div
        className="confirm-backdrop"
        onClick={handleBackdropClick}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-desc"
      >
        <div className="confirm-dialog" ref={dialogRef}>

          {/* Header */}
          <div className="confirm-header" style={{ background: meta.headerBg, borderBottomColor: meta.headerBorder }}>
            <div
              className="confirm-icon-wrap"
              style={{ background: meta.iconBg }}
            >
              <TierIcon size={18} style={{ color: meta.iconColor }} />
            </div>
            <div>
              <div id="confirm-dialog-title" className="confirm-title">
                {title}
              </div>
              <div id="confirm-dialog-desc" className="confirm-desc">
                {description}
              </div>
            </div>
          </div>

          {/* Body */}
          <div className="confirm-body">
            {/* Tier badge */}
            {(tier === CONFIRM_TIER.HIGH || tier === CONFIRM_TIER.CRITICAL) && (
              <div
                className="confirm-tier-badge"
                style={{
                  background: tier === CONFIRM_TIER.CRITICAL ? "var(--danger-bg)" : "var(--warning-bg)",
                  color:      tier === CONFIRM_TIER.CRITICAL ? "var(--danger-text)" : "var(--warning-text)",
                  border:     `1px solid ${tier === CONFIRM_TIER.CRITICAL ? "var(--danger-border)" : "var(--warning-border)"}`,
                }}
              >
                <TierIcon size={10} />
                {tier === CONFIRM_TIER.CRITICAL ? "Critical action" : "Destructive action"}
              </div>
            )}

            {/* HIGH tier: type-to-confirm */}
            {tier === CONFIRM_TIER.HIGH && confirmPhrase && (
              <div>
                <label
                  htmlFor="confirm-type-input"
                  style={{
                    display: "block",
                    fontSize: "0.8125rem",
                    color: "var(--text-muted)",
                    marginBottom: "0.5rem",
                    lineHeight: 1.4,
                  }}
                >
                  Type <strong style={{ color: "var(--text)", fontFamily: "monospace" }}>{confirmPhrase}</strong> to confirm:
                </label>
                <input
                  id="confirm-type-input"
                  ref={inputRef}
                  type="text"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && canConfirm) handleConfirm(); }}
                  placeholder={confirmPhrase}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`Type "${confirmPhrase}" to confirm`}
                  className={`confirm-phrase-input${phraseMatch && typed.length > 0 ? " match" : ""}`}
                />
                {typed.length > 0 && !phraseMatch && (
                  <div style={{ marginTop: "0.375rem", fontSize: "0.75rem", color: "var(--danger-text)" }}>
                    Text does not match — type exactly: <em>{confirmPhrase}</em>
                  </div>
                )}
                {phraseMatch && typed.length > 0 && (
                  <div style={{ marginTop: "0.375rem", fontSize: "0.75rem", color: "var(--success-text)", display: "flex", alignItems: "center", gap: "0.25rem" }}>
                    <IconCheck size={12} /> Phrase confirmed
                  </div>
                )}
              </div>
            )}

            {/* CRITICAL tier: password re-entry */}
            {tier === CONFIRM_TIER.CRITICAL && (
              <div>
                <label
                  htmlFor="confirm-password-input"
                  style={{
                    display: "block",
                    fontSize: "0.8125rem",
                    color: "var(--text-muted)",
                    marginBottom: "0.5rem",
                    lineHeight: 1.4,
                  }}
                >
                  Enter your admin password to proceed:
                </label>
                <input
                  id="confirm-password-input"
                  ref={inputRef}
                  type="password"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setPwError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter" && canConfirm) handleConfirm(); }}
                  placeholder="Your password"
                  autoComplete="current-password"
                  aria-label="Admin password for re-authentication"
                  className="confirm-password-input"
                  aria-invalid={pwError ? "true" : undefined}
                  aria-describedby={pwError ? "confirm-pw-error" : undefined}
                />
                {pwError && (
                  <div
                    id="confirm-pw-error"
                    role="alert"
                    style={{ marginTop: "0.375rem", fontSize: "0.75rem", color: "var(--danger-text)", display: "flex", alignItems: "center", gap: "0.25rem" }}
                  >
                    <IconAlertTriangle size={11} /> {pwError}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="confirm-footer">
            {/* Cancel — always available on LOW/HIGH, available on CRITICAL except when loading */}
            {(tier !== CONFIRM_TIER.CRITICAL || !loading) && (
              <button
                type="button"
                className="confirm-btn-cancel"
                onClick={onCancel}
                disabled={loading}
              >
                {cancelLabel}
              </button>
            )}

            <button
              type="button"
              className="confirm-btn-confirm"
              onClick={handleConfirm}
              disabled={!canConfirm}
              aria-disabled={!canConfirm}
              style={{
                background: tier === CONFIRM_TIER.CRITICAL
                  ? "var(--danger)"
                  : tier === CONFIRM_TIER.HIGH
                  ? "var(--warning)"
                  : "var(--accent)",
                color: "#fff",
              }}
            >
              {loading ? "Processing…" : confirmLabel}
            </button>
          </div>

        </div>
      </div>
    </>
  );
}
