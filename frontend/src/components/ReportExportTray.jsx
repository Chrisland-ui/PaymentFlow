import { useState } from "react";
import { useReportExport } from "../hooks/useReportExport";
import { IconX, IconDownload, IconCheck, IconAlertTriangle, IconBarChart } from "./Icons";

/**
 * ReportExportTray
 *
 * Persistent bottom-right tray that shows all in-progress and recently
 * completed report export jobs. Persists across navigation because the
 * ReportExportProvider lives at the app level (_app.jsx).
 *
 * Accessibility:
 *   - region landmark with aria-label
 *   - Live region announces completions
 *   - Full keyboard navigation (toggle, dismiss)
 *   - Progress bars have aria-valuenow / aria-valuemin / aria-valuemax
 *   - Colour is never the only differentiator (icon + text always present)
 */
export default function ReportExportTray() {
  const { jobs, dismissJob, dismissToast } = useReportExport();
  const [open, setOpen] = useState(true);

  if (jobs.length === 0) return null;

  const runningCount = jobs.filter((j) => j.status === "running").length;
  const doneCount    = jobs.filter((j) => j.status === "done").length;
  const errorCount   = jobs.filter((j) => j.status === "error").length;

  // Toast jobs that want to announce themselves
  const toastJobs = jobs.filter((j) => j.showToast);

  return (
    <>
      {/* Toast announcements — live region for screen readers */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="false"
        style={{ position: "fixed", width: 1, height: 1, overflow: "hidden", clip: "rect(0,0,0,0)" }}
      >
        {toastJobs.map((j) =>
          j.status === "done"
            ? `Report ready: ${j.label}. Download available in the reports tray.`
            : `Report failed: ${j.label}. ${j.error}`
        ).join(" ")}
      </div>

      {/* Visual toasts */}
      <div
        aria-live="polite"
        style={{
          position: "fixed",
          bottom: open ? "calc(320px + 1rem)" : "calc(52px + 1rem)",
          right: "1.5rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          zIndex: 1100,
          transition: "bottom 0.25s ease",
          maxWidth: "360px",
          width: "100%",
        }}
      >
        {toastJobs.map((j) => (
          <Toast key={j.id} job={j} onDismiss={() => dismissToast(j.id)} />
        ))}
      </div>

      {/* Tray */}
      <section
        aria-label="Report exports tray"
        style={{
          position: "fixed",
          bottom: "1.5rem",
          right: "1.5rem",
          width: "360px",
          zIndex: 1050,
          borderRadius: "var(--radius-md)",
          boxShadow: "var(--shadow-lg)",
          border: "1px solid var(--border)",
          background: "var(--card-bg)",
          overflow: "hidden",
        }}
      >
        {/* Tray header — click to collapse */}
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="report-tray-body"
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            padding: "0.625rem 0.875rem",
            background: "var(--sidebar-bg)",
            border: "none",
            cursor: "pointer",
            color: "#f1f5f9",
            textAlign: "left",
          }}
        >
          <IconBarChart size={14} />
          <span style={{ fontWeight: 600, fontSize: "0.825rem", flex: 1 }}>
            Reports
          </span>

          {/* Status badges */}
          {runningCount > 0 && (
            <span
              aria-label={`${runningCount} running`}
              style={{
                background: "var(--accent)",
                color: "#fff",
                borderRadius: "999px",
                padding: "0 0.4rem",
                fontSize: "0.7rem",
                fontWeight: 700,
                lineHeight: "18px",
              }}
            >
              {runningCount}
            </span>
          )}
          {errorCount > 0 && (
            <span
              aria-label={`${errorCount} failed`}
              style={{
                background: "var(--danger)",
                color: "#fff",
                borderRadius: "999px",
                padding: "0 0.4rem",
                fontSize: "0.7rem",
                fontWeight: 700,
                lineHeight: "18px",
              }}
            >
              {errorCount}
            </span>
          )}
          {doneCount > 0 && runningCount === 0 && errorCount === 0 && (
            <span
              aria-label={`${doneCount} ready`}
              style={{
                background: "var(--success)",
                color: "#fff",
                borderRadius: "999px",
                padding: "0 0.4rem",
                fontSize: "0.7rem",
                fontWeight: 700,
                lineHeight: "18px",
              }}
            >
              {doneCount}
            </span>
          )}

          <ChevronIcon open={open} />
        </button>

        {/* Tray body */}
        <div
          id="report-tray-body"
          hidden={!open}
          style={{
            maxHeight: "264px",
            overflowY: "auto",
          }}
        >
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} onDismiss={() => dismissJob(job.id)} />
          ))}
        </div>
      </section>
    </>
  );
}

/* ── Sub-components ─────────────────────────────────────────────────────── */

function JobRow({ job, onDismiss }) {
  const isRunning = job.status === "running";
  const isDone    = job.status === "done";
  const isError   = job.status === "error";

  return (
    <article
      aria-label={`${job.label} — ${statusLabel(job.status)}`}
      style={{
        padding: "0.75rem 0.875rem",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        gap: "0.375rem",
      }}
    >
      {/* Row header */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <StatusIcon status={job.status} />
        <span
          style={{
            flex: 1,
            fontSize: "0.8125rem",
            fontWeight: 500,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={job.label}
        >
          {job.label}
        </span>
        <button
          onClick={onDismiss}
          aria-label={`Dismiss ${job.label}`}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text-muted)",
            padding: "2px",
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          <IconX size={13} />
        </button>
      </div>

      {/* Progress bar */}
      {isRunning && (
        <ProgressBar
          value={job.indeterminate ? null : job.progress}
          label={job.label}
        />
      )}

      {/* Status message / action */}
      {isDone && job.blobUrl && (
        <a
          href={job.blobUrl}
          download={job.filename || "report.csv"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.3rem",
            fontSize: "0.775rem",
            color: "var(--accent)",
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          <IconDownload size={12} /> Download ready
        </a>
      )}
      {isDone && !job.blobUrl && (
        <span style={{ fontSize: "0.775rem", color: "var(--success-text)" }}>
          Completed {formatDuration(job.startedAt, job.completedAt)}
        </span>
      )}
      {isError && (
        <span style={{ fontSize: "0.775rem", color: "var(--danger-text)" }}>
          {job.error}
        </span>
      )}
    </article>
  );
}

function ProgressBar({ value, label }) {
  const isIndeterminate = value === null || value === undefined;

  return (
    <>
      <div
        role="progressbar"
        aria-valuenow={isIndeterminate ? undefined : value}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} export progress${isIndeterminate ? "" : `: ${value}%`}`}
        aria-valuetext={isIndeterminate ? "Processing…" : `${value}%`}
        style={{
          height: "4px",
          borderRadius: "999px",
          background: "var(--border)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            borderRadius: "999px",
            background: "var(--accent)",
            width: isIndeterminate ? "40%" : `${value}%`,
            transition: isIndeterminate ? "none" : "width 0.4s ease",
            animation: isIndeterminate ? "trayIndeterminate 1.4s ease-in-out infinite" : "none",
          }}
        />
      </div>
      {!isIndeterminate && (
        <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", textAlign: "right" }}>
          {value}%
        </span>
      )}
      <style>{`
        @keyframes trayIndeterminate {
          0%   { transform: translateX(-150%); }
          100% { transform: translateX(350%); }
        }
      `}</style>
    </>
  );
}

function StatusIcon({ status }) {
  if (status === "done") {
    return (
      <span
        aria-label="Complete"
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "var(--success-bg)",
          border: "1px solid var(--success-border)",
          color: "var(--success-text)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <IconCheck size={10} />
      </span>
    );
  }
  if (status === "error") {
    return (
      <span
        aria-label="Failed"
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "var(--danger-bg)",
          border: "1px solid var(--danger-border)",
          color: "var(--danger-text)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <IconAlertTriangle size={10} />
      </span>
    );
  }
  // running
  return (
    <span
      aria-label="In progress"
      style={{
        width: 18,
        height: 18,
        borderRadius: "50%",
        border: "2px solid var(--accent)",
        borderTopColor: "transparent",
        flexShrink: 0,
        animation: "traySpin 0.8s linear infinite",
      }}
    >
      <style>{`@keyframes traySpin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}

function Toast({ job, onDismiss }) {
  const isDone  = job.status === "done";
  const isError = job.status === "error";

  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        background: "var(--card-bg)",
        border: `1px solid ${isDone ? "var(--success-border)" : "var(--danger-border)"}`,
        borderRadius: "var(--radius)",
        boxShadow: "var(--shadow-md)",
        padding: "0.75rem 1rem",
        display: "flex",
        alignItems: "flex-start",
        gap: "0.625rem",
      }}
    >
      <span
        style={{ color: isDone ? "var(--success-text)" : "var(--danger-text)", flexShrink: 0 }}
        aria-hidden="true"
      >
        {isDone ? <IconCheck size={15} /> : <IconAlertTriangle size={15} />}
      </span>
      <div style={{ flex: 1 }}>
        <p style={{ margin: 0, fontSize: "0.8125rem", fontWeight: 600, color: "var(--text)" }}>
          {isDone ? "Download ready" : "Export failed"}
        </p>
        <p style={{ margin: "0.125rem 0 0", fontSize: "0.775rem", color: "var(--text-muted)" }}>
          {job.label}
        </p>
        {isDone && job.blobUrl && (
          <a
            href={job.blobUrl}
            download={job.filename || "report.csv"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.25rem",
              marginTop: "0.375rem",
              fontSize: "0.775rem",
              color: "var(--accent)",
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            <IconDownload size={12} /> Download CSV
          </a>
        )}
        {isError && (
          <p style={{ margin: "0.125rem 0 0", fontSize: "0.775rem", color: "var(--danger-text)" }}>
            {job.error}
          </p>
        )}
      </div>
      <button
        onClick={onDismiss}
        aria-label="Dismiss notification"
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--text-muted)",
          padding: "2px",
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        <IconX size={13} />
      </button>
    </div>
  );
}

function ChevronIcon({ open }) {
  return (
    <svg
      aria-hidden="true"
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s ease" }}
    >
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

function statusLabel(status) {
  if (status === "done")    return "Ready";
  if (status === "error")   return "Failed";
  return "Running";
}

function formatDuration(startedAt, completedAt) {
  if (!completedAt) return "";
  const secs = Math.round((completedAt - startedAt) / 1000);
  if (secs < 60) return `in ${secs}s`;
  return `in ${Math.round(secs / 60)}m`;
}
