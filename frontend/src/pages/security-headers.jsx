/**
 * /security-headers — Frontend security-headers diagnostic page.
 *
 * NON-PRODUCTION ONLY. This page is intentionally blocked in production
 * (see getServerSideProps below) so that header configuration details are
 * never exposed to end-users on a live deployment.
 *
 * What it does
 * ─────────────
 * The page issues a HEAD request to itself (via the Next.js dev-server or
 * standalone server) to read the response headers that the server actually
 * sends, then renders a pass/fail table for each required security header.
 * Because Next.js sets headers via next.config.js → headers(), this verifies
 * the *deployed* policy, not just the source-code definition.
 *
 * Checked headers
 * ───────────────
 *  • Content-Security-Policy  — must be present and contain key directives
 *  • X-Frame-Options           — must equal DENY
 *  • X-Content-Type-Options    — must equal nosniff
 *  • Referrer-Policy           — must be strict-origin-when-cross-origin
 *
 * Acceptance criteria (issue #19)
 * ─────────────────────────────────
 *  ✓ Reports missing or conflicting headers
 *  ✓ Production diagnostics do not expose secrets
 *  ✓ CI can validate the configured policy (via tests/security-headers-page.test.js)
 */

import { useState, useEffect } from "react";

// ── Header checks ─────────────────────────────────────────────────────────────

/**
 * Returns { pass, detail } for a single header value.
 * `value` is null when the header is absent.
 */
function checkHeader(name, value) {
  if (value === null) {
    return { pass: false, detail: "Header is missing" };
  }

  switch (name.toLowerCase()) {
    case "strict-transport-security": {
      const maxAge = Number(value.match(/max-age=(\d+)/i)?.[1] || 0);
      if (maxAge < 31536000 || !/includesubdomains/i.test(value)) {
        return { pass: false, detail: "Expected max-age of at least one year and includeSubDomains" };
      }
      return { pass: true, detail: value };
    }

    case "content-security-policy": {
      const required = [
        "default-src",
        "script-src",
        "frame-ancestors",
        "object-src",
      ];
      const missing = required.filter(
        (d) => !value.toLowerCase().includes(d)
      );
      if (missing.length > 0) {
        return {
          pass: false,
          detail: `Missing directives: ${missing.join(", ")}`,
        };
      }
      // unsafe-eval in script-src is only acceptable during development
      // (Next.js HMR). Flag it as a warning — the page still passes but
      // callers should be aware.
      if (value.includes("'unsafe-eval'")) {
        return {
          pass: true,
          detail:
            "Present — note: 'unsafe-eval' in script-src (expected in dev only)",
        };
      }
      return { pass: true, detail: "Present — all required directives found" };
    }

    case "x-frame-options":
      if (value.toUpperCase() !== "DENY") {
        return { pass: false, detail: `Expected DENY, got "${value}"` };
      }
      return { pass: true, detail: "DENY" };

    case "x-content-type-options":
      if (value.toLowerCase() !== "nosniff") {
        return { pass: false, detail: `Expected nosniff, got "${value}"` };
      }
      return { pass: true, detail: "nosniff" };

    case "referrer-policy":
      if (value.toLowerCase() !== "strict-origin-when-cross-origin") {
        return {
          pass: false,
          detail: `Expected strict-origin-when-cross-origin, got "${value}"`,
        };
      }
      return { pass: true, detail: "strict-origin-when-cross-origin" };

    default:
      return { pass: true, detail: value };
  }
}

// Headers to audit, in display order.
const AUDITED_HEADERS = [
  "Content-Security-Policy",
  "Strict-Transport-Security",
  "X-Frame-Options",
  "X-Content-Type-Options",
  "Referrer-Policy",
];

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Fetch the actual response headers from the current origin and evaluate them.
 */
async function fetchHeaderAudit() {
  // HEAD request to root — same origin, so the Next.js security headers are
  // applied. We read them from the response headers object.
  const res = await fetch("/", { method: "HEAD" });

  return AUDITED_HEADERS.map((name) => {
    const value = res.headers.get(name);
    const { pass, detail } = checkHeader(name, value);
    return { name, value, pass, detail };
  });
}

export default function SecurityHeadersPage({ isProduction }) {
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(null);

  // Run audit automatically on page load (non-production only).
  useEffect(() => {
    if (isProduction) return;
    runAudit();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function runAudit() {
    setLoading(true);
    setFetchError(null);
    try {
      const data = await fetchHeaderAudit();
      setResults(data);
    } catch (err) {
      setFetchError(err?.message || "Failed to fetch headers");
    } finally {
      setLoading(false);
    }
  }

  // ── Production gate ───────────────────────────────────────────────────────
  if (isProduction) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.heading}>Security Headers Diagnostic</h1>
          <p style={{ color: "var(--danger-text, #be123c)", marginTop: "1rem" }}>
            This diagnostic page is only available in non-production
            environments.
          </p>
        </div>
      </div>
    );
  }

  // ── Audit UI ──────────────────────────────────────────────────────────────
  const allPass =
    results !== null && results.every((r) => r.pass);
  const failCount = results ? results.filter((r) => !r.pass).length : 0;

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.heading}>Security Headers Diagnostic</h1>
        <p style={styles.subtext}>
          Audits the HTTP response headers actually served by this origin
          against expected security policies. Non-production only.
        </p>

        <button
          onClick={runAudit}
          disabled={loading}
          style={styles.button}
          aria-label="Re-run header audit"
        >
          {loading ? "Checking…" : "Run Audit"}
        </button>

        {fetchError && (
          <div role="alert" style={styles.errorBanner}>
            <strong>Error:</strong> {fetchError}
          </div>
        )}

        {results && !loading && (
          <>
            <div
              role="status"
              style={{
                ...styles.summary,
                background: allPass
                  ? "var(--success-bg, #ecfdf5)"
                  : "var(--danger-bg, #fff1f2)",
                color: allPass
                  ? "var(--success-text, #047857)"
                  : "var(--danger-text, #be123c)",
                border: `1px solid ${
                  allPass
                    ? "var(--success-border, #a7f3d0)"
                    : "var(--danger-border, #fecdd3)"
                }`,
              }}
            >
              {allPass
                ? "✓ All required security headers are present and correctly configured."
                : `✗ ${failCount} header check(s) failed. See details below.`}
            </div>

            <table
              style={styles.table}
              aria-label="Security header audit results"
            >
              <thead>
                <tr>
                  <th style={styles.th}>Header</th>
                  <th style={styles.th}>Status</th>
                  <th style={styles.th}>Details</th>
                </tr>
              </thead>
              <tbody>
                {results.map((row) => (
                  <tr key={row.name}>
                    <td style={styles.td}>
                      <code style={styles.code}>{row.name}</code>
                    </td>
                    <td
                      style={{
                        ...styles.td,
                        color: row.pass
                          ? "var(--success-text, #047857)"
                          : "var(--danger-text, #be123c)",
                        fontWeight: 600,
                      }}
                      aria-label={row.pass ? "Pass" : "Fail"}
                    >
                      {row.pass ? "✓ Pass" : "✗ Fail"}
                    </td>
                    <td style={styles.td}>{row.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

// ── Server-side props — blocks page in production ─────────────────────────────

export function getServerSideProps({ req }) {
  const isProduction = process.env.NODE_ENV === "production";

  // Return a 404 in production so the page never appears in crawlers or
  // error logs — diagnostic details must not reach end-users.
  if (isProduction) {
    return { notFound: true };
  }

  return {
    props: {
      isProduction: false,
    },
  };
}

// ── Inline styles (avoids dependency on global CSS) ───────────────────────────

const styles = {
  page: {
    minHeight: "100vh",
    padding: "2rem 1rem",
    fontFamily: "Inter, system-ui, sans-serif",
  },
  card: {
    maxWidth: "860px",
    margin: "0 auto",
    background: "var(--card-bg, #fff)",
    borderRadius: "12px",
    padding: "2rem",
    boxShadow: "var(--shadow, 0 2px 8px rgba(16,24,64,0.07))",
  },
  heading: {
    fontSize: "1.5rem",
    fontWeight: 700,
    color: "var(--text, #0f172a)",
    margin: 0,
  },
  subtext: {
    marginTop: "0.5rem",
    color: "var(--text-muted, #64748b)",
    fontSize: "0.9375rem",
  },
  button: {
    marginTop: "1.25rem",
    padding: "0.5rem 1.25rem",
    borderRadius: "8px",
    border: "none",
    background: "var(--accent, #059669)",
    color: "#fff",
    fontWeight: 600,
    fontSize: "0.9rem",
    cursor: "pointer",
    display: "inline-block",
  },
  errorBanner: {
    marginTop: "1rem",
    padding: "0.75rem 1rem",
    background: "var(--danger-bg, #fff1f2)",
    color: "var(--danger-text, #be123c)",
    borderRadius: "8px",
    border: "1px solid var(--danger-border, #fecdd3)",
  },
  summary: {
    marginTop: "1.25rem",
    padding: "0.75rem 1rem",
    borderRadius: "8px",
    fontWeight: 500,
  },
  table: {
    marginTop: "1.25rem",
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "0.9rem",
  },
  th: {
    textAlign: "left",
    padding: "0.6rem 0.75rem",
    borderBottom: "2px solid var(--border, #e7e9f3)",
    fontWeight: 600,
    color: "var(--text-muted, #64748b)",
    fontSize: "0.8125rem",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  td: {
    padding: "0.65rem 0.75rem",
    borderBottom: "1px solid var(--border, #e7e9f3)",
    verticalAlign: "top",
    color: "var(--text, #0f172a)",
    fontSize: "0.875rem",
  },
  code: {
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
    fontSize: "0.8125rem",
    background: "var(--bg-subtle, #eef1f8)",
    padding: "0.1rem 0.35rem",
    borderRadius: "4px",
  },
};
