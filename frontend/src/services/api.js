import axios from "axios";
import { createRefreshHandler } from "./authRefresh";
import { getEnvVar } from '../config/envValidation';
import { isRetryable } from '../utils/retryClassification';

const TIMEOUT_MS = parseInt(getEnvVar('NEXT_PUBLIC_REQUEST_TIMEOUT_MS', '15000'), 10);

const api = axios.create({
  baseURL: getEnvVar('NEXT_PUBLIC_API_URL', 'http://localhost:5000/api'),
  timeout: TIMEOUT_MS,
  withCredentials: true,
});

// Attach the school context header to every request unless one is already set.
// Derives school ID from authenticated user session (stored in localStorage after login).
// The backend resolves school scope from X-School-ID (or X-School-Slug).
api.interceptors.request.use((config) => {
  const hasSchoolHeader = Object.keys(config.headers || {}).some(
    (h) => h.toLowerCase() === "x-school-id" || h.toLowerCase() === "x-school-slug"
  );
  if (!hasSchoolHeader) {
    // Get school ID from authenticated user session stored in localStorage
    const schoolId = typeof window !== 'undefined' ? localStorage.getItem('schoolId') : null;
    if (schoolId) {
      config.headers = { ...config.headers, "X-School-ID": schoolId };
    }
  }
  return config;
});

// On a 401 we transparently refresh the access token (the HttpOnly cookies are
// rotated by the backend) and replay the request, instead of hard-redirecting
// and losing in-flight work. Only a failed refresh sends the user to /login,
// preserving where they were via a return-to URL.
function redirectToLogin() {
  if (typeof window === "undefined") return;
  const { pathname, search } = window.location;
  if (pathname === "/login") return; // already there — avoid a redirect loop

  // The refresh failed, so the session is over — clear the client-side auth
  // state (the HttpOnly access/refresh cookies are already invalid and can
  // only be cleared server-side, but this app data must not survive into the
  // next login as stale context; see useAdminAuth's logout()).
  try {
    localStorage.removeItem("schoolId");
    localStorage.removeItem("userId");
  } catch {
    // localStorage unavailable (private browsing, disabled storage) — the
    // hard redirect below still ends the session from the app's perspective.
  }

  // Issue #5 — give in-page listeners one tick to persist safe form-draft
  // state to sessionStorage before we navigate away.  The event name is
  // chosen to be explicit and un-guessable from external scripts.
  try {
    window.dispatchEvent(new Event("session:expired"));
  } catch {
    // dispatchEvent unavailable (SSR / test env) — safe to ignore.
  }

  const returnTo = encodeURIComponent(`${pathname}${search}`);
  window.location.href = `/login?returnTo=${returnTo}`;
}

const onResponseRejected = createRefreshHandler({
  refresh: () => api.post("/auth/refresh"),
  retry: (config) => api(config),
  redirectToLogin,
  isAuthUrl: (url) => url.includes("/auth/"),
});

api.interceptors.response.use((response) => response, onResponseRejected);

api.interceptors.response.use(undefined, async (error) => {
  const config = error.config;
  if (
    !config ||
    config.method?.toLowerCase() !== 'get' ||
    config.signal?.aborted ||
    !isRetryable(error)
  ) {
    throw error;
  }

  const attempts = config.__readAttempts || 1;
  if (attempts >= 3) throw error;

  config.__readAttempts = attempts + 1;
  await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** (attempts - 1))));
  if (config.signal?.aborted) throw error;
  return api.request(config);
});

// Export the bare axios instance as the default so callers that need ad-hoc
// requests (e.g. login.jsx) can use api.post('/auth/login', data) without
// coupling to a specific named helper.
export default api;

export const getStudents = (page = 1, limit = 20, { search, status, className } = {}, { signal } = {}) =>
  api.get("/students", {
    params: {
      page,
      limit,
      ...(search    && { search }),
      ...(status    && status !== "all" && { status }),
      ...(className && { class: className }),
    },
    signal,
  });
export const getStudent = (studentId, { signal } = {}) => api.get(`/students/${studentId}`, { signal });
export const registerStudent = (data) => api.post("/students", data);
export const updateStudent = (studentId, data) => api.patch(`/students/${studentId}`, data);
// Payment endpoints — also available as a typed client via ./paymentApiClient
export const getPaymentSummary = ({ signal } = {}) => api.get("/payments/summary", { signal });
export const getPaymentInstructions = (studentId, { signal } = {}) => api.get(`/payments/instructions/${studentId}`, { signal });
export const getStudentPayments = (studentId, { signal } = {}) => api.get(`/payments/${studentId}`, { signal });
export const getStudentBalance  = (studentId, { signal } = {}) => api.get(`/payments/balance/${studentId}`, { signal });
export const verifyPayment = (txHash, idempotencyKey) =>
  api.post(
    "/payments/verify",
    { txHash },
    idempotencyKey ? { headers: { "X-Idempotency-Key": idempotencyKey } } : {}
  );
export const syncPayments = () => api.post("/payments/sync");
export const getSyncStatus = ({ signal } = {}) => api.get("/payments/sync/status", { signal });
export const getFeeStructures = ({ signal } = {}) => api.get("/fees", { signal });
export const createFeeStructure = (data) => api.post("/fees", data);
export const getFeeByClass = (className) => api.get(`/fees/${className}`);
export const deleteFeeStructure = (className) => api.delete(`/fees/${encodeURIComponent(className)}`);

// Reports
export const getReport = (params = {}) => api.get("/reports", { params });
export const getReportCsvUrl = (params = {}) => {
  const base = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api";
  const query = new URLSearchParams({ ...params, format: "csv" }).toString();
  return `${base}/reports?${query}`;
};

// Currency conversion
export const getConversionRates = () => api.get("/payments/rates");

// Disputes
export const flagDispute = (data) => api.post("/disputes", data);
export const getDisputes = (params = {}, { signal } = {}) => api.get("/disputes", { params, signal });
export const getDisputeById = (id) => api.get(`/disputes/${id}`);
export const resolveDispute = (id, data) =>
  api.patch(`/disputes/${id}/resolve`, data);

// Refunds
export const initiateRefund = (txHash, data) => api.post(`/payments/${txHash}/refund`, data);
export const approveRefund = (refundId, data) => api.post(`/payments/refunds/${refundId}/approve`, data);
export const getPaymentRefunds = (txHash) => api.get(`/payments/${txHash}/refunds`);
export const getSchoolRefunds = (params = {}, { signal } = {}) => api.get("/payments/refunds/school/list", { params, signal });

// Audit logs
export const getRecentAuditLogs = (limit = 10) =>
  api.get("/audit-logs/recent", { params: { limit } });
export const getAuditLogs = (params = {}, { signal } = {}) =>
  api.get("/audit-logs", { params, signal });

// Fee adjustment rules
export const getFeeAdjustmentRules = (schoolId, { signal } = {}) =>
  api.get("/fee-adjustments", { headers: { "X-School-ID": schoolId }, signal });
export const createFeeAdjustmentRule = (data, schoolId) =>
  api.post("/fee-adjustments", data, { headers: { "X-School-ID": schoolId } });
export const updateFeeAdjustmentRule = (id, data, schoolId) =>
  api.put(`/fee-adjustments/${id}`, data, { headers: { "X-School-ID": schoolId } });
export const deleteFeeAdjustmentRule = (id, schoolId) =>
  api.delete(`/fee-adjustments/${id}`, { headers: { "X-School-ID": schoolId } });

// School settings
export const getSchool = (slug) => api.get(`/schools/${slug}`);
export const updateSchool = (slug, data) => api.patch(`/schools/${slug}`, data);

// Payment plans
export const createPaymentPlan = (studentId, data) =>
  api.post(`/payment-plans/${studentId}`, data);
export const getPaymentPlan = (studentId, { signal } = {}) =>
  api.get(`/payment-plans/${studentId}`, { signal });
export const updateInstallment = (studentId, installmentIndex, data) =>
  api.patch(`/payment-plans/${studentId}/installment/${installmentIndex}`, data);
export const cancelPaymentPlan = (studentId) =>
  api.delete(`/payment-plans/${studentId}`);

// MFA
export const setupUserMfa        = ()       => api.post("/auth/mfa/setup");
export const verifyUserMfa       = (data)   => api.post("/auth/mfa/verify", data);
export const disableUserMfa      = ()       => api.post("/auth/mfa/disable");
export const getMfaBackupCodes   = ()       => api.get("/auth/mfa/backup-codes");
export const regenerateBackupCodes = ()     => api.post("/auth/mfa/backup-codes/regenerate");

// Source validation rules (trusted-sender allowlist)
export const getSourceValidationRules = (schoolId, { signal } = {}) =>
  api.get("/source-validation-rules", { headers: { "X-School-ID": schoolId }, signal });
export const createSourceValidationRule = (data, schoolId) =>
  api.post("/source-validation-rules", data, { headers: { "X-School-ID": schoolId } });
export const deleteSourceValidationRule = (id, schoolId) =>
  api.delete(`/source-validation-rules/${id}`, { headers: { "X-School-ID": schoolId } });

// Fee adjustment helpers
export const getFeeAdjustmentAffectedCount = (ruleId, schoolId) =>
  api.get(`/fee-adjustments/${ruleId}/affected-count`, { headers: { "X-School-ID": schoolId } });
