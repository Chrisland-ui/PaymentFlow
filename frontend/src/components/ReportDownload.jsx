import { useState, useEffect, useRef } from "react";
import { getReport } from "../services/api";
import { getReportCsvUrl } from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import { downloadFile } from "../utils/downloadBlob";
import {
  IconCalendar, IconDownload, IconBarChart, IconAlertTriangle,
  IconCheck, IconTrendingUp, IconClock, IconX,
} from "./Icons";
import PageHero, { StatCard } from "./PageHero";
import DateRangePicker from "./DateRangePicker";
import { useTranslation } from "react-i18next";
import { useReportExport } from "../hooks/useReportExport";

export default function ReportDownload() {
  const { t } = useTranslation();
  const { addJob, updateProgress, completeJob, failJob } = useReportExport();
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate]     = useState("");
  const [className, setClassName] = useState("");
  const [studentId, setStudentId] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("");
  const [report, setReport]       = useState(null);
  const [error, setError]         = useState("");
  const [errorRetryable, setErrorRetryable] = useState(false);
  const [errorOperation, setErrorOperation] = useState(null);
  const [loading, setLoading]     = useState(false);
  const [csvLoading, setCsvLoading] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState("");
  const [reportHistory, setReportHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const downloadAbortRef = useRef(null);

  useEffect(() => {
    loadReportHistory();
  }, []);

  async function loadReportHistory() {
    try {
      const storedHistory = localStorage.getItem("reportHistory");
      if (storedHistory) {
        setReportHistory(JSON.parse(storedHistory));
      }
    } catch (err) {
      console.error("Failed to load report history:", err);
    }
  }

  function saveReportToHistory(reportData, params) {
    const newEntry = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      params,
      summary: {
        totalAmount: reportData.summary.totalAmount,
        paymentCount: reportData.summary.paymentCount,
      },
    };
    const updated = [newEntry, ...reportHistory.slice(0, 9)];
    setReportHistory(updated);
    localStorage.setItem("reportHistory", JSON.stringify(updated));
  }

  async function handleGenerate(e) {
    e?.preventDefault();
    setError(""); setReport(null); setLoading(true);
    setErrorRetryable(false);
    setErrorOperation(null);
    try {
      const params = {};
      if (startDate) params.startDate = startDate;
      if (endDate)   params.endDate   = endDate;
      if (className) params.className = className;
      if (studentId) params.studentId = studentId;
      if (paymentStatus) params.paymentStatus = paymentStatus;
      const { data } = await getReport(params);
      setReport(data);
      saveReportToHistory(data, params);
    } catch (err) {
      setErrorRetryable(isRetryable(err));
      setErrorOperation("report");
      setError(
        getErrorMessage(err.response?.data?.code, err.response?.data?.error) ||
        t("reports.failedGenerate")
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleCsv() {
    const params = {};
    if (startDate) params.startDate = startDate;
    if (endDate)   params.endDate   = endDate;
    if (className) params.className = className;
    if (studentId) params.studentId = studentId;
    if (paymentStatus) params.paymentStatus = paymentStatus;

    // Build a human-readable label for the tray job
    const label = startDate && endDate
      ? `Report ${startDate} → ${endDate}`
      : className
      ? `Report — ${className}`
      : "Report export";

    const filename = startDate && endDate
      ? `report-${startDate}_to_${endDate}.csv`
      : "report-all-time.csv";

    const jobId = addJob({ label });

    try {
      setCsvLoading(true);
      const days = startDate && endDate
        ? Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000) + 1
        : Number.POSITIVE_INFINITY;

      if (days < 30) {
        downloadFile(reportUrl, fallbackFilename);
        return;
      }

      const controller = new AbortController();
      downloadAbortRef.current = controller;
      setDownloadStatus("Starting report generation...");
      const response = await fetch(`${reportUrl}&async=true`, {
        credentials: "include",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw Object.assign(new Error(t("reports.downloadError")), {
          response: { status: response.status },
        });
      }
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);

      // Notify the tray that the export is ready
      completeJob({ id: jobId, blobUrl, filename });

      // Also trigger the download immediately for users already on this page
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      failJob({ id: jobId, error: err.message || t("reports.failedCsvUnknown") });
      setError(t("reports.failedCsvPrefix") + (err.message || t("reports.failedCsvUnknown")));
    } finally {
      downloadAbortRef.current = null;
      setCsvLoading(false);
    }
  }

  function cancelCsvDownload() {
    downloadAbortRef.current?.abort();
  }

  const TABLE_COLS = [
    { key: "date",               label: "reports.colDate" },
    { key: "totalAmount",        label: "reports.colAmountXlm" },
    { key: "paymentCount",       label: "reports.colPayments" },
    { key: "validCount",         label: "status.validation.valid", color: "var(--success-text)" },
    { key: "overpaidCount",      label: "status.validation.overpaid", color: "var(--warning-text)" },
    { key: "underpaidCount",     label: "status.validation.underpaid", color: "var(--danger-text)" },
    { key: "uniqueStudentCount", label: "reports.colStudents" },
  ];

  return (
    <div className="page-wrap">
      <PageHero
        eyebrow={t("reports.eyebrow")}
        title={t("reports.title")}
        subtitle={t("reports.subtitle")}
      />

      {/* Filter form */}
      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <div className="card-header">
          <div className="card-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <IconCalendar size={16} /> {t("reports.filtersTitle")}
          </div>
        </div>
        <div className="card-body">
          <form onSubmit={handleGenerate} style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "flex-end" }}>
            <div className="form-group" style={{ marginBottom: 0, minWidth: "340px", flex: "1 1 340px" }}>
              <DateRangePicker
                startDate={startDate}
                endDate={endDate}
                onChange={({ startDate: s, endDate: e }) => {
                  setStartDate(s);
                  setEndDate(e);
                }}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">{t("reports.classOptional")}</label>
              <input
                type="text"
                className="form-input"
                style={{ width: "auto" }}
                placeholder={t("reports.classPlaceholder")}
                value={className}
                onChange={e => setClassName(e.target.value)}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">{t("reports.studentIdOptional")}</label>
              <input
                type="text"
                className="form-input"
                style={{ width: "auto" }}
                placeholder={t("reports.studentIdPlaceholder")}
                value={studentId}
                onChange={e => setStudentId(e.target.value)}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">{t("reports.paymentStatusOptional")}</label>
              <select
                className="form-input"
                style={{ width: "auto" }}
                value={paymentStatus}
                onChange={e => setPaymentStatus(e.target.value)}
              >
                <option value="">{t("reports.all")}</option>
                <option value="valid">{t("status.validation.valid")}</option>
                <option value="overpaid">{t("status.validation.overpaid")}</option>
                <option value="underpaid">{t("status.validation.underpaid")}</option>
                <option value="confirmed">{t("status.payment.CONFIRMED")}</option>
                <option value="pending">{t("status.payment.PENDING")}</option>
              </select>
            </div>
            <button type="submit" disabled={loading} className="btn btn-primary" style={{ alignSelf: "flex-end" }}>
              {loading ? "Generating..." : t("reports.generateReport")}
            </button>
            {(startDate || endDate || className || studentId || paymentStatus) && !loading && (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ alignSelf: "flex-end" }}
                onClick={() => { setStartDate(""); setEndDate(""); setClassName(""); setStudentId(""); setPaymentStatus(""); setReport(null); }}
              >
                {t("reports.clearAll")}
              </button>
            )}
          </form>
        </div>
      </div>

      {error && (
        <div style={{ marginBottom: "1.5rem" }}>
          <StandaloneEmptyState
            variant="error"
            title={t("reports.failedGenerate")}
            description={error}
            action={errorRetryable ? {
              label: t("actions.retry"),
              onClick: () => errorOperation === "csv" ? handleCsv() : handleGenerate(),
            } : undefined}
          />
        </div>
      )}

      {loading && !report && (
        <div role="status" aria-live="polite" aria-busy="true" aria-label="Loading..." style={{ marginBottom: "1.5rem" }}>
          <div className="stat-grid" style={{ marginBottom: "1rem" }}>
            {[0, 1, 2, 3].map((index) => <StatCard key={index} label=" " value=" " />)}
          </div>
          <SkeletonDetailCard rows={5} />
        </div>
      )}

      {report && (
        <>
          {/* Period info */}
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "1rem",
            flexWrap: "wrap",
            gap: "0.5rem",
          }}>
            <p style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
              {t("reports.period")} <strong>{report.period.startDate || t("reports.allTime")}</strong>
              {" → "}
              <strong>{report.period.endDate || t("reports.allTime")}</strong>
              &nbsp;·&nbsp;{t("reports.generatedAt", { date: (() => { const r = formatTimestamp(report.generatedAt, { mode: DISPLAY_MODE.UTC }); return r.label ? `${r.formatted} ${r.label}` : r.formatted; })() })}
            </p>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <button
                onClick={handleCsv}
                disabled={csvLoading}
                className="btn btn-ghost btn-sm"
                style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}
              >
                {csvLoading ? (
                  <>
                    <div style={{
                      width: "14px",
                      height: "14px",
                      border: "2px solid var(--text-muted)",
                      borderTop: "2px solid var(--text-default)",
                      borderRadius: "50%",
                      animation: "spin 0.8s linear infinite",
                    }} />
                    <span>{t("reports.downloading")}</span>
                  </>
                ) : (
                  <>
                    <IconDownload size={14} /> {t("reports.downloadCsv") || "Download CSV"}
                  </>
                )}
              </button>
              {csvLoading && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={cancelCsvDownload}>
                  Cancel
                </button>
              )}
              {reportHistory.length > 0 && (
                <button
                  onClick={() => setShowHistory(!showHistory)}
                  className="btn btn-ghost btn-sm"
                  style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}
                >
                  <IconClock size={14} /> {t("reports.history", { count: reportHistory.length })}
                </button>
              )}
            </div>
          </div>

          {downloadStatus && (
            <p role="status" aria-live="polite" aria-busy={csvLoading} style={{ marginTop: "-0.75rem", marginBottom: "1rem", color: "var(--text-muted)", fontSize: "0.8125rem" }}>
              {downloadStatus}
            </p>
          )}

          {showHistory && reportHistory.length > 0 && (
            <div className="card" style={{ marginBottom: "1.5rem" }}>
              <div className="card-header">
                <div className="card-title">{t("reports.historyTitle")}</div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table {...historyGridProps} role="grid" aria-label={t("reports.historyTitle")} aria-colcount={5} aria-rowcount={reportHistory.length + 1} className="data-table" style={{ fontSize: "0.875rem" }}>
                  <thead>
                    <tr role="row">
                      <th role="columnheader" data-grid-cell>{t("reports.colGenerated")}</th>
                      <th role="columnheader" data-grid-cell>{t("reports.colTotal")}</th>
                      <th role="columnheader" data-grid-cell>{t("reports.colPayments")}</th>
                      <th role="columnheader" data-grid-cell>{t("reports.colFilters")}</th>
                      <th role="columnheader" data-grid-cell></th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportHistory.map(entry => (
                      <tr key={entry.id} role="row">
                        <td role="gridcell" data-grid-cell style={{ whiteSpace: "nowrap" }}>
                          {(() => { const r = formatTimestamp(entry.timestamp, { mode: DISPLAY_MODE.UTC }); return r.label ? `${r.formatted} ${r.label}` : r.formatted; })()}
                        </td>
                        <td role="gridcell" data-grid-cell>{entry.summary.totalAmount} XLM</td>
                        <td role="gridcell" data-grid-cell>{entry.summary.paymentCount}</td>
                        <td role="gridcell" data-grid-cell style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                          {Object.keys(entry.params).length > 0
                            ? Object.entries(entry.params)
                              .map(([k, v]) => `${k}: ${v}`)
                              .join(", ")
                            : t("reports.none")}
                        </td>
                        <td role="gridcell" data-grid-cell>
                          <button
                            onClick={() => {
                              setStartDate(entry.params.startDate || "");
                              setEndDate(entry.params.endDate || "");
                              setClassName(entry.params.className || "");
                              setStudentId(entry.params.studentId || "");
                              setPaymentStatus(entry.params.paymentStatus || "");
                            }}
                            className="btn btn-ghost btn-sm"
                            style={{ padding: "0.25rem 0.5rem" }}
                          >
                            {t("reports.rerun")}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <style>{`
            @keyframes spin {
              to { transform: rotate(360deg); }
            }
          `}</style>

          {/* Summary stats */}
          <div className="stat-grid" style={{ marginBottom: "1.5rem" }}>
            <StatCard label={t("reports.statTotalCollected")} value={report.summary.totalAmount} sub="XLM" Icon={IconTrendingUp} color="violet" />
            <StatCard label={t("reports.statTotalPayments")}  value={report.summary.paymentCount}                            Icon={IconBarChart}  color="cyan" />
            <StatCard label={t("status.validation.valid")}           value={report.summary.validCount}                              Icon={IconCheck}     color="green" />
            <StatCard label={t("status.validation.overpaid")}        value={report.summary.overpaidCount}                           Icon={IconAlertTriangle} color="amber" />
            <StatCard label={t("status.validation.underpaid")}       value={report.summary.underpaidCount}                          Icon={IconAlertTriangle} color="rose" />
            <StatCard label={t("reports.statPaidStudents")}   value={report.summary.fullyPaidStudentCount}                   Icon={IconCheck}     color="indigo" />
          </div>

          {/* By-class breakdown (if available) */}
          {report.byClass && report.byClass.length > 0 && (
            <div className="card" style={{ marginBottom: "1.5rem" }}>
              <div className="card-header">
                <div className="card-title">{t("reports.byClass")}</div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table {...classGridProps} role="grid" aria-label={t("reports.byClass")} aria-colcount={7} aria-rowcount={report.byClass.length + 1} className="data-table" style={{ fontSize: "0.875rem" }}>
                  <thead>
                    <tr role="row">
                      <th role="columnheader" data-grid-cell>{t("reports.colClass")}</th>
                      <th role="columnheader" data-grid-cell>{t("reports.colTotalXlm")}</th>
                      <th role="columnheader" data-grid-cell>{t("reports.colPayments")}</th>
                      <th role="columnheader" data-grid-cell>{t("status.validation.valid")}</th>
                      <th role="columnheader" data-grid-cell>{t("status.validation.overpaid")}</th>
                      <th role="columnheader" data-grid-cell>{t("status.validation.underpaid")}</th>
                      <th role="columnheader" data-grid-cell>{t("reports.colStudents")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byClass.map(row => (
                      <tr key={row.className} role="row">
                        <td role="gridcell" data-grid-cell style={{ fontWeight: 500 }}>{row.className}</td>
                        <td role="gridcell" data-grid-cell style={{ fontVariantNumeric: "tabular-nums" }}>{row.totalAmount}</td>
                        <td role="gridcell" data-grid-cell>{row.paymentCount}</td>
                        <td role="gridcell" data-grid-cell style={{ color: "var(--success-text)", fontWeight: 600 }}>{row.validCount}</td>
                        <td role="gridcell" data-grid-cell style={{ color: "var(--warning-text)", fontWeight: 600 }}>{row.overpaidCount}</td>
                        <td role="gridcell" data-grid-cell style={{ color: "var(--danger-text)", fontWeight: 600 }}>{row.underpaidCount}</td>
                        <td role="gridcell" data-grid-cell>{row.uniqueStudentCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Daily breakdown table */}
          {report.byDate.length > 0 ? (
            <div className="card">
              <div className="card-header">
                <div className="card-title">{t("reports.dailyBreakdown")}</div>
                <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
                  {t("reports.days", { count: report.byDate.length })}
                </span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table {...dailyGridProps} role="grid" aria-label={t("reports.dailyBreakdown")} aria-colcount={TABLE_COLS.length} aria-rowcount={report.byDate.length + 1} className="data-table">
                  <thead>
                    <tr role="row">
                      {TABLE_COLS.map(col => (
                        <th key={col.key} role="columnheader" data-grid-cell scope="col">{t(col.label)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.byDate.map(row => (
                      <tr key={row.date} role="row">
                        <td role="gridcell" data-grid-cell style={{ whiteSpace: "nowrap", fontWeight: 500 }}>{row.date}</td>
                        <td role="gridcell" data-grid-cell style={{ fontVariantNumeric: "tabular-nums" }}>{row.totalAmount}</td>
                        <td role="gridcell" data-grid-cell>{row.paymentCount}</td>
                        <td role="gridcell" data-grid-cell style={{ color: "var(--success-text)", fontWeight: 600 }}>{row.validCount}</td>
                        <td role="gridcell" data-grid-cell style={{ color: "var(--warning-text)", fontWeight: 600 }}>{row.overpaidCount}</td>
                        <td role="gridcell" data-grid-cell style={{ color: "var(--danger-text)", fontWeight: 600 }}>{row.underpaidCount}</td>
                        <td role="gridcell" data-grid-cell>{row.uniqueStudentCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="card">
              <StandaloneEmptyState
                variant={
                  startDate || endDate || className || studentId || paymentStatus
                    ? "filtered"
                    : "empty"
                }
                title={
                  startDate || endDate || className || studentId || paymentStatus
                    ? t("reports.noPaymentsInPeriod")
                    : t("reports.noPaymentsYet", "No payments recorded yet")
                }
                description={
                  startDate || endDate || className || studentId || paymentStatus
                    ? t("reports.tryAdjustingFilters", "Try adjusting your date range or clearing filters.")
                    : t("reports.noPaymentsYetDesc", "Payment data will appear here once transactions are recorded.")
                }
                action={
                  startDate || endDate || className || studentId || paymentStatus
                    ? {
                        label: t("reports.clearAll"),
                        onClick: () => {
                          setStartDate(""); setEndDate(""); setClassName("");
                          setStudentId(""); setPaymentStatus(""); setReport(null);
                        },
                      }
                    : undefined
                }
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
