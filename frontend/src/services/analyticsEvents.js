/**
 * Analytics Event Contract — Issue #22
 *
 * Defines a typed catalog of every instrumented user interaction in the
 * payment workflow.  The catalog is the single source of truth for:
 *
 *   - Event names (constants, never raw strings at call sites)
 *   - Allowed payload properties per event
 *   - Properties that MUST be stripped before any event is dispatched
 *     (sensitive payment data, PII)
 *
 * Privacy by design
 * -----------------
 * Every event entry carries a `sensitiveProperties` list.  The `track()`
 * function strips those keys before passing the payload to any adapter.
 * This means even if a call site accidentally includes a wallet address or
 * email, the contract silently removes it before it reaches any analytics
 * backend.
 *
 * Pluggable adapter
 * -----------------
 * The default adapter logs to console.debug in development and is a no-op
 * in production.  Wire a real provider by calling `setAdapter(fn)` once at
 * app startup — no call sites need to change.
 *
 * Usage
 * -----
 *   import { track, EVENTS } from '../services/analyticsEvents';
 *
 *   track(EVENTS.STUDENT_LOOKUP_SUCCESS, { className: 'Grade 5', status: 'unpaid' });
 */

// ---------------------------------------------------------------------------
// Sensitive property names — stripped from every event regardless of catalog.
// This is a defence-in-depth fallback; each event also declares its own list.
// ---------------------------------------------------------------------------
const GLOBAL_SENSITIVE = new Set([
  'txHash',
  'transactionHash',
  'walletAddress',
  'secretKey',
  'parentEmail',
  'parentPhone',
  'memoValue',
]);

// ---------------------------------------------------------------------------
// Event catalog
// ---------------------------------------------------------------------------

/**
 * @typedef {object} EventSpec
 * @property {string}   name                - Canonical event name sent to analytics.
 * @property {string[]} allowedProperties   - Properties this event may carry.
 * @property {string[]} sensitiveProperties - Properties that must be stripped before dispatch.
 * @property {string}   description         - Human-readable purpose of the event.
 */

/** @type {Record<string, EventSpec>} */
export const EVENT_CATALOG = {
  /**
   * Parent opened the payment instructions panel for a student.
   * Allowed: anonymized student class + payment status.
   * Stripped: studentId (full), walletAddress, txHash.
   */
  PAYMENT_INSTRUCTIONS_VIEWED: {
    name: 'payment_instructions_viewed',
    allowedProperties: ['className', 'paymentStatus', 'assetType', 'studentIdPrefix'],
    sensitiveProperties: ['studentId', 'walletAddress', 'txHash', 'memoValue'],
    description: 'Payment instructions panel was opened for a student.',
  },

  /**
   * Parent submitted a transaction hash for manual verification.
   * Stripped: the full hash (fingerprinting risk) and all wallet data.
   */
  PAYMENT_VERIFY_SUBMITTED: {
    name: 'payment_verify_submitted',
    allowedProperties: ['assetType'],
    sensitiveProperties: ['txHash', 'transactionHash', 'walletAddress', 'studentId'],
    description: 'User submitted a transaction hash for verification.',
  },

  /**
   * Verification completed successfully.
   */
  PAYMENT_VERIFY_SUCCESS: {
    name: 'payment_verify_success',
    allowedProperties: ['assetType', 'validationStatus'],
    sensitiveProperties: ['txHash', 'transactionHash', 'walletAddress', 'studentId', 'amount'],
    description: 'Payment verification returned a success result.',
  },

  /**
   * Verification failed (bad hash, network error, etc.).
   */
  PAYMENT_VERIFY_FAILED: {
    name: 'payment_verify_failed',
    allowedProperties: ['errorCode', 'assetType'],
    sensitiveProperties: ['txHash', 'transactionHash', 'walletAddress', 'studentId'],
    description: 'Payment verification returned an error.',
  },

  /**
   * User submitted the student ID lookup form.
   */
  STUDENT_LOOKUP_SUBMITTED: {
    name: 'student_lookup_submitted',
    allowedProperties: [],
    sensitiveProperties: ['studentId', 'parentEmail', 'parentPhone'],
    description: 'Student ID lookup form was submitted.',
  },

  /**
   * Student lookup returned a valid student record.
   * Only class and payment status are tracked — no PII.
   */
  STUDENT_LOOKUP_SUCCESS: {
    name: 'student_lookup_success',
    allowedProperties: ['className', 'paymentStatus', 'studentIdPrefix'],
    sensitiveProperties: ['studentId', 'parentEmail', 'parentPhone', 'name'],
    description: 'Student lookup returned a result.',
  },

  /**
   * Student lookup returned no result or an error.
   */
  STUDENT_LOOKUP_FAILED: {
    name: 'student_lookup_failed',
    allowedProperties: ['errorCode'],
    sensitiveProperties: ['studentId', 'parentEmail', 'parentPhone'],
    description: 'Student lookup failed or returned no result.',
  },

  /**
   * Admin or parent opened the dispute creation form.
   */
  DISPUTE_FORM_OPENED: {
    name: 'dispute_form_opened',
    allowedProperties: ['source'],
    sensitiveProperties: ['txHash', 'transactionHash', 'studentId', 'walletAddress'],
    description: 'Dispute form was opened.',
  },

  /**
   * A dispute was successfully submitted.
   */
  DISPUTE_SUBMITTED: {
    name: 'dispute_submitted',
    allowedProperties: ['disputeType'],
    sensitiveProperties: ['txHash', 'transactionHash', 'studentId', 'walletAddress', 'amount'],
    description: 'Dispute form was submitted.',
  },

  /**
   * Dispute submission failed.
   */
  DISPUTE_SUBMIT_FAILED: {
    name: 'dispute_submit_failed',
    allowedProperties: ['errorCode'],
    sensitiveProperties: ['txHash', 'transactionHash', 'studentId', 'walletAddress'],
    description: 'Dispute submission returned an error.',
  },

  /**
   * User changed the page in a paginated list.
   */
  PAGINATION_PAGE_CHANGED: {
    name: 'pagination_page_changed',
    allowedProperties: ['listName', 'pageNumber', 'pageSize'],
    sensitiveProperties: [],
    description: 'Pagination control was used to navigate to a different page.',
  },

  /**
   * Admin triggered a manual blockchain sync.
   */
  SYNC_TRIGGERED: {
    name: 'sync_triggered',
    allowedProperties: ['source'],
    sensitiveProperties: ['schoolId', 'walletAddress'],
    description: 'Manual payment sync was triggered.',
  },
};

/** Convenience map: event key → event name string. */
export const EVENTS = Object.fromEntries(
  Object.keys(EVENT_CATALOG).map((k) => [k, k]),
);

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

let _adapter =
  typeof process !== 'undefined' && process.env.NODE_ENV === 'production'
    ? () => {} // no-op in production until a real provider is wired in
    : (eventName, properties) => {
        // eslint-disable-next-line no-console
        console.debug('[analytics]', eventName, properties);
      };

/**
 * Replace the analytics adapter at runtime.
 * Call once at app startup to wire in a real provider (e.g. Segment, PostHog).
 *
 * @param {(eventName: string, properties: object) => void} fn
 */
export function setAdapter(fn) {
  if (typeof fn !== 'function') throw new TypeError('adapter must be a function');
  _adapter = fn;
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = '1.0.0';

/**
 * Strip both globally sensitive fields and event-specific sensitive fields.
 *
 * @param {object} properties     - Raw caller-supplied payload.
 * @param {string[]} eventSensitive - Sensitive keys declared in the event spec.
 * @returns {object} Sanitized payload safe to send to any analytics backend.
 */
function stripSensitive(properties, eventSensitive = []) {
  const blocked = new Set([...GLOBAL_SENSITIVE, ...eventSensitive]);
  return Object.fromEntries(
    Object.entries(properties).filter(([k]) => !blocked.has(k)),
  );
}

/**
 * Validate an event name and properties against the catalog.
 * Does NOT strip properties — use this in tests to assert contract compliance.
 *
 * @param {string} eventKey  - Key from EVENT_CATALOG (same as EVENTS constant).
 * @param {object} [properties={}]
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateEvent(eventKey, properties = {}) {
  const errors = [];

  const spec = EVENT_CATALOG[eventKey];
  if (!spec) {
    errors.push(`Unknown event: "${eventKey}". Add it to EVENT_CATALOG before using it.`);
    return { valid: false, errors };
  }

  const allowed = new Set(spec.allowedProperties);
  const sensitive = new Set([...GLOBAL_SENSITIVE, ...spec.sensitiveProperties]);

  for (const key of Object.keys(properties)) {
    if (sensitive.has(key)) {
      errors.push(`Property "${key}" is sensitive and must not appear in event "${eventKey}".`);
    } else if (!allowed.has(key)) {
      errors.push(
        `Unknown property "${key}" for event "${eventKey}". ` +
          `Allowed: [${spec.allowedProperties.join(', ')}].`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Track an analytics event.
 *
 * Sensitive fields are always stripped before the adapter is called.
 * Unknown properties generate a console.warn in development but are otherwise
 * forwarded (after stripping sensitive keys) so a missing allowedProperties
 * entry never silently drops valid data in production.
 *
 * @param {string} eventKey  - Key from EVENTS (e.g. EVENTS.STUDENT_LOOKUP_SUCCESS).
 * @param {object} [properties={}]
 */
export function track(eventKey, properties = {}) {
  const spec = EVENT_CATALOG[eventKey];

  if (!spec) {
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn(`[analytics] Unknown event "${eventKey}" — event was not tracked.`);
    }
    return;
  }

  const safe = stripSensitive(properties, spec.sensitiveProperties);
  safe.schemaVersion = SCHEMA_VERSION;

  // Warn in development when unknown (but non-sensitive) properties are passed.
  if (process.env.NODE_ENV !== 'production') {
    const allowed = new Set(spec.allowedProperties);
    const unknown = Object.keys(safe).filter((k) => k !== 'schemaVersion' && !allowed.has(k));
    if (unknown.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[analytics] Unknown properties for event "${eventKey}": [${unknown.join(', ')}]. ` +
          `Add them to EVENT_CATALOG.${eventKey}.allowedProperties if intentional.`,
      );
    }
  }

  _adapter(spec.name, safe);
}

export const analytics = {
  track,
  setAdapter,
  validateEvent,
  EVENTS,
  EVENT_CATALOG,
  SCHEMA_VERSION,
};

export default analytics;
