import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import PageHero from "../components/PageHero";
import RequireAdmin from "../components/RequireAdmin";
import DateRangePicker from "../components/DateRangePicker";
import { IconAlertTriangle, IconTrendingUp, IconUsers } from "../components/Icons";
import { SkeletonDetailCard, SkeletonStatCard } from "../components/Skeleton";
import { useAbortController } from "../hooks/useAbortController";

const API_BASE = process.env.REACT_APP_API_BASE || '/api';

function Analytics() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState(null);
  const [volumeTrend, setVolumeTrend] = useState([]);
  const [classCompletion, setClassCompletion] = useState([]);
  const [unpaidCohorts, setUnpaidCohorts] = useState([]);
  const [period, setPeriod] = useState('daily');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadAnalyticsData();
  }, [period, startDate, endDate]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAnalyticsData() {
    try {
      setLoading(true);
      setError(null);

      const dateParams = new URLSearchParams();
      if (startDate) dateParams.set('startDate', startDate);
      if (endDate) dateParams.set('endDate', endDate);
      const dateSuffix = dateParams.toString() ? `&${dateParams}` : '';

      const [summaryRes, trendRes, classRes, cohortRes] = await Promise.allSettled([
        fetch(`${API_BASE}/analytics/summary?${dateParams}`).then(r => r.json()),
        fetch(`${API_BASE}/analytics/volume-trend?period=${period}${dateSuffix}`).then(r => r.json()),
        fetch(`${API_BASE}/analytics/class-completion?${dateParams}`).then(r => r.json()),
        fetch(`${API_BASE}/analytics/unpaid-cohorts?${dateParams}`).then(r => r.json()),
      ]);

      if (summaryRes.status === 'fulfilled') setSummary(summaryRes.value.summary);
      if (trendRes.status === 'fulfilled') setVolumeTrend(trendRes.value.data || []);
      if (classRes.status === 'fulfilled') setClassCompletion(classRes.value.data || []);
      if (cohortRes.status === 'fulfilled') setUnpaidCohorts(cohortRes.value.data || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="page-wrap">
        <p aria-busy="true" style={{ color: "var(--text-muted)" }}>
          {t("analytics.loading")}
        </p>
      </div>
    );
  }

  return (
    <>
      <PageHero
        eyebrow={t("analytics.eyebrow")}
        title={t("analytics.title")}
        subtitle={t("analytics.subtitle")}
      />

      <div className="page-wrap">
        {error && (
          <div role="alert" className="alert alert-danger" style={{ marginBottom: "1rem" }}>
            <IconAlertTriangle size={15} />
            <span>{error}</span>
          </div>
        )}

        {/* ── Date Range Filter ─────────────────────────────────────────── */}
        <div className="card" style={{ marginBottom: "1.5rem" }}>
          <div className="card-body">
            <DateRangePicker
              startDate={startDate}
              endDate={endDate}
              onChange={({ startDate: s, endDate: e }) => {
                setStartDate(s);
                setEndDate(e);
              }}
            />
          </div>
        </div>

        {/* ── Summary Stats ─────────────────────────────────────────────── */}
        {summary && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem", marginBottom: "2rem" }}>
            <div className="card">
              <div className="card-body" style={{ textAlign: "center" }}>
                <div style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
                  {t("analytics.totalStudents")}
                </div>
                <div style={{ fontSize: "2rem", fontWeight: "bold" }}>{summary.totalStudents}</div>
              </div>
            </div>
            <div className="card">
              <div className="card-body" style={{ textAlign: "center" }}>
                <div style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
                  {t("analytics.paidStudents")}
                </div>
                <div style={{ fontSize: "2rem", fontWeight: "bold", color: "var(--success)" }}>
                  {summary.paidStudents}
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  ({summary.completionRate?.toFixed(1)}%)
                </div>
              </div>
            </div>
            <div className="card">
              <div className="card-body" style={{ textAlign: "center" }}>
                <div style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
                  {t("analytics.totalOutstanding")}
                </div>
                <div style={{ fontSize: "2rem", fontWeight: "bold", color: "var(--danger)" }}>
                  {summary.totalOutstanding?.toFixed(2)} XLM
                </div>
              </div>
            </div>
            <div className="card">
              <div className="card-body" style={{ textAlign: "center" }}>
                <div style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
                  {t("analytics.avgPayment")}
                </div>
                <div style={{ fontSize: "2rem", fontWeight: "bold" }}>
                  {summary.averagePayment?.toFixed(2)} XLM
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Volume Trend ──────────────────────────────────────────────── */}
        <div className="card" style={{ marginBottom: "2rem" }}>
          <div className="card-header">
            <div className="card-title">{t("analytics.volumeTrend")}</div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              {['daily', 'weekly', 'monthly'].map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={period === p ? "btn btn-sm btn-primary" : "btn btn-sm btn-ghost"}
                  style={{ fontSize: "0.75rem" }}
                >
                  {t(`analytics.period.${p}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="card-body">
            {volumeTrend.length > 0 ? (
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("analytics.date")}</th>
                      <th scope="col">{t("analytics.totalAmount")}</th>
                      <th scope="col">{t("analytics.transactionCount")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {volumeTrend.map((row) => (
                      <tr key={row.date}>
                        <td>{row.date}</td>
                        <td>{row.totalAmount?.toFixed(2)} XLM</td>
                        <td>{row.paymentCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p style={{ color: "var(--text-muted)" }}>{t("analytics.noData")}</p>
            )}
          </div>
        </div>

        {/* ── Class Payment Completion ──────────────────────────────────── */}
        <div className="card" style={{ marginBottom: "2rem" }}>
          <div className="card-header">
            <div className="card-title">{t("analytics.classCompletion")}</div>
          </div>
          <div className="card-body">
            {classCompletion.length > 0 ? (
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("analytics.class")}</th>
                      <th scope="col">{t("analytics.total")}</th>
                      <th scope="col">{t("analytics.paid")}</th>
                      <th scope="col">{t("analytics.unpaid")}</th>
                      <th scope="col">{t("analytics.completionRate")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {classCompletion.map((row) => (
                      <tr key={row.class}>
                        <td>{row.class}</td>
                        <td>{row.total}</td>
                        <td style={{ color: "var(--success)" }}>{row.paid}</td>
                        <td style={{ color: "var(--danger)" }}>{row.unpaid}</td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                            <div style={{ flex: 1, height: "8px", background: "var(--border)", borderRadius: "4px", overflow: "hidden" }}>
                              <div style={{
                                height: "100%",
                                width: `${row.completionRate || 0}%`,
                                background: row.completionRate > 75 ? "var(--success)" : row.completionRate > 50 ? "var(--warning)" : "var(--danger)",
                              }} />
                            </div>
                            <span style={{ fontSize: "0.875rem", minWidth: "3rem" }}>
                              {row.completionRate?.toFixed(0)}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p style={{ color: "var(--text-muted)" }}>{t("analytics.noData")}</p>
            )}
          </div>
        </div>

        {/* ── Top Unpaid Cohorts ────────────────────────────────────────── */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">{t("analytics.topUnpaidCohorts")}</div>
          </div>
          <div className="card-body">
            {unpaidCohorts.length > 0 ? (
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("analytics.class")}</th>
                      <th scope="col">{t("analytics.unpaidCount")}</th>
                      <th scope="col">{t("analytics.totalOutstandingAmount")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unpaidCohorts.map((row) => (
                      <tr key={row.class}>
                        <td>{row.class}</td>
                        <td>{row.unpaidCount}</td>
                        <td>{row.totalOutstanding?.toFixed(2)} XLM</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p style={{ color: "var(--text-muted)" }}>{t("analytics.noUnpaid")}</p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export default RequireAdmin(Analytics);

const API_BASE = process.env.REACT_APP_API_BASE || '/api';

function Analytics() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState(null);
  const [volumeTrend, setVolumeTrend] = useState([]);
  const [classCompletion, setClassCompletion] = useState([]);
  const [unpaidCohorts, setUnpaidCohorts] = useState([]);
  const [period, setPeriod] = useState('daily');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Issue #254 — abort in-flight analytics fetch calls when the component
  // unmounts to prevent stale responses from landing after navigation.
  const { signal } = useAbortController();

  const loadAnalyticsData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [summaryRes, trendRes, classRes, cohortRes] = await Promise.allSettled([
        fetch(`${API_BASE}/analytics/summary`, { signal }).then(r => r.json()),
        fetch(`${API_BASE}/analytics/volume-trend?period=${period}`, { signal }).then(r => r.json()),
        fetch(`${API_BASE}/analytics/class-completion`, { signal }).then(r => r.json()),
        fetch(`${API_BASE}/analytics/unpaid-cohorts`, { signal }).then(r => r.json()),
      ]);

      if (summaryRes.status === 'fulfilled') setSummary(summaryRes.value.summary);
      if (trendRes.status === 'fulfilled') setVolumeTrend(trendRes.value.data || []);
      if (classRes.status === 'fulfilled') setClassCompletion(classRes.value.data || []);
      if (cohortRes.status === 'fulfilled') setUnpaidCohorts(cohortRes.value.data || []);
    } catch (err) {
      // Silently ignore requests cancelled on unmount or navigation.
      if (err?.name === 'AbortError') return;
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [period, signal]);

  useEffect(() => {
    loadAnalyticsData();
  }, [loadAnalyticsData]);

  if (loading) {
    return (
      <>
        <PageHero eyebrow={t("analytics.eyebrow")} title={t("analytics.title")} subtitle={t("analytics.subtitle")} />
        <div className="page-wrap" role="status" aria-live="polite" aria-busy="true" aria-label="Loading...">
          <div className="stat-grid" aria-hidden="true">{[0, 1, 2, 3].map((index) => <SkeletonStatCard key={index} />)}</div>
          <SkeletonDetailCard rows={4} />
          <SkeletonDetailCard rows={3} />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHero
        eyebrow={t("analytics.eyebrow")}
        title={t("analytics.title")}
        subtitle={t("analytics.subtitle")}
      />

      <div className="page-wrap">
        {error && (
          <div role="alert" className="alert alert-danger" style={{ marginBottom: "1rem" }}>
            <IconAlertTriangle size={15} />
            <span>{error}</span>
          </div>
        )}

        {/* ── Summary Stats ─────────────────────────────────────────────── */}
        {summary && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem", marginBottom: "2rem" }}>
            <div className="card">
              <div className="card-body" style={{ textAlign: "center" }}>
                <div style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
                  {t("analytics.totalStudents")}
                </div>
                <div style={{ fontSize: "2rem", fontWeight: "bold" }}>{summary.totalStudents}</div>
              </div>
            </div>
            <div className="card">
              <div className="card-body" style={{ textAlign: "center" }}>
                <div style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
                  {t("analytics.paidStudents")}
                </div>
                <div style={{ fontSize: "2rem", fontWeight: "bold", color: "var(--success)" }}>
                  {summary.paidStudents}
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  ({summary.completionRate?.toFixed(1)}%)
                </div>
              </div>
            </div>
            <div className="card">
              <div className="card-body" style={{ textAlign: "center" }}>
                <div style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
                  {t("analytics.totalOutstanding")}
                </div>
                <div style={{ fontSize: "2rem", fontWeight: "bold", color: "var(--danger)" }}>
                  {summary.totalOutstanding?.toFixed(2)} XLM
                </div>
              </div>
            </div>
            <div className="card">
              <div className="card-body" style={{ textAlign: "center" }}>
                <div style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
                  {t("analytics.avgPayment")}
                </div>
                <div style={{ fontSize: "2rem", fontWeight: "bold" }}>
                  {summary.averagePayment?.toFixed(2)} XLM
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Volume Trend ──────────────────────────────────────────────── */}
        <div className="card" style={{ marginBottom: "2rem" }}>
          <div className="card-header">
            <div className="card-title">{t("analytics.volumeTrend")}</div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              {['daily', 'weekly', 'monthly'].map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={period === p ? "btn btn-sm btn-primary" : "btn btn-sm btn-ghost"}
                  style={{ fontSize: "0.75rem" }}
                >
                  {t(`analytics.period.${p}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="card-body">
            {volumeTrend.length > 0 ? (
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("analytics.date")}</th>
                      <th scope="col">{t("analytics.totalAmount")}</th>
                      <th scope="col">{t("analytics.transactionCount")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {volumeTrend.map((row) => (
                      <tr key={row.date}>
                        <td>{row.date}</td>
                        <td>{row.totalAmount?.toFixed(2)} XLM</td>
                        <td>{row.paymentCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p style={{ color: "var(--text-muted)" }}>{t("analytics.noData")}</p>
            )}
          </div>
        </div>

        {/* ── Class Payment Completion ──────────────────────────────────── */}
        <div className="card" style={{ marginBottom: "2rem" }}>
          <div className="card-header">
            <div className="card-title">{t("analytics.classCompletion")}</div>
          </div>
          <div className="card-body">
            {classCompletion.length > 0 ? (
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("analytics.class")}</th>
                      <th scope="col">{t("analytics.total")}</th>
                      <th scope="col">{t("analytics.paid")}</th>
                      <th scope="col">{t("analytics.unpaid")}</th>
                      <th scope="col">{t("analytics.completionRate")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {classCompletion.map((row) => (
                      <tr key={row.class}>
                        <td>{row.class}</td>
                        <td>{row.total}</td>
                        <td style={{ color: "var(--success)" }}>{row.paid}</td>
                        <td style={{ color: "var(--danger)" }}>{row.unpaid}</td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                            <div style={{ flex: 1, height: "8px", background: "var(--border)", borderRadius: "4px", overflow: "hidden" }}>
                              <div style={{
                                height: "100%",
                                width: `${row.completionRate || 0}%`,
                                background: row.completionRate > 75 ? "var(--success)" : row.completionRate > 50 ? "var(--warning)" : "var(--danger)",
                              }} />
                            </div>
                            <span style={{ fontSize: "0.875rem", minWidth: "3rem" }}>
                              {row.completionRate?.toFixed(0)}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p style={{ color: "var(--text-muted)" }}>{t("analytics.noData")}</p>
            )}
          </div>
        </div>

        {/* ── Top Unpaid Cohorts ────────────────────────────────────────── */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">{t("analytics.topUnpaidCohorts")}</div>
          </div>
          <div className="card-body">
            {unpaidCohorts.length > 0 ? (
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("analytics.class")}</th>
                      <th scope="col">{t("analytics.unpaidCount")}</th>
                      <th scope="col">{t("analytics.totalOutstandingAmount")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unpaidCohorts.map((row) => (
                      <tr key={row.class}>
                        <td>{row.class}</td>
                        <td>{row.unpaidCount}</td>
                        <td>{row.totalOutstanding?.toFixed(2)} XLM</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p style={{ color: "var(--text-muted)" }}>{t("analytics.noUnpaid")}</p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export default RequireAdmin(Analytics);
