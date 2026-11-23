/**
 * 403 Forbidden page — Issue #357
 *
 * Shown when a user deep-links to a route their role cannot access.
 * Provides a "Request access" CTA and a back-to-safety link.
 */

import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAdminAuthContext } from "../hooks/AdminAuthContext";
import { IconShield, IconAlertTriangle, IconCheck } from "../components/Icons";

export default function ForbiddenPage() {
  const { t }        = useTranslation();
  const router       = useRouter();
  const { isAdmin, checked } = useAdminAuthContext();

  const [showRequest, setShowRequest]   = useState(false);
  const [requestNote, setRequestNote]   = useState("");
  const [submitted, setSubmitted]       = useState(false);

  // The route the user was trying to reach
  const attemptedPath = router.query.from || router.asPath;

  function handleRequestSubmit(e) {
    e.preventDefault();
    // In a real implementation this would POST to an access-request endpoint.
    // For now we just mark it as submitted.
    setSubmitted(true);
  }

  return (
    <>
      <Head>
        <title>Access Denied | StellarEduPay</title>
      </Head>
      <style>{`
        .forbidden-wrap {
          min-height: calc(100vh - 64px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 2rem 1rem;
        }
        .forbidden-card {
          background: var(--card-bg);
          border: 1px solid var(--border);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-md);
          padding: 2.5rem 2rem;
          max-width: 480px;
          width: 100%;
          text-align: center;
        }
        .forbidden-icon-wrap {
          width: 64px;
          height: 64px;
          border-radius: 50%;
          background: var(--danger-bg);
          border: 1px solid var(--danger-border);
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 0 auto 1.25rem;
          color: var(--danger-text);
        }
        .forbidden-code {
          font-size: 3rem;
          font-weight: 900;
          color: var(--danger-text);
          line-height: 1;
          margin-bottom: 0.5rem;
          letter-spacing: -0.03em;
        }
        .forbidden-title {
          font-size: 1.25rem;
          font-weight: 700;
          color: var(--text);
          margin-bottom: 0.5rem;
        }
        .forbidden-desc {
          font-size: 0.875rem;
          color: var(--text-muted);
          line-height: 1.6;
          margin-bottom: 1.5rem;
        }
        .forbidden-actions {
          display: flex;
          gap: 0.75rem;
          justify-content: center;
          flex-wrap: wrap;
          margin-bottom: 1rem;
        }
        .forbidden-request-form {
          margin-top: 1.5rem;
          text-align: left;
          border-top: 1px solid var(--border);
          padding-top: 1.25rem;
        }
        .forbidden-request-title {
          font-size: 0.875rem;
          font-weight: 600;
          color: var(--text);
          margin-bottom: 0.5rem;
        }
        @media (max-width: 375px) {
          .forbidden-card { padding: 1.5rem 1rem; }
          .forbidden-actions { flex-direction: column; align-items: center; }
        }
      `}</style>

      <div className="forbidden-wrap">
        <div className="forbidden-card" role="main">
          <div className="forbidden-icon-wrap" aria-hidden="true">
            <IconShield size={28} />
          </div>

          <div className="forbidden-code" aria-label="Error 403">403</div>
          <div className="forbidden-title">{t("forbidden.title", { defaultValue: "Access Denied" })}</div>
          <div className="forbidden-desc">
            {t("forbidden.description", {
              defaultValue: "You don't have permission to access this section. If you believe this is a mistake, you can request access below.",
            })}
          </div>

          {/* Role context — help user understand why */}
          <div style={{
            padding: "0.625rem 0.875rem",
            background: "var(--warning-bg)",
            border: "1px solid var(--warning-border)",
            borderRadius: "var(--radius-sm)",
            fontSize: "0.8125rem",
            color: "var(--warning-text)",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            marginBottom: "1.25rem",
            textAlign: "left",
          }}>
            <IconAlertTriangle size={13} />
            {checked && !isAdmin
              ? t("forbidden.roleNote", { defaultValue: "This section requires admin access. You are currently logged in as a non-admin user." })
              : t("forbidden.loginNote", { defaultValue: "Please log in with an account that has the required permissions." })
            }
          </div>

          <div className="forbidden-actions">
            <button
              type="button"
              onClick={() => router.back()}
              style={{
                padding: "0.5rem 1.125rem",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                background: "var(--bg)",
                color: "var(--text)",
                fontSize: "0.875rem",
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {t("forbidden.goBack", { defaultValue: "← Go Back" })}
            </button>

            <Link href="/dashboard" style={{
              padding: "0.5rem 1.125rem",
              border: "none",
              borderRadius: "var(--radius-sm)",
              background: "var(--accent)",
              color: "#fff",
              fontSize: "0.875rem",
              fontWeight: 600,
              textDecoration: "none",
              display: "inline-block",
            }}>
              {t("forbidden.toDashboard", { defaultValue: "Go to Dashboard" })}
            </Link>

            {!submitted && (
              <button
                type="button"
                onClick={() => setShowRequest(r => !r)}
                style={{
                  padding: "0.5rem 1.125rem",
                  border: "1px solid var(--border-strong)",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--bg-subtle)",
                  color: "var(--text-muted)",
                  fontSize: "0.875rem",
                  fontWeight: 500,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {t("forbidden.requestAccess", { defaultValue: "Request Access" })}
              </button>
            )}
          </div>

          {/* Request access form */}
          {showRequest && !submitted && (
            <div className="forbidden-request-form">
              <div className="forbidden-request-title">
                {t("forbidden.requestFormTitle", { defaultValue: "Request Access" })}
              </div>
              <form onSubmit={handleRequestSubmit}>
                <label style={{ display: "block", fontSize: "0.8125rem", color: "var(--text-muted)", marginBottom: "0.375rem" }}>
                  {t("forbidden.requestFormLabel", { defaultValue: "Briefly describe why you need access to this section:" })}
                </label>
                <textarea
                  value={requestNote}
                  onChange={e => setRequestNote(e.target.value)}
                  placeholder={t("forbidden.requestFormPlaceholder", { defaultValue: "e.g. I need to review refund requests as part of the finance team." })}
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
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "0.75rem" }}>
                  {t("forbidden.requestedPage", { defaultValue: "Requested page" })}: <code style={{ fontFamily: "monospace" }}>{attemptedPath}</code>
                </div>
                <button
                  type="submit"
                  disabled={!requestNote.trim()}
                  style={{
                    padding: "0.5rem 1rem",
                    background: "var(--accent)",
                    color: "#fff",
                    border: "none",
                    borderRadius: "var(--radius-sm)",
                    fontSize: "0.875rem",
                    fontWeight: 600,
                    cursor: !requestNote.trim() ? "not-allowed" : "pointer",
                    opacity: !requestNote.trim() ? 0.5 : 1,
                    fontFamily: "inherit",
                  }}
                >
                  {t("forbidden.submitRequest", { defaultValue: "Send Request" })}
                </button>
              </form>
            </div>
          )}

          {submitted && (
            <div style={{
              marginTop: "1.25rem",
              padding: "0.75rem 1rem",
              background: "var(--success-bg)",
              border: "1px solid var(--success-border)",
              borderRadius: "var(--radius-sm)",
              color: "var(--success-text)",
              fontSize: "0.875rem",
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
            }}>
              <IconCheck size={15} />
              {t("forbidden.requestSent", { defaultValue: "Your access request has been sent to the administrator." })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
