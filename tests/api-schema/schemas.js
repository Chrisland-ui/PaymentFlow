'use strict';

/**
 * Maintained API response schemas for schema regression tests (#91).
 *
 * Each schema is a plain object that maps field names to expected types
 * ('string', 'number', 'boolean', 'object', 'array') or to a nested schema
 * object. The validateSchema() helper in the test file walks this tree.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ADDING A NEW FIELD
 * ─────────────────────────────────────────────────────────────────────────────
 * Add the field name and type to the relevant schema below, then update
 * SCHEMA_CHANGELOG.md with the date, field name, and reason.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REMOVING OR RENAMING A FIELD
 * ─────────────────────────────────────────────────────────────────────────────
 * This is a BREAKING CHANGE. Before merging:
 *   1. Update the schema here.
 *   2. Add an entry to SCHEMA_CHANGELOG.md explaining the migration path.
 *   3. Confirm with the team that no external consumer depends on the old field.
 *
 * The CI `api-schema-regression` job will fail on any PR that removes a field
 * from a response without updating the schema and changelog simultaneously.
 */

// ── System ────────────────────────────────────────────────────────────────────

const HEALTH_OK = {
  status: 'string',
};

// ── Auth ──────────────────────────────────────────────────────────────────────

const AUTH_LOGIN_SUCCESS = {
  token: 'string',
  user: {
    id: 'string',
    role: 'string',
    schoolId: 'string',
  },
};

const AUTH_ERROR = {
  error: 'string',
};

// ── Students ──────────────────────────────────────────────────────────────────

const STUDENTS_LIST = {
  students: 'array',
  total: 'number',
  page: 'number',
  pages: 'number',
};

// ── Payments ──────────────────────────────────────────────────────────────────

const PAYMENTS_HISTORY = {
  payments: 'array',
  total: 'number',
};

const PAYMENTS_PENDING = {
  pending: 'array',
  count: 'number',
  pagination: {
    page: 'number',
    limit: 'number',
    total: 'number',
    totalPages: 'number',
    hasNext: 'boolean',
    hasPrev: 'boolean',
  },
};

const PAYMENTS_OVERPAYMENTS = {
  overpayments: 'array',
  total: 'number',
};

// ── Fees ──────────────────────────────────────────────────────────────────────

const FEES_LIST = {
  fees: 'array',
};

// ── Reports ───────────────────────────────────────────────────────────────────

const REPORTS_SUCCESS = {
  summary: 'object',
  payments: 'array',
};

// ── Audit logs ────────────────────────────────────────────────────────────────

const AUDIT_LOGS = {
  logs: 'array',
  total: 'number',
  page: 'number',
  limit: 'number',
  pages: 'number',
};

// ── Disputes ──────────────────────────────────────────────────────────────────

const DISPUTES_LIST = {
  disputes: 'array',
};

// ── Generic error (4xx / 5xx) ─────────────────────────────────────────────────

const ERROR_SHAPE = {
  error: 'string',
};

module.exports = {
  HEALTH_OK,
  AUTH_LOGIN_SUCCESS,
  AUTH_ERROR,
  STUDENTS_LIST,
  PAYMENTS_HISTORY,
  PAYMENTS_PENDING,
  PAYMENTS_OVERPAYMENTS,
  FEES_LIST,
  REPORTS_SUCCESS,
  AUDIT_LOGS,
  DISPUTES_LIST,
  ERROR_SHAPE,
};
