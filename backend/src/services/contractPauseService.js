'use strict';

/**
 * contractPauseService — emergency circuit-breaker for all state-changing
 * payment operations.
 *
 * The pause flag is stored in SystemConfig under the key 'contractPaused'.
 * Reads are served from an in-process TTL cache (100 ms) so that the hot
 * path (every state-changing request) makes at most one DB round-trip per
 * 100 ms rather than one per request.
 *
 * All mutations go through logAudit so there is a tamper-evident record of
 * who paused/unpaused the contract and when.
 */

const mongoose = require('mongoose');
const SystemConfig = require('../models/systemConfigModel');
const { logAudit } = require('./auditService');
const logger = require('../utils/logger').child('ContractPause');

const CONFIG_KEY = 'contractPaused';

// ── In-process read cache ─────────────────────────────────────────────────────
// Avoids a DB round-trip on every inbound request while keeping the lag short
// enough that a pause is effective within 100 ms across all in-flight requests.
let _cache = null;      // { value: bool, expiresAt: number }
const CACHE_TTL_MS = 100;

function _invalidateCache() {
  _cache = null;
}

async function _readFromDb() {
  const raw = await SystemConfig.get(CONFIG_KEY);
  return raw === true;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return true if the contract is currently paused.
 * Bypasses the cache when the DB connection is not ready (test environments).
 */
async function isContractPaused() {
  // Skip cache + DB when mongoose is not connected — avoids blocking in tests.
  if (mongoose.connection?.readyState !== 1) return false;

  const now = Date.now();
  if (_cache && _cache.expiresAt > now) {
    return _cache.value;
  }

  const paused = await _readFromDb();
  _cache = { value: paused, expiresAt: now + CACHE_TTL_MS };
  return paused;
}

/**
 * Pause all state-changing contract operations.
 *
 * @param {object} opts
 * @param {string} opts.performedBy  - identity of the actor (email or userId)
 * @param {string} opts.ipAddress    - source IP
 * @param {string} [opts.userAgent]  - source user-agent
 * @param {string} [opts.reason]     - human-readable reason for the pause
 */
async function pauseContract({ performedBy, ipAddress, userAgent, reason } = {}) {
  await SystemConfig.set(CONFIG_KEY, true);
  _invalidateCache();

  logger.warn('Contract paused', { performedBy, reason });

  await logAudit({
    schoolId: 'system',
    action: 'contract_pause',
    performedBy: performedBy || 'unknown',
    targetId: CONFIG_KEY,
    targetType: 'system_config',
    details: { reason: reason || null },
    result: 'success',
    ipAddress: ipAddress || null,
    userAgent: userAgent || null,
  });
}

/**
 * Resume all state-changing contract operations.
 *
 * @param {object} opts
 * @param {string} opts.performedBy  - identity of the actor
 * @param {string} opts.ipAddress    - source IP
 * @param {string} [opts.userAgent]  - source user-agent
 * @param {string} [opts.reason]     - human-readable reason for unpausing
 */
async function unpauseContract({ performedBy, ipAddress, userAgent, reason } = {}) {
  await SystemConfig.set(CONFIG_KEY, false);
  _invalidateCache();

  logger.info('Contract unpaused', { performedBy, reason });

  await logAudit({
    schoolId: 'system',
    action: 'contract_unpause',
    performedBy: performedBy || 'unknown',
    targetId: CONFIG_KEY,
    targetType: 'system_config',
    details: { reason: reason || null },
    result: 'success',
    ipAddress: ipAddress || null,
    userAgent: userAgent || null,
  });
}

/**
 * Read the current pause state directly from the database (no cache).
 * Used by the admin status endpoint to return authoritative state.
 */
async function getContractPauseStatus() {
  if (mongoose.connection?.readyState !== 1) {
    return { paused: false, source: 'disconnected' };
  }
  const paused = await _readFromDb();
  return { paused, source: 'database' };
}

// Exposed for tests only — resets the in-process cache
function _resetCacheForTest() {
  _cache = null;
}

module.exports = {
  isContractPaused,
  pauseContract,
  unpauseContract,
  getContractPauseStatus,
  _resetCacheForTest,
};
