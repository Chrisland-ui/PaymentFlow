import Head from "next/head";
import { useRef } from "react";
import PaymentForm from "../components/PaymentForm";
import VerifyPayment from "../components/VerifyPayment";
import SseDegradedBanner from "../components/SseDegradedBanner";
import NetworkStatusBanner from "../components/NetworkStatusBanner";
import { usePaymentEvents } from "../hooks/usePaymentEvents";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { useNetworkStatus } from "../hooks/useNetworkStatus";
import { useAdminAuthContext } from "../hooks/AdminAuthContext";
import { useTranslation } from "react-i18next";

export default function PayFees() {
  const { t } = useTranslation();
  const verifyPaymentRef = useRef(null);
  // #253 — pass the JWT expiry timestamp to PaymentForm so it can show a
  // session-expiry warning toast 5 minutes before the token expires.
  const { tokenExp } = useAdminAuthContext();

  const STEPS = [
    { n: "1", title: t("payFees.step1Title"), desc: t("payFees.step1Desc") },
    { n: "2", title: t("payFees.step2Title"), desc: t("payFees.step2Desc") },
    { n: "3", title: t("payFees.step3Title"), desc: t("payFees.step3Desc") },
  ];

  // SSE-level degraded/reconnecting/failed banner (Issues #1054, #1078).
  const { degraded, connectionStatus } = usePaymentEvents();
  // Track network connectivity to disable mutation actions while offline (Issue #269).
  const { isOnline } = useOnlineStatus();

  // Browser-level network connectivity (Issue #21).
  const { isOnline, wasOffline } = useNetworkStatus();

  const handleManualVerify = () => {
    verifyPaymentRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <>
      <Head><title>{t("nav.payFees")} | {t("app.name")}</title></Head>
      {/* SSE-level status — rendered first so it sits at the very top */}
      <SseDegradedBanner degraded={degraded} connectionStatus={connectionStatus} onManualVerify={handleManualVerify} />
      {/* OS/browser-level network status — rendered below SSE banner */}
      <NetworkStatusBanner isOnline={isOnline} wasOffline={wasOffline} />

      <div className="payfees-page">
        {/* Page header */}
        <div className="payfees-header">
          <span className="payfees-badge">
            <span className="payfees-badge-dot" />
            {t("payFees.liveOnStellar")}
          </span>
          <h1>{t("payFees.heroTitle")}</h1>
          <p>{t("payFees.heroDesc")}</p>
        </div>

        {/* How it works — inline steps */}
        <div className="payfees-steps">
          {STEPS.map(step => (
            <div key={step.n} className="payfees-step">
              <div className="payfees-step-num">{step.n}</div>
              <div className="payfees-step-text">
                <h3>{step.title}</h3>
                <p>{step.desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Main content grid */}
        <div className="payfees-grid">
          <PaymentForm disabled={!isOnline} />
          <div ref={verifyPaymentRef}>
            <VerifyPayment disabled={!isOnline} />
          </div>
        </div>
      </div>
    </>
  );
}
