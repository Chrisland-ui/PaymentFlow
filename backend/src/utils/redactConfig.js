'use strict';

// See docs/data-classification.md for the full classification scheme.

const SENSITIVE_KEYS = new Set(['JWT_SECRET', 'WEBHOOK_SECRET', 'MONGO_URI', 'MONGODB_URI', 'SMTP_PASS', 'REDIS_PASSWORD']);

// Request body/query fields that must never be written to request logs.
// All fields listed here are classified L4 (Restricted) per docs/data-classification.md.
const REQUEST_LOG_REDACT_FIELDS = [
  'txHash',           // L4 — blockchain financial identifier
  'studentId',        // L3 — student identifier
  'memo',             // L4 — contains studentId embedded in Stellar tx
  'senderAddress',    // L4 — parent's Stellar wallet address
  'password',         // L4 — credentials
  'secret',           // L4 — generic secrets
  'token',            // L4 — auth tokens
  'mfaCode',          // L4 — TOTP one-time code
  'backupCode',       // L4 — MFA backup code
  'currentPassword',  // L4 — credentials
];

// L4 (Restricted) PII fields — must never appear in logs, error responses,
// or webhook payloads. Used by redactPii() below.
// See docs/data-classification.md for the full field-level classification.
const PII_FIELDS = new Set([
  // Student PII
  'parentEmail',
  'parentPhone',
  'parentName',
  'dateOfBirth',
  'gender',
  'contactNumber',
  'name',
  'parentEmailHash',
  // Payment financial identifiers
  'txHash',
  'memo',
  'senderAddress',
  // School secrets
  'webhookSecret',
  'mfaSecret',
  'mfaBackupCodes',
  // Auth / credential fields
  'password',
  'secret',
  'token',
  'mfaCode',
  'backupCode',
  'currentPassword',
  'confirmPassword',
  // School contact PII
  'adminEmail',
]);

const SENSITIVE_LOG_KEY = /(password|secret|token|authorization|cookie|api.?key|private.?key|access.?key|refresh.?token|mfa|backup.?code|student.?id|tx.?hash|sender.?address|memo)/i;

function redactLogValue(value) {
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [
    key,
    SENSITIVE_LOG_KEY.test(key) ? '[REDACTED]' : redactLogValue(nestedValue),
  ]));
}

/**
 * Redact sensitive environment config keys before logging at startup.
 * Replaces the value of any key in SENSITIVE_KEYS with '[REDACTED]'.
 *
 * @param {Object} cfg - Environment config object
 * @returns {Object} Copy of cfg with sensitive values masked
 */
function redactConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  return Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, SENSITIVE_KEYS.has(k) && v !== undefined ? '[REDACTED]' : v]));
}

/**
 * Deep-redact L4 (Restricted) PII fields from a data object or array.
 * Returns a new object/array with all PII_FIELDS values replaced by '[REDACTED]'.
 *
 * Use this before logging any database document or request payload that may
 * contain student or school data. See docs/data-classification.md.
 *
 * @param {Object|Array} data - Object or array to redact
 * @returns {Object|Array} Deep copy with L4 fields masked
 */
function redactPii(data) {
  if (Array.isArray(data)) {
    return data.map(redactPii);
  }
  if (data !== null && typeof data === 'object') {
    return Object.fromEntries(
      Object.entries(data).map(([k, v]) => {
        if (PII_FIELDS.has(k) && v !== undefined && v !== null) {
          return [k, '[REDACTED]'];
        }
        // Recurse into nested objects (but not into arrays of primitives)
        if (v !== null && typeof v === 'object') {
          return [k, redactPii(v)];
        }
        return [k, v];
      })
    );
  }
  return data;
}

module.exports = { redactConfig, redactPii, redactLogValue, SENSITIVE_KEYS, PII_FIELDS, REQUEST_LOG_REDACT_FIELDS };
