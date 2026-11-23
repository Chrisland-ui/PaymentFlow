/**
 * OfflineBanner
 *
 * Renders a persistent status strip when the user loses internet connectivity.
 * Visually distinct from a server error (SSE degraded banner) — uses a
 * dark neutral colour scheme to indicate "no network" rather than a
 * backend-side problem.
 *
 * Issue #269 acceptance criteria:
 *   ✓ Offline banner appears within 1 second of losing connectivity.
 *   ✓ Banner disappears automatically on reconnect (handled by parent).
 *   ✓ Offline state is visually distinct from a server error state.
 *
 * Usage:
 *   <OfflineBanner />
 *
 * The component is self-contained — it consumes useOnlineStatus internally
 * so it can be dropped into any page without threading extra props.
 */
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { useTranslation } from "react-i18next";

function WifiOffIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
      <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
      <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
      <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </svg>
  );
}

export default function OfflineBanner() {
  const { isOnline } = useOnlineStatus();
  const { t } = useTranslation();

  if (isOnline) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      style={{
        padding: "0.5rem 1.5rem",
        textAlign: "center",
        fontWeight: 600,
        fontSize: "0.8rem",
        letterSpacing: "0.01em",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.55rem",
        borderBottom: "1px solid rgba(0,0,0,0.25)",
        zIndex: 1001,
        flexWrap: "wrap",
        // Visually distinct from SseDegradedBanner (dark server-error colours).
        // Offline uses a cooler slate/indigo palette so users can tell the
        // difference at a glance.
        background: "#0f172a",
        color: "#cbd5e1",
      }}
    >
      <WifiOffIcon />
      <span>{t("offlineBanner.message")}</span>
      <span
        style={{
          fontSize: "0.72rem",
          fontWeight: 400,
          opacity: 0.75,
        }}
      >
        {t("offlineBanner.submsg")}
      </span>
    </div>
  );
}
