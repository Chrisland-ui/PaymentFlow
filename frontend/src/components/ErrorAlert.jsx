import { useTranslation } from "react-i18next";
import { IconAlertTriangle } from "./Icons";
import { MAX_RETRY_ATTEMPTS } from "../hooks/useRetry";

/**
 * ErrorAlert — inline error banner with distinct UI for retryable and
 * non-retryable failures.
 *
 * Retryable (transient) errors:
 *   - Rendered with `alert-danger` styling.
 *   - Show a "Retry" button (bounded by MAX_RETRY_ATTEMPTS).
 *   - Show attempt counter ("Attempt 2 of 3") when more than one attempt has
 *     been made, so the user knows progress is being tracked.
 *   - After the last attempt the button is removed and a "max retries" message
 *     is shown instead.
 *
 * Non-retryable (permanent) errors:
 *   - Rendered with `alert-warning` styling and a visual "Permanent error"
 *     indicator, signalling that retrying is pointless.
 *   - No retry button.
 *
 * Props:
 *   retryState  - The `retryState` object from `useRetry`.
 *   onRetry     - Called when the user clicks "Retry".
 *   onDismiss   - Optional. Called when the user dismisses the alert.
 *   loading     - When true the retry button shows a spinner and is disabled.
 *   className   - Optional extra CSS class on the root element.
 *
 * @param {{
 *   retryState: import('../hooks/useRetry').RetryState,
 *   onRetry: () => void,
 *   onDismiss?: () => void,
 *   loading?: boolean,
 *   className?: string,
 * }} props
 */
export default function ErrorAlert({ retryState, onRetry, onDismiss, loading = false, className = "" }) {
  const { t } = useTranslation();

  if (!retryState?.error) return null;

  const { error, isRetryable, attempts, exhausted } = retryState;
  const showRetry   = isRetryable && !exhausted;
  // Permanent = non-retryable OR exhausted — both treated as permanent once
  // the user can no longer retry.
  const isPermanent = !isRetryable || exhausted;

  return (
    <div
      role="alert"
      className={`alert ${isPermanent ? "alert-warning" : "alert-danger"} ${className}`.trim()}
      style={{ display: "flex", alignItems: "flex-start", gap: "0.625rem", flexWrap: "wrap" }}
    >
      {/* Icon */}
      <IconAlertTriangle
        size={16}
        aria-hidden="true"
        style={{ flexShrink: 0, marginTop: "0.125rem" }}
      />

      {/* Message block */}
      <span style={{ flex: 1, minWidth: 0 }}>
        {/* Permanent / exhausted label */}
        {isPermanent && (
          <strong style={{ display: "block", marginBottom: "0.2rem", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {exhausted ? t("errors.MAX_RETRIES_EXCEEDED_LABEL", "Max retries reached") : t("errorAlert.permanentLabel", "Permanent error")}
          </strong>
        )}
        <span>{error}</span>

        {/* Attempt counter — only shown after the first failure and while
            retries remain so the user knows how many are left. */}
        {attempts > 1 && showRetry && (
          <span
            style={{ display: "block", fontSize: "0.72rem", marginTop: "0.2rem", color: "inherit", opacity: 0.75 }}
            aria-live="polite"
          >
            {t("errorAlert.attemptsCount", "Attempt {{attempts}} of {{max}}", {
              attempts,
              max: MAX_RETRY_ATTEMPTS,
            })}
          </span>
        )}
      </span>

      {/* Action buttons */}
      <div style={{ display: "flex", gap: "0.375rem", flexShrink: 0, alignItems: "center" }}>
        {showRetry && (
          <button
            onClick={onRetry}
            disabled={loading}
            className="btn btn-sm btn-ghost"
            style={{ color: "inherit", borderColor: "currentColor", opacity: loading ? 0.6 : 0.85 }}
            aria-label={t("errorAlert.retryAria", "Retry the failed request")}
          >
            {loading ? t("actions.loading") : t("actions.retry")}
          </button>
        )}

        {onDismiss && (
          <button
            onClick={onDismiss}
            className="btn btn-sm btn-ghost"
            style={{ color: "inherit", borderColor: "currentColor", opacity: 0.65 }}
            aria-label={t("errorAlert.dismissAria", "Dismiss error")}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
