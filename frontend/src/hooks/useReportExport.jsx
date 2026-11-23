import { createContext, useCallback, useContext, useRef, useState } from "react";

/**
 * ReportExportContext
 *
 * Provides a global store of in-progress and recently completed report export
 * jobs. The tray reads from this context so it persists across navigation.
 *
 * Usage:
 *   const { addJob, completeJob, failJob, dismissJob, jobs } = useReportExport();
 *
 * Job shape:
 *   {
 *     id:        string    — unique job ID (Date.now + random)
 *     label:     string    — human-readable description e.g. "Report 2024-01-01 → 2024-03-31"
 *     status:    'running' | 'done' | 'error'
 *     progress:  number    — 0–100 (indeterminate shows as animated bar)
 *     indeterminate: bool  — true while no % available from server
 *     blobUrl:   string?   — download URL once complete
 *     filename:  string?   — suggested download filename
 *     error:     string?   — error message if status === 'error'
 *     startedAt: number    — Date.now()
 *     completedAt: number? — Date.now() when done/error
 *   }
 */
export const ReportExportContext = createContext(null);

export function ReportExportProvider({ children }) {
  const [jobs, setJobs] = useState([]);
  const toastTimers = useRef({});

  const addJob = useCallback(({ id, label }) => {
    const job = {
      id: id || `report-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      label: label || "Report export",
      status: "running",
      progress: 0,
      indeterminate: true,
      blobUrl: null,
      filename: null,
      error: null,
      startedAt: Date.now(),
      completedAt: null,
      showToast: false,
    };
    setJobs((prev) => [job, ...prev]);
    return job.id;
  }, []);

  const updateProgress = useCallback((id, progress) => {
    setJobs((prev) =>
      prev.map((j) =>
        j.id === id
          ? { ...j, progress, indeterminate: progress === null || progress === undefined }
          : j
      )
    );
  }, []);

  const completeJob = useCallback(({ id, blobUrl, filename }) => {
    setJobs((prev) =>
      prev.map((j) =>
        j.id === id
          ? {
              ...j,
              status: "done",
              progress: 100,
              indeterminate: false,
              blobUrl,
              filename,
              completedAt: Date.now(),
              showToast: true,
            }
          : j
      )
    );

    // Auto-dismiss toast after 8 s
    toastTimers.current[id] = setTimeout(() => {
      setJobs((prev) =>
        prev.map((j) => (j.id === id ? { ...j, showToast: false } : j))
      );
    }, 8000);
  }, []);

  const failJob = useCallback(({ id, error }) => {
    setJobs((prev) =>
      prev.map((j) =>
        j.id === id
          ? {
              ...j,
              status: "error",
              indeterminate: false,
              error: error || "Export failed",
              completedAt: Date.now(),
              showToast: true,
            }
          : j
      )
    );

    toastTimers.current[id] = setTimeout(() => {
      setJobs((prev) =>
        prev.map((j) => (j.id === id ? { ...j, showToast: false } : j))
      );
    }, 8000);
  }, []);

  const dismissJob = useCallback((id) => {
    clearTimeout(toastTimers.current[id]);
    setJobs((prev) => prev.filter((j) => j.id !== id));
  }, []);

  const dismissToast = useCallback((id) => {
    clearTimeout(toastTimers.current[id]);
    setJobs((prev) =>
      prev.map((j) => (j.id === id ? { ...j, showToast: false } : j))
    );
  }, []);

  return (
    <ReportExportContext.Provider
      value={{ jobs, addJob, updateProgress, completeJob, failJob, dismissJob, dismissToast }}
    >
      {children}
    </ReportExportContext.Provider>
  );
}

export function useReportExport() {
  const ctx = useContext(ReportExportContext);
  if (!ctx) {
    throw new Error("useReportExport must be used inside <ReportExportProvider>");
  }
  return ctx;
}
