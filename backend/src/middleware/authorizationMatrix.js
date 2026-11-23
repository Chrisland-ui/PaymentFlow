'use strict';

/**
 * Authorization Matrix for PaymentFlow administrative and protected endpoints.
 *
 * This module is the single authoritative reference for which authentication
 * level, roles, and ownership constraints apply to each protected route group.
 * It is machine-readable so tooling (tests, audits, documentation generators)
 * can consume it without parsing route files.
 *
 * Auth levels:
 *   SUPER_ADMIN  — requireAdminAuth: global admin, no school scope restriction.
 *                  Accepts tokens with role:'admin' OR roles:['super_admin'].
 *   SCHOOL_ADMIN — requireSchoolAuth(roles): tenant-scoped. Token schoolId must
 *                  match X-School-ID header. Optional role restriction.
 *   PUBLIC       — No authentication required.
 *
 * Ownership check: when ownershipCheck is true the controller must verify that
 * the resource (student, payment, etc.) belongs to req.schoolId BEFORE mutating
 * it. The middleware enforces tenancy; controllers enforce resource ownership.
 */

/** @type {Record<string, RouteGroup>} */
const MATRIX = {
  // ── Super-admin only ───────────────────────────────────────────────────────
  ADMIN_RUNTIME: {
    description: 'Runtime administration — log level, queue management, consistency',
    authLevel: 'SUPER_ADMIN',
    roles: ['admin', 'super_admin'],
    crossSchool: true,
    ownershipCheck: false,
    endpoints: [
      { method: 'POST', path: '/api/admin/log-level' },
      { method: 'GET',  path: '/api/admin/webhooks/dlq' },
      { method: 'POST', path: '/api/admin/webhooks/dlq/:id/retry' },
      { method: 'POST', path: '/api/admin/webhooks/:id/replay' },
      { method: 'GET',  path: '/api/admin/pending-verifications/backlog' },
      { method: 'GET',  path: '/api/admin/pending-verifications/dead-letter' },
      { method: 'GET',  path: '/api/admin/pending-verifications/:id' },
      { method: 'POST', path: '/api/admin/pending-verifications/:id/retry' },
      { method: 'GET',  path: '/api/admin/payment-limits' },
      { method: 'PUT',  path: '/api/admin/payment-limits' },
      { method: 'DELETE', path: '/api/admin/payment-limits/:schoolId' },
      { method: 'GET',  path: '/api/admin/retry-queue/failed' },
      { method: 'GET',  path: '/api/admin/retry-queue/failed/:jobId' },
      { method: 'POST', path: '/api/admin/retry-queue/failed/:jobId/retry' },
      { method: 'DELETE', path: '/api/admin/retry-queue/failed/:jobId' },
      { method: 'GET',  path: '/api/admin/retry-queue/stats' },
      { method: 'GET',  path: '/api/admin/outbox/dead-letter' },
      { method: 'GET',  path: '/api/admin/outbox/dead-letter/:eventId' },
      { method: 'POST', path: '/api/admin/outbox/dead-letter/:eventId/replay' },
      { method: 'DELETE', path: '/api/admin/outbox/dead-letter/:eventId' },
      { method: 'GET',  path: '/api/admin/outbox/stats' },
      { method: 'GET',  path: '/api/consistency' },
    ],
  },

  AUDIT_LOG: {
    description: 'Immutable audit log — read and verify only',
    authLevel: 'SUPER_ADMIN',
    roles: ['admin', 'super_admin'],
    crossSchool: true,
    ownershipCheck: false,
    endpoints: [
      { method: 'GET', path: '/api/audit' },
      { method: 'GET', path: '/api/audit/recent' },
      { method: 'GET', path: '/api/audit/export' },
      { method: 'GET', path: '/api/audit/verify-chain' },
    ],
  },

  // ── School-admin (owner / admin role) ─────────────────────────────────────
  STUDENT_WRITE: {
    description: 'Student registration and lifecycle mutations',
    authLevel: 'SCHOOL_ADMIN',
    roles: [],  // requireAdminAuth used directly — super-admin only
    crossSchool: false,
    ownershipCheck: true,
    endpoints: [
      { method: 'POST',   path: '/api/students' },
      { method: 'POST',   path: '/api/students/bulk' },
      { method: 'PUT',    path: '/api/students/:studentId' },
      { method: 'DELETE', path: '/api/students/:studentId' },
      { method: 'POST',   path: '/api/students/:studentId/restore' },
      { method: 'POST',   path: '/api/students/:studentId/reset-payment' },
      { method: 'POST',   path: '/api/students/:studentId/reconcile' },
      { method: 'POST',   path: '/api/students/:studentId/credit-adjustments' },
    ],
  },

  STUDENT_READ: {
    description: 'Student data read (school-scoped)',
    authLevel: 'SCHOOL_ADMIN',
    roles: [],
    crossSchool: false,
    ownershipCheck: true,
    endpoints: [
      { method: 'GET', path: '/api/students' },
      { method: 'GET', path: '/api/students/export' },
      { method: 'GET', path: '/api/students/:studentId' },
      { method: 'GET', path: '/api/students/:studentId/payments/audit' },
      { method: 'GET', path: '/api/students/:studentId/fee-history' },
    ],
  },

  FEE_WRITE: {
    description: 'Fee structure mutations',
    authLevel: 'SUPER_ADMIN',
    roles: ['admin', 'super_admin'],
    crossSchool: false,
    ownershipCheck: true,
    endpoints: [
      { method: 'POST',   path: '/api/fees' },
      { method: 'PUT',    path: '/api/fees/:className' },
      { method: 'DELETE', path: '/api/fees/:className' },
    ],
  },

  FEE_READ: {
    description: 'Fee structure reads (school-scoped)',
    authLevel: 'SCHOOL_ADMIN',
    roles: [],
    crossSchool: false,
    ownershipCheck: false,
    endpoints: [
      { method: 'GET', path: '/api/fees' },
      { method: 'GET', path: '/api/fees/:className' },
    ],
  },

  PAYMENT_ADMIN: {
    description: 'Payment administrative mutations (sync, finalize, status updates)',
    authLevel: 'SUPER_ADMIN',
    roles: ['admin', 'super_admin'],
    crossSchool: false,
    ownershipCheck: true,
    endpoints: [
      { method: 'POST',  path: '/api/payments/sync' },
      { method: 'POST',  path: '/api/payments/finalize' },
      { method: 'PATCH', path: '/api/payments/:txHash/status' },
      { method: 'PATCH', path: '/api/payments/bulk/status' },
      { method: 'PATCH', path: '/api/payments/:txHash/suspicion-review' },
      { method: 'PATCH', path: '/api/payments/:txHash/correct-placeholder' },
      { method: 'POST',  path: '/api/payments/:txHash/refund' },
      { method: 'POST',  path: '/api/payments/refunds/:refundId/approve' },
    ],
  },

  PAYMENT_READ: {
    description: 'Payment reads (school-scoped)',
    authLevel: 'SCHOOL_ADMIN',
    roles: [],
    crossSchool: false,
    ownershipCheck: true,
    endpoints: [
      { method: 'GET', path: '/api/payments' },
      { method: 'GET', path: '/api/payments/:studentId' },
      { method: 'GET', path: '/api/payments/overpayments' },
      { method: 'GET', path: '/api/payments/pending' },
      { method: 'GET', path: '/api/payments/suspicious' },
      { method: 'GET', path: '/api/payments/summary' },
    ],
  },

  DISPUTE_ADMIN: {
    description: 'Dispute resolution (admin-only mutations)',
    authLevel: 'SUPER_ADMIN',
    roles: ['admin', 'super_admin'],
    crossSchool: false,
    ownershipCheck: true,
    endpoints: [
      { method: 'PATCH', path: '/api/disputes/:id/resolve' },
      { method: 'POST',  path: '/api/disputes/:id/evidence' },
    ],
  },

  REPORT: {
    description: 'Financial reports (owner or finance role)',
    authLevel: 'SCHOOL_ADMIN',
    roles: ['owner', 'finance'],
    crossSchool: false,
    ownershipCheck: false,
    endpoints: [
      { method: 'GET', path: '/api/reports' },
      { method: 'GET', path: '/api/reports/dashboard' },
      { method: 'GET', path: '/api/reports/jobs/:jobId' },
      { method: 'GET', path: '/api/reports/jobs/:jobId/download' },
    ],
  },

  // ── Public (no auth required) ──────────────────────────────────────────────
  PUBLIC: {
    description: 'Unauthenticated endpoints',
    authLevel: 'PUBLIC',
    roles: [],
    crossSchool: true,
    ownershipCheck: false,
    endpoints: [
      { method: 'GET',  path: '/health' },
      { method: 'GET',  path: '/health/live' },
      { method: 'GET',  path: '/health/ready' },
      { method: 'POST', path: '/api/auth/login' },
      { method: 'POST', path: '/api/auth/refresh' },
      { method: 'POST', path: '/api/auth/logout' },
      { method: 'POST', path: '/api/payments/verify' },
      { method: 'POST', path: '/api/payments/intent' },
      { method: 'POST', path: '/api/payments/submit' },
      { method: 'GET',  path: '/api/payments/verify/:txHash' },
      { method: 'GET',  path: '/api/students/public/:studentId' },
    ],
  },

  // ── Reconciliation admin ───────────────────────────────────────────────────
  RECONCILIATION_ADMIN: {
    description: 'Provider reconciliation jobs and discrepancy review',
    authLevel: 'SUPER_ADMIN',
    roles: ['admin', 'super_admin'],
    crossSchool: true,
    ownershipCheck: false,
    endpoints: [
      { method: 'POST',  path: '/api/admin/reconciliation/run' },
      { method: 'GET',   path: '/api/admin/reconciliation' },
      { method: 'PATCH', path: '/api/admin/reconciliation/:id' },
    ],
  },

  // ── Analytics (school-scoped) ──────────────────────────────────────────────
  ANALYTICS: {
    description: 'Analytics and summary queries (school-scoped; owner or finance role)',
    authLevel: 'SCHOOL_ADMIN',
    roles: ['owner', 'finance'],
    crossSchool: false,
    ownershipCheck: false,
    endpoints: [
      { method: 'GET', path: '/api/analytics' },
      { method: 'GET', path: '/api/analytics/summary' },
    ],
  },
};

/**
 * Flatten the matrix into a list of { method, path, authLevel, roles, ... }
 * entries for programmatic inspection (tests, audit reports).
 *
 * @returns {Array<{method:string, path:string, group:string, authLevel:string, roles:string[], crossSchool:boolean, ownershipCheck:boolean}>}
 */
function flattenMatrix() {
  return Object.entries(MATRIX).flatMap(([group, config]) =>
    config.endpoints.map((ep) => ({
      method: ep.method,
      path: ep.path,
      group,
      authLevel: config.authLevel,
      roles: config.roles,
      crossSchool: config.crossSchool,
      ownershipCheck: config.ownershipCheck,
      description: config.description,
    }))
  );
}

/**
 * Return all endpoints in a named group.
 *
 * @param {string} groupName  Key from MATRIX (e.g. 'ADMIN_RUNTIME')
 * @returns {Array<{method:string, path:string}>}
 */
function endpointsForGroup(groupName) {
  const group = MATRIX[groupName];
  if (!group) throw new Error(`Unknown authorization group: ${groupName}`);
  return group.endpoints;
}

/**
 * Validate the matrix structure at startup or in tests.
 * Throws if any group is missing required fields or any endpoint is malformed.
 *
 * @throws {Error} If the matrix is invalid.
 * @returns {true} If the matrix is valid.
 */
function validateMatrix() {
  const REQUIRED_GROUP_FIELDS = ['description', 'authLevel', 'roles', 'crossSchool', 'ownershipCheck', 'endpoints'];
  const VALID_AUTH_LEVELS = ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PUBLIC'];
  const VALID_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

  for (const [groupName, group] of Object.entries(MATRIX)) {
    for (const field of REQUIRED_GROUP_FIELDS) {
      if (!(field in group)) {
        throw new Error(`[AuthorizationMatrix] Group "${groupName}" is missing required field: ${field}`);
      }
    }
    if (!VALID_AUTH_LEVELS.includes(group.authLevel)) {
      throw new Error(
        `[AuthorizationMatrix] Group "${groupName}" has invalid authLevel "${group.authLevel}". ` +
        `Must be one of: ${VALID_AUTH_LEVELS.join(', ')}`
      );
    }
    if (!Array.isArray(group.roles)) {
      throw new Error(`[AuthorizationMatrix] Group "${groupName}" roles must be an array`);
    }
    if (!Array.isArray(group.endpoints) || group.endpoints.length === 0) {
      throw new Error(`[AuthorizationMatrix] Group "${groupName}" must have at least one endpoint`);
    }
    for (const ep of group.endpoints) {
      if (!ep.method || !ep.path) {
        throw new Error(
          `[AuthorizationMatrix] Group "${groupName}" has an endpoint missing method or path: ` +
          JSON.stringify(ep)
        );
      }
      if (!VALID_METHODS.includes(ep.method.toUpperCase())) {
        throw new Error(
          `[AuthorizationMatrix] Group "${groupName}" endpoint has invalid HTTP method "${ep.method}"`
        );
      }
    }
  }

  return true;
}

module.exports = { MATRIX, flattenMatrix, endpointsForGroup, validateMatrix };
