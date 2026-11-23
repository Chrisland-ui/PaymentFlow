import { useCallback, useEffect, useState } from "react";
import api from "../services/api";
import RequireAdmin from "../components/RequireAdmin";
import PageHero from "../components/PageHero";
import { IconRefreshCw, IconAlertTriangle } from "../components/Icons";

function DeadLetterPage() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [replaying, setReplaying] = useState(null);

  const loadJobs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get("/admin/retry-queue/dlq", { params: { limit: 100 } });
      setJobs(response.data.jobs || []);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || "Could not load dead-letter jobs.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  const replay = async (job) => {
    setReplaying(job.jobId);
    setError(null);
    try {
      const path = ["transaction-processing", "report-generation"].includes(job.originalQueue)
        ? `/admin/retry-queue/dlq/${encodeURIComponent(job.originalQueue)}/${encodeURIComponent(job.jobId)}/replay`
        : `/admin/retry-queue/dlq/${encodeURIComponent(job.jobId)}/replay`;
      await api.post(path);
      await loadJobs();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || "Could not requeue the job.");
    } finally {
      setReplaying(null);
    }
  };

  return (
    <RequireAdmin>
      <main className="dlq-page">
        <PageHero eyebrow="Operations" title="Dead-letter queue" subtitle="Inspect exhausted payment jobs and replay recoverable work." />
        <section className="dlq-toolbar">
          <div><strong>{jobs.length}</strong><span> retained jobs</span></div>
          <button type="button" onClick={loadJobs} disabled={loading || Boolean(replaying)} title="Refresh dead-letter jobs">
            <IconRefreshCw size={16} /> Refresh
          </button>
        </section>
        {error && <div role="alert" className="dlq-error">{error}</div>}
        <div className="dlq-table-wrap">
          <table>
            <thead><tr><th>Failed</th><th>Transaction</th><th>Reason</th><th>Attempts</th><th>Correlation</th><th /></tr></thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={`${job.originalQueue || "retry"}:${job.jobId}`}>
                  <td>{job.failedAt ? new Date(job.failedAt).toLocaleString() : "Unknown"}</td>
                  <td><code>{job.transactionHash || job.originalJobId}</code></td>
                  <td className="dlq-reason">
                    {job.failureReason || "No failure reason recorded"}
                    <details><summary>Payload and attempts</summary><pre>{JSON.stringify(job.originalData || job.safePayload || job.attemptHistory || {}, null, 2)}</pre></details>
                  </td>
                  <td>{job.failedAttempts ?? "-"}</td>
                  <td><code>{job.correlationId || "-"}</code></td>
                  <td><button type="button" onClick={() => replay(job)} disabled={Boolean(replaying)} title="Requeue this job at the head of the retry queue">
                    <IconAlertTriangle size={14} /> {replaying === job.jobId ? "Requeuing..." : "Requeue"}
                  </button></td>
                </tr>
              ))}
              {!jobs.length && <tr><td colSpan="6">{loading ? "Loading dead-letter jobs..." : "No dead-letter jobs."}</td></tr>}
            </tbody>
          </table>
        </div>
        <style jsx>{`
          .dlq-page { max-width: 1180px; margin: 0 auto; padding: 0 1.5rem 3rem; }
          .dlq-toolbar { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border); padding: 1rem 0; }
          .dlq-toolbar span { color: var(--text-muted); }
          button { display: inline-flex; align-items: center; gap: .4rem; border: 1px solid var(--border); border-radius: 6px; padding: .5rem .7rem; color: var(--text); background: var(--card-bg); font: inherit; cursor: pointer; }
          button:disabled { opacity: .55; cursor: not-allowed; }
          .dlq-error { border-left: 3px solid #b42318; padding: .7rem 1rem; margin-bottom: 1rem; color: var(--text); background: rgba(180,35,24,.08); }
          .dlq-table-wrap { overflow-x: auto; border-top: 1px solid var(--border); }
          table { width: 100%; border-collapse: collapse; text-align: left; font-size: .82rem; }
          th, td { padding: .7rem .55rem; border-bottom: 1px solid var(--border); vertical-align: top; white-space: nowrap; }
          th { color: var(--text-muted); text-transform: uppercase; font-size: .7rem; }
          code { font-size: .74rem; }
          .dlq-reason { max-width: 320px; white-space: normal; }
          @media (max-width: 640px) { .dlq-page { padding-left: 1rem; padding-right: 1rem; } }
        `}</style>
      </main>
    </RequireAdmin>
  );
}

export default DeadLetterPage;
