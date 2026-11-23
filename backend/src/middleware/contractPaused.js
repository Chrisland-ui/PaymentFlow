'use strict';

/**
 * contractPaused — Express middleware that rejects state-changing requests
 * while the contract is in the emergency-paused state.
 *
 * Apply this middleware to any route that modifies payment, student, fee, or
 * dispute state.  Read-only GET endpoints, health checks, metrics, and auth
 * routes are intentionally NOT guarded so operators can still inspect the
 * system while it is paused.
 *
 * Response shape when paused:
 *   HTTP 503
 *   { "error": "...", "code": "CONTRACT_PAUSED" }
 *
 * Usage:
 *   const { contractPaused } = require('../middleware/contractPaused');
 *   router.post('/verify', contractPaused, verifyPayment);
 */

const { isContractPaused } = require('../services/contractPauseService');
const logger = require('../utils/logger').child('ContractPaused');

async function contractPaused(req, res, next) {
  try {
    const paused = await isContractPaused();
    if (!paused) return next();

    logger.warn('Request rejected — contract is paused', {
      method: req.method,
      path: req.path,
      schoolId: req.schoolId || null,
    });

    return res.status(503).json({
      error:
        'The payment contract is currently paused due to an emergency. ' +
        'No state-changing operations are permitted. ' +
        'Please contact the platform administrator.',
      code: 'CONTRACT_PAUSED',
    });
  } catch (err) {
    // If the pause-state check itself throws (e.g. transient DB error), log
    // the failure but let the request through — failing open is preferable to
    // taking the whole service down during a DB blip.
    logger.error('Failed to read contract-pause state; allowing request', {
      error: err.message,
    });
    return next();
  }
}

module.exports = { contractPaused };
