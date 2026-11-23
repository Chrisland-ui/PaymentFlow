import { useCallback, useEffect, useState } from "react";
import api from "../services/api";
import RequireAdmin from "../components/RequireAdmin";
import PageHero from "../components/PageHero";
import { IconRefreshCw, IconShield, IconAlertTriangle } from "../components/Icons";

function RetentionPage() {
  const [report, setReport] = useState(null);
  const [certificates, setCertificates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  const loadOperations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [previewResponse, certificateResponse] = await Promise.all([
        api.get("/admin/retention/preview"),
        api.get("/admin/retention/certificates", { params: { limit: 50 } }),
      ]);
      setReport(previewResponse.data);
      setCertificates(certificateResponse.data.certificates || []);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || "Could not load retention activity.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadOperations(); }, [loadOperations]);

  const runRetention = async (dryRun) => {
    if (!dryRun && !window.confirm("Permanently purge or anonymize eligible records? This action cannot be undone.")) return;
    setRunning(true);
    setError(null);
    try {
      const response = await api.post("/admin/retention/run", { dryRun });
      setReport(response.data);
      const certificateResponse = await api.get("/admin/retention/certificates", { params: { limit: 50 } });
      setCertificates(certificateResponse.data.certificates || []);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || "Retention run failed.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <RequireAdmin>
      <div className="retention-page">
        <PageHero
          eyebrow="Operations"
          title="Data retention"
          subtitle="Review eligible records, run a dry-run report, and inspect immutable purge certificates."
        />

        <section className="retention-actions" aria-label="Retention actions">
          <div>
            <h2>Retention preview</h2>
            <p>Automatic purging is controlled by DATA_RETENTION_AUTO_PURGE. Manual execution always requires confirmation.</p>
          </div>
          <div className="retention-buttons">
            <button type="button" onClick={() => loadOperations()} disabled={loading || running} title="Refresh preview">
              <IconRefreshCw size={16} /> Refresh
            </button>
            <button type="button" onClick={() => runRetention(true)} disabled={running}>
              <IconShield size={16} /> Dry run
            </button>
            <button type="button" className="retention-danger" onClick={() => runRetention(false)} disabled={running}>
              <IconAlertTriangle size={16} /> {running ? "Running..." : "Run purge"}
            </button>
          </div>
        </section>

        {error && <div className="retention-error" role="alert">{error}</div>}
        {report && (
          <section className="retention-results" aria-live="polite">
            <div className="retention-summary">
              <span>{report.dryRun ? "Dry run" : "Executed"}</span>
              <strong>{report.totals?.candidates ?? 0} eligible</strong>
              <strong>{report.totals?.deleted ?? 0} changed</strong>
              <time>{new Date(report.executedAt).toLocaleString()}</time>
            </div>
            <div className="retention-scope-list">
              {Object.entries(report.scopes || {}).map(([scope, result]) => (
                <div className="retention-scope" key={scope}>
                  <div><strong>{scope}</strong><small>{result.retentionDays} days</small></div>
                  <span>{result.error || `${result.candidates ?? 0} eligible`}</span>
                  <span>{result.deleted ?? 0} changed</span>
                </div>
              ))}
              {loading && <p>Loading retention preview...</p>}
            </div>
          </section>
        )}

        <section className="retention-certificates">
          <div className="retention-section-heading">
            <h2>Recent purge certificates</h2>
            <span>{certificates.length} records</span>
          </div>
          <div className="retention-table-wrap">
            <table>
              <thead><tr><th>Category</th><th>Record</th><th>School</th><th>Purged at</th><th>Performed by</th></tr></thead>
              <tbody>
                {certificates.map((certificate) => (
                  <tr key={certificate._id}>
                    <td>{certificate.category}</td>
                    <td><code>{certificate.recordId}</code></td>
                    <td>{certificate.schoolId || "System"}</td>
                    <td>{new Date(certificate.purgedAt).toLocaleString()}</td>
                    <td>{certificate.performedBy}</td>
                  </tr>
                ))}
                {!certificates.length && <tr><td colSpan="5">{loading ? "Loading certificates..." : "No purge certificates yet."}</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <style jsx>{`
          .retention-page { max-width: 1180px; margin: 0 auto; padding: 0 1.5rem 3rem; }
          .retention-actions, .retention-results, .retention-certificates { border-top: 1px solid var(--border); padding: 1.25rem 0; }
          .retention-actions { display: flex; align-items: center; justify-content: space-between; gap: 1.5rem; flex-wrap: wrap; }
          h2 { margin: 0; font-size: 1.05rem; }
          p { margin: .45rem 0 0; color: var(--text-muted); font-size: .875rem; }
          .retention-buttons { display: flex; flex-wrap: wrap; gap: .5rem; }
          button { display: inline-flex; align-items: center; gap: .45rem; border: 1px solid var(--border); border-radius: 6px; padding: .55rem .8rem; background: var(--card-bg); color: var(--text); font: inherit; cursor: pointer; }
          button:disabled { opacity: .55; cursor: not-allowed; }
          .retention-danger { border-color: #b42318; color: #b42318; }
          .retention-error { margin: 1rem 0; padding: .75rem 1rem; border-left: 3px solid #b42318; background: rgba(180,35,24,.08); color: var(--text); }
          .retention-summary { display: flex; gap: 1.25rem; align-items: center; flex-wrap: wrap; padding-bottom: 1rem; }
          .retention-summary span { text-transform: uppercase; font-size: .72rem; font-weight: 700; color: var(--text-muted); }
          .retention-summary time { margin-left: auto; color: var(--text-muted); font-size: .8rem; }
          .retention-scope { display: grid; grid-template-columns: minmax(160px, 1fr) auto auto; gap: 1rem; align-items: center; border-top: 1px solid var(--border); padding: .7rem 0; font-size: .875rem; }
          .retention-scope div { display: flex; gap: .6rem; align-items: baseline; }
          .retention-scope small, .retention-section-heading span { color: var(--text-muted); }
          .retention-section-heading { display: flex; align-items: baseline; justify-content: space-between; padding-bottom: .8rem; }
          .retention-table-wrap { overflow-x: auto; }
          table { width: 100%; border-collapse: collapse; font-size: .82rem; text-align: left; }
          th, td { padding: .65rem .55rem; border-top: 1px solid var(--border); white-space: nowrap; }
          th { color: var(--text-muted); font-size: .7rem; text-transform: uppercase; }
          code { font-size: .75rem; }
          @media (max-width: 640px) { .retention-page { padding-left: 1rem; padding-right: 1rem; } .retention-summary time { margin-left: 0; width: 100%; } .retention-scope { grid-template-columns: 1fr auto; } .retention-scope div { grid-column: 1 / -1; } }
        `}</style>
      </div>
    </RequireAdmin>
  );
}

export default RetentionPage;
