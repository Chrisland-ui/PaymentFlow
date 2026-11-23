'use strict';

/**
 * providerCircuitBreakerRegistry — centralized per-provider circuit breakers.
 *
 * Maintains named CircuitBreaker instances for every external provider the
 * application integrates with. Consumers call `getBreaker(name)` to obtain
 * the breaker for their provider, then wrap calls with the standard
 * isAvailable / recordSuccess / recordFailure API.
 *
 * Providers registered here:
 *   stellar_horizon   — Primary Stellar Horizon API (note: individual endpoint
 *                       CBs inside HorizonFailoverClient are a finer grain;
 *                       this registry provides a global view)
 *   coingecko         — CoinGecko price feed
 *   coinbase          — Coinbase price feed (fallback)
 *   email_smtp        — SMTP email provider
 *   email_ses         — AWS SES email provider
 *   email_sendgrid    — SendGrid email provider
 *
 * Prometheus metrics (lazily registered to survive Jest module resets):
 *   provider_circuit_breaker_state{provider}   — 0=closed, 1=open, 2=half_open
 *   provider_circuit_breaker_failures{provider} — consecutive failure counter
 *   provider_circuit_breaker_transitions_total{provider, from_state, to_state}
 *
 * Environment variables (optional overrides per-provider):
 *   CB_FAILURE_THRESHOLD         default: 5
 *   CB_RESET_TIMEOUT_MS          default: 30000
 *   CB_SUCCESS_THRESHOLD         default: 2
 *
 * Usage:
 *   const { getBreaker, getAllStatuses } = require('./providerCircuitBreakerRegistry');
 *
 *   const cb = getBreaker('email_smtp');
 *   if (!cb.isAvailable()) throw new Error('email_smtp circuit is open');
 *   try {
 *     await provider.send(msg);
 *     cb.recordSuccess();
 *   } catch (err) {
 *     cb.recordFailure();
 *     throw err;
 *   }
 */

const { CircuitBreaker, CB_STATE } = require('../utils/circuitBreaker');
const logger = require('../utils/logger');

// ── Thresholds (env-configurable, shared by all providers unless overridden) ─
const DEFAULT_FAILURE_THRESHOLD   = parseInt(process.env.CB_FAILURE_THRESHOLD,  10) || 5;
const DEFAULT_RESET_TIMEOUT_MS    = parseInt(process.env.CB_RESET_TIMEOUT_MS,   10) || 30_000;
const DEFAULT_SUCCESS_THRESHOLD   = parseInt(process.env.CB_SUCCESS_THRESHOLD,  10) || 2;

// ── Prometheus metrics (lazily created) ──────────────────────────────────────
let _cbStateGauge;
let _cbFailuresGauge;
let _cbTransitionsCounter;

function _ensureMetrics() {
  let metricsModule;
  try {
    metricsModule = require('../metrics');
  } catch (_) {
    return; // metrics unavailable in test / early-boot context
  }
  if (!metricsModule) return;

  const client = require('prom-client');
  const { registry } = metricsModule;

  if (!_cbStateGauge) {
    _cbStateGauge = new client.Gauge({
      name:       'provider_circuit_breaker_state',
      help:       'Circuit-breaker state per provider: 0=closed 1=open 2=half_open',
      labelNames: ['provider'],
      registers:  [registry],
    });
  }
  if (!_cbFailuresGauge) {
    _cbFailuresGauge = new client.Gauge({
      name:       'provider_circuit_breaker_failures',
      help:       'Consecutive failure count per provider circuit breaker',
      labelNames: ['provider'],
      registers:  [registry],
    });
  }
  if (!_cbTransitionsCounter) {
    _cbTransitionsCounter = new client.Counter({
      name:       'provider_circuit_breaker_transitions_total',
      help:       'Number of circuit-breaker state transitions per provider',
      labelNames: ['provider', 'from_state', 'to_state'],
      registers:  [registry],
    });
  }
}

// ── Registry ─────────────────────────────────────────────────────────────────

/** @type {Map<string, CircuitBreaker>} */
const _breakers = new Map();

/**
 * Names of all providers that are pre-registered on startup.
 * Additional providers can be added at any time via registerBreaker().
 */
const PROVIDER_NAMES = Object.freeze([
  'stellar_horizon',
  'coingecko',
  'coinbase',
  'email_smtp',
  'email_ses',
  'email_sendgrid',
]);

/**
 * Build a state-change callback that updates Prometheus metrics and logs.
 * @private
 */
function _makeOnStateChange(providerName) {
  return function onStateChange(oldState, newState) {
    logger.info('[ProviderCircuitBreakerRegistry] State transition', {
      provider:  providerName,
      from:      oldState,
      to:        newState,
    });

    try {
      _ensureMetrics();
      if (_cbTransitionsCounter) {
        _cbTransitionsCounter.inc({ provider: providerName, from_state: oldState, to_state: newState });
      }
      if (_cbStateGauge) {
        const stateNum = newState === CB_STATE.CLOSED ? 0
          : newState === CB_STATE.OPEN ? 1 : 2;
        _cbStateGauge.set({ provider: providerName }, stateNum);
      }
    } catch (_) {
      // Never let a metrics error break the circuit-breaker callback
    }
  };
}

/**
 * Register (or re-register) a named circuit breaker.
 *
 * @param {string} providerName   - Unique provider identifier
 * @param {object} [opts]         - Same opts as CircuitBreaker constructor
 */
function registerBreaker(providerName, opts = {}) {
  const cb = new CircuitBreaker(providerName, {
    failureThreshold:   opts.failureThreshold   || DEFAULT_FAILURE_THRESHOLD,
    resetTimeoutMs:     opts.resetTimeoutMs     || DEFAULT_RESET_TIMEOUT_MS,
    successThreshold:   opts.successThreshold   || DEFAULT_SUCCESS_THRESHOLD,
    onStateChange:      _makeOnStateChange(providerName),
    ...opts,
  });
  _breakers.set(providerName, cb);

  // Initialize Prometheus gauge for this provider
  try {
    _ensureMetrics();
    if (_cbStateGauge)    _cbStateGauge.set({ provider: providerName }, 0); // start closed
    if (_cbFailuresGauge) _cbFailuresGauge.set({ provider: providerName }, 0);
  } catch (_) {}

  return cb;
}

/**
 * Get the CircuitBreaker for a named provider.
 * Creates one with default config if it does not yet exist.
 *
 * @param {string} providerName
 * @returns {CircuitBreaker}
 */
function getBreaker(providerName) {
  if (!_breakers.has(providerName)) {
    logger.warn('[ProviderCircuitBreakerRegistry] Unknown provider — creating with defaults', { providerName });
    return registerBreaker(providerName);
  }
  return _breakers.get(providerName);
}

/**
 * Return a snapshot of all registered breakers' states.
 * Suitable for the /health endpoint and admin dashboards.
 *
 * @returns {object[]} Array of { provider, state, failures, timeUntilRetryMs }
 */
function getAllStatuses() {
  const statuses = [];
  for (const [providerName, cb] of _breakers.entries()) {
    statuses.push({
      provider:          providerName,
      state:             cb.getState(),
      failures:          cb.getFailures(),
      timeUntilRetryMs:  cb.getTimeUntilRetry(),
    });
  }
  return statuses;
}

/**
 * Wrap an async operation with circuit-breaker protection.
 *
 * Automatically calls isAvailable(), recordSuccess(), and recordFailure().
 * Updates the failures gauge on each call.
 *
 * @param {string}          providerName
 * @param {function}        fn           - Async function to protect
 * @param {object}          [opts]
 * @param {string}          [opts.errorCode='ERR_PROVIDER_CIRCUIT_OPEN'] - code for open-circuit error
 * @returns {Promise<*>}
 */
async function withBreaker(providerName, fn, opts = {}) {
  const cb = getBreaker(providerName);

  if (!cb.isAvailable()) {
    const err = new Error(`${providerName} circuit breaker is open — failing fast`);
    err.code  = opts.errorCode || 'ERR_PROVIDER_CIRCUIT_OPEN';
    err.provider = providerName;
    throw err;
  }

  try {
    const result = await fn();
    cb.recordSuccess();
    _updateFailuresGauge(providerName, cb);
    return result;
  } catch (err) {
    cb.recordFailure();
    _updateFailuresGauge(providerName, cb);
    throw err;
  }
}

/** @private */
function _updateFailuresGauge(providerName, cb) {
  try {
    if (_cbFailuresGauge) {
      _cbFailuresGauge.set({ provider: providerName }, cb.getFailures());
    }
  } catch (_) {}
}

/**
 * Return a structured health summary suitable for the /health endpoint.
 *
 * allHealthy is false when any provider circuit breaker is OPEN — callers
 * should surface this as 'degraded' status on the health endpoint so on-call
 * engineers know a provider is down without having to check Prometheus.
 *
 * @returns {{
 *   allHealthy: boolean,
 *   openCount: number,
 *   halfOpenCount: number,
 *   providers: Array<{ provider: string, state: string, failures: number, timeUntilRetryMs: number }>
 * }}
 */
function getHealthSummary() {
  const statuses = getAllStatuses();
  const openBreakers    = statuses.filter((s) => s.state === CB_STATE.OPEN);
  const halfOpenBreakers = statuses.filter((s) => s.state === CB_STATE.HALF_OPEN);
  return {
    allHealthy:    openBreakers.length === 0,
    openCount:     openBreakers.length,
    halfOpenCount: halfOpenBreakers.length,
    providers:     statuses,
  };
}

// ── Initialise all pre-defined providers ─────────────────────────────────────
for (const name of PROVIDER_NAMES) {
  registerBreaker(name);
}

module.exports = {
  getBreaker,
  registerBreaker,
  getAllStatuses,
  getHealthSummary,
  withBreaker,
  PROVIDER_NAMES,
  // Exported for testing
  _breakers,
};
