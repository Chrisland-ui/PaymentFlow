'use strict';

/**
 * providerPolicyRegistry — per-operation timeout and retry policies.
 *
 * Every external-provider operation has an explicit policy that states:
 *   - timeoutMs     : hard deadline for a single call attempt
 *   - maxAttempts   : maximum number of tries (1 = no retry)
 *   - idempotent    : whether auto-retry on transient failure is safe
 *   - baseDelayMs   : initial exponential-backoff delay between retries
 *   - maxDelayMs    : cap on the computed backoff delay
 *
 * NON-IDEMPOTENT operations (idempotent: false) are NEVER retried
 * automatically.  The caller is responsible for deciding whether to
 * re-submit, because re-submitting may double-charge or double-execute.
 *
 * Examples of non-idempotent operations:
 *   - submitTransaction  (Stellar) — a second submit of the same tx envelope
 *     is safe IF the sequence number has already been consumed, but the call
 *     site cannot know that without an explicit state check.  Treat as
 *     non-idempotent and let the application layer decide.
 *
 * Examples of idempotent (safe-to-retry) operations:
 *   - getAccount, getTransaction, getTransactionsForAccount (read-only)
 *   - currency price feed fetches
 *   - email send — the mail provider deduplicates via idempotency keys
 *
 * Prometheus metrics (lazily registered to survive Jest module resets):
 *   provider_policy_retries_total{provider, operation}
 *     — incremented each time a retry is attempted
 *   provider_policy_timeouts_total{provider, operation}
 *     — incremented each time a call is cancelled due to timeout
 *   provider_policy_calls_total{provider, operation, outcome}
 *     — overall call counter: outcome = 'success' | 'failure' | 'timeout'
 *
 * Environment variable overrides (optional):
 *   PROVIDER_DEFAULT_TIMEOUT_MS   — default timeout for all operations  (10000)
 *   PROVIDER_DEFAULT_MAX_ATTEMPTS — default max attempts                 (3)
 *
 * Usage:
 *   const { getPolicy, executeWithPolicy } = require('./providerPolicyRegistry');
 *
 *   // Look up a policy by provider + operation:
 *   const policy = getPolicy('stellar', 'getAccount');
 *
 *   // Or run a function directly under the policy with timeout + retry:
 *   const result = await executeWithPolicy('stellar', 'getAccount', () =>
 *     horizonClient.getAccount(address)
 *   );
 */

const logger = require('../utils/logger').child('ProviderPolicyRegistry');

// ── Configurable defaults ────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS    = parseInt(process.env.PROVIDER_DEFAULT_TIMEOUT_MS,    10) || 10_000;
const DEFAULT_MAX_ATTEMPTS  = parseInt(process.env.PROVIDER_DEFAULT_MAX_ATTEMPTS,  10) || 3;
const DEFAULT_BASE_DELAY_MS = parseInt(process.env.PROVIDER_DEFAULT_BASE_DELAY_MS, 10) || 1_000;
const DEFAULT_MAX_DELAY_MS  = parseInt(process.env.PROVIDER_DEFAULT_MAX_DELAY_MS,  10) || 15_000;

// ── Prometheus metrics (lazily registered) ────────────────────────────────────

let _retriesCounter;
let _timeoutsCounter;
let _callsCounter;

function _ensureMetrics() {
  let metricsModule;
  try {
    metricsModule = require('../metrics');
  } catch (_) {
    return; // metrics unavailable in tests / early boot
  }
  if (!metricsModule) return;

  const client = require('prom-client');
  const { registry } = metricsModule;

  if (!_retriesCounter) {
    _retriesCounter = new client.Counter({
      name:       'provider_policy_retries_total',
      help:       'Number of retry attempts per provider operation',
      labelNames: ['provider', 'operation'],
      registers:  [registry],
    });
  }
  if (!_timeoutsCounter) {
    _timeoutsCounter = new client.Counter({
      name:       'provider_policy_timeouts_total',
      help:       'Number of calls cancelled due to timeout per provider operation',
      labelNames: ['provider', 'operation'],
      registers:  [registry],
    });
  }
  if (!_callsCounter) {
    _callsCounter = new client.Counter({
      name:       'provider_policy_calls_total',
      help:       'Total calls per provider operation: outcome=success|failure|timeout',
      labelNames: ['provider', 'operation', 'outcome'],
      registers:  [registry],
    });
  }
}

// ── Policy definitions ────────────────────────────────────────────────────────

/**
 * @typedef {object} OperationPolicy
 * @property {number}  timeoutMs    - Hard deadline per attempt (ms)
 * @property {number}  maxAttempts  - Max total attempts (1 = no retry)
 * @property {boolean} idempotent   - Whether safe to auto-retry on transient failure
 * @property {number}  baseDelayMs  - Initial backoff delay (ms)
 * @property {number}  maxDelayMs   - Backoff ceiling (ms)
 */

/**
 * Per-provider, per-operation policy registry.
 *
 * Structure: { [provider]: { [operation]: OperationPolicy } }
 * The special key '*' defines the fallback for any unknown operation
 * within that provider.
 */
const POLICIES = Object.freeze({

  // ── Stellar Horizon ─────────────────────────────────────────────────────────
  stellar: {
    // Read operations — idempotent, safe to retry
    getAccount: {
      timeoutMs: 8_000, maxAttempts: 3, idempotent: true,
      baseDelayMs: 1_000, maxDelayMs: 10_000,
    },
    getTransaction: {
      timeoutMs: 8_000, maxAttempts: 3, idempotent: true,
      baseDelayMs: 1_000, maxDelayMs: 10_000,
    },
    getTransactionsForAccount: {
      timeoutMs: 12_000, maxAttempts: 3, idempotent: true,
      baseDelayMs: 1_500, maxDelayMs: 15_000,
    },
    getAccountBalances: {
      timeoutMs: 8_000, maxAttempts: 3, idempotent: true,
      baseDelayMs: 1_000, maxDelayMs: 10_000,
    },
    getLedger: {
      timeoutMs: 8_000, maxAttempts: 3, idempotent: true,
      baseDelayMs: 1_000, maxDelayMs: 10_000,
    },
    getLatestLedger: {
      timeoutMs: 5_000, maxAttempts: 3, idempotent: true,
      baseDelayMs:   500, maxDelayMs:  5_000,
    },
    streamTransactions: {
      timeoutMs: 30_000, maxAttempts: 2, idempotent: true,
      baseDelayMs: 2_000, maxDelayMs: 20_000,
    },
    streamPayments: {
      timeoutMs: 30_000, maxAttempts: 2, idempotent: true,
      baseDelayMs: 2_000, maxDelayMs: 20_000,
    },
    // Write operation — NON-idempotent, must NOT be auto-retried
    submitTransaction: {
      timeoutMs: 20_000, maxAttempts: 1, idempotent: false,
      baseDelayMs:     0, maxDelayMs:      0,
    },
    // Default for any unknown Stellar operation
    '*': {
      timeoutMs: DEFAULT_TIMEOUT_MS, maxAttempts: DEFAULT_MAX_ATTEMPTS, idempotent: true,
      baseDelayMs: DEFAULT_BASE_DELAY_MS, maxDelayMs: DEFAULT_MAX_DELAY_MS,
    },
  },

  // ── CoinGecko price feed ────────────────────────────────────────────────────
  coingecko: {
    getPrice: {
      timeoutMs: 6_000, maxAttempts: 3, idempotent: true,
      baseDelayMs: 1_000, maxDelayMs: 8_000,
    },
    '*': {
      timeoutMs: 8_000, maxAttempts: 3, idempotent: true,
      baseDelayMs: 1_000, maxDelayMs: 10_000,
    },
  },

  // ── Coinbase price feed ─────────────────────────────────────────────────────
  coinbase: {
    getPrice: {
      timeoutMs: 6_000, maxAttempts: 3, idempotent: true,
      baseDelayMs: 1_000, maxDelayMs: 8_000,
    },
    '*': {
      timeoutMs: 8_000, maxAttempts: 3, idempotent: true,
      baseDelayMs: 1_000, maxDelayMs: 10_000,
    },
  },

  // ── Email providers ─────────────────────────────────────────────────────────
  // Email sends are treated as idempotent because providers deduplicate via
  // message IDs and a duplicate send results in a benign "already sent" bounce
  // rather than a double-charge.
  email: {
    send: {
      timeoutMs: 15_000, maxAttempts: 3, idempotent: true,
      baseDelayMs:   500, maxDelayMs: 30_000,
    },
    verify: {
      timeoutMs: 8_000, maxAttempts: 2, idempotent: true,
      baseDelayMs: 1_000, maxDelayMs:  5_000,
    },
    '*': {
      timeoutMs: 10_000, maxAttempts: 3, idempotent: true,
      baseDelayMs: 1_000, maxDelayMs: 15_000,
    },
  },

  // ── Twilio (SMS / WhatsApp) ─────────────────────────────────────────────────
  twilio: {
    sendSms: {
      timeoutMs: 10_000, maxAttempts: 2, idempotent: false,
      baseDelayMs:     0, maxDelayMs:      0,
    },
    sendWhatsApp: {
      timeoutMs: 10_000, maxAttempts: 2, idempotent: false,
      baseDelayMs:     0, maxDelayMs:      0,
    },
    '*': {
      timeoutMs: 10_000, maxAttempts: 1, idempotent: false,
      baseDelayMs:     0, maxDelayMs:      0,
    },
  },

  // ── Global fallback ─────────────────────────────────────────────────────────
  '*': {
    '*': {
      timeoutMs: DEFAULT_TIMEOUT_MS, maxAttempts: DEFAULT_MAX_ATTEMPTS, idempotent: true,
      baseDelayMs: DEFAULT_BASE_DELAY_MS, maxDelayMs: DEFAULT_MAX_DELAY_MS,
    },
  },
});

// ── API ───────────────────────────────────────────────────────────────────────

/**
 * Look up the policy for a provider + operation with optional environment variable overrides.
 * Falls back to the provider wildcard, then the global wildcard.
 *
 * Environment overrides:
 *   PROVIDER_<PROVIDER>_<OPERATION>_TIMEOUT_MS or PROVIDER_<PROVIDER>_TIMEOUT_MS
 *   PROVIDER_<PROVIDER>_<OPERATION>_MAX_ATTEMPTS or PROVIDER_<PROVIDER>_MAX_ATTEMPTS
 *
 * @param {string} provider  - e.g. 'stellar', 'coingecko', 'email'
 * @param {string} operation - e.g. 'getAccount', 'submitTransaction'
 * @returns {OperationPolicy}
 */
function getPolicy(provider, operation) {
  const providerPolicies = POLICIES[provider] || POLICIES['*'];
  const basePolicy = (
    providerPolicies[operation] ||
    providerPolicies['*'] ||
    POLICIES['*']['*']
  );

  const policy = {
    ...basePolicy,
    circuitBreaker: {
      enabled: true,
      failureThreshold: 5,
      resetTimeoutMs: 30000,
      ...(basePolicy.circuitBreaker || {}),
    },
  };

  // Environment overrides
  const provKey = String(provider).toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const opKey = String(operation).toUpperCase().replace(/[^A-Z0-9]/g, '_');

  const envTimeout = process.env[`PROVIDER_${provKey}_${opKey}_TIMEOUT_MS`] ||
                     process.env[`PROVIDER_${provKey}_TIMEOUT_MS`];
  if (envTimeout && !isNaN(parseInt(envTimeout, 10))) {
    policy.timeoutMs = parseInt(envTimeout, 10);
  }

  const envAttempts = process.env[`PROVIDER_${provKey}_${opKey}_MAX_ATTEMPTS`] ||
                      process.env[`PROVIDER_${provKey}_MAX_ATTEMPTS`];
  if (envAttempts && !isNaN(parseInt(envAttempts, 10))) {
    policy.maxAttempts = parseInt(envAttempts, 10);
  }

  return policy;
}

/**
 * Log configured policies at startup for observability.
 */
function logPolicies() {
  logger.info('[ProviderPolicyRegistry] Initialized provider timeout and retry policies', {
    defaults: {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      baseDelayMs: DEFAULT_BASE_DELAY_MS,
      maxDelayMs: DEFAULT_MAX_DELAY_MS,
    },
    providers: Object.keys(POLICIES).filter((k) => k !== '*'),
  });
}

/**
 * Wrap an async call with the policy's timeout and retry behaviour.
 *
 * - Applies a hard deadline per attempt using Promise.race with a timeout.
 * - Retries on any thrown error up to policy.maxAttempts IF the operation is
 *   idempotent (policy.idempotent === true).
 * - Never retries non-idempotent operations regardless of the error type.
 * - Records retry and timeout Prometheus metrics.
 *
 * @param {string}   provider   - Provider name (e.g. 'stellar')
 * @param {string}   operation  - Operation name (e.g. 'getAccount')
 * @param {function} fn         - Async factory that performs the call
 * @param {object}   [opts]
 * @param {object}   [opts.policy]  - Override the resolved policy for this call
 * @returns {Promise<*>}
 */
async function executeWithPolicy(provider, operation, fn, opts = {}) {
  _ensureMetrics();

  const policy = opts.policy || getPolicy(provider, operation);
  const maxAttempts = policy.idempotent ? policy.maxAttempts : 1;
  const label = `${provider}.${operation}`;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1 && _retriesCounter) {
      try { _retriesCounter.inc({ provider, operation }); } catch (_) {}
    }

    try {
      const result = await _withTimeout(fn, policy.timeoutMs, label);
      if (_callsCounter) {
        try { _callsCounter.inc({ provider, operation, outcome: 'success' }); } catch (_) {}
      }
      return result;
    } catch (err) {
      lastError = err;

      if (err.code === 'POLICY_TIMEOUT') {
        if (_timeoutsCounter) {
          try { _timeoutsCounter.inc({ provider, operation }); } catch (_) {}
        }
        if (_callsCounter) {
          try { _callsCounter.inc({ provider, operation, outcome: 'timeout' }); } catch (_) {}
        }
        logger.warn(`[PolicyRegistry] ${label} timed out after ${policy.timeoutMs}ms (attempt ${attempt}/${maxAttempts})`);
      } else {
        if (_callsCounter) {
          try { _callsCounter.inc({ provider, operation, outcome: 'failure' }); } catch (_) {}
        }
        logger.warn(`[PolicyRegistry] ${label} failed (attempt ${attempt}/${maxAttempts}): ${err.message}`);
      }

      // Non-idempotent: give up immediately
      if (!policy.idempotent) break;

      // Last attempt: give up
      if (attempt >= maxAttempts) break;

      // Exponential backoff with ±20% jitter before next attempt
      const delay = _backoff(attempt, policy.baseDelayMs, policy.maxDelayMs);
      if (delay > 0) await _sleep(delay);
    }
  }

  throw lastError;
}

/** @private */
async function _withTimeout(fn, timeoutMs, label) {
  if (!timeoutMs || timeoutMs <= 0) return fn();

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} exceeded timeout of ${timeoutMs}ms`);
      err.code = 'POLICY_TIMEOUT';
      reject(err);
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    clearTimeout(timer);
    return result;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/** @private */
function _backoff(attempt, baseMs, maxMs) {
  if (!baseMs) return 0;
  const base = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** @private */
function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  getPolicy,
  executeWithPolicy,
  logPolicies,
  POLICIES,
  // Exported for testing
  _withTimeout,
};
