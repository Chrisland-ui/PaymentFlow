'use strict';

/**
 * paymentTransitionService — domain service for explicit payment status transitions.
 *
 * This is the single authoritative path for all payment status changes. It:
 *   1. Validates the transition is legal using the canonical transition tables
 *      in constants/paymentStatus.js (Issue #72 / #32).
 *   2. Applies the change and audit entry in one MongoDB transaction, so
 *      concurrent transitions serialize and cannot leave an unaudited status.
 *   3. Writes a structured audit entry (actor, before, after, reason, result).
 *   4. Returns { ok: true, payment, previousStatus }; invalid transitions throw
 *      InvalidTransitionError for callers to handle explicitly.
 *
 * Illegal transitions throw InvalidTransitionError. Infrastructure failures
 * (DB errors etc.) are also thrown for the normal error handler.
 *
 * Usage:
 *   const { transition } = require('./paymentTransitionService');
 *
 *   const result = await transition(payment, 'REFUNDED', {
 *     adminOverride: true,
 *     reason:        'Manual correction after reconciliation',
 *     performedBy:   req.auditContext?.performedBy,
 *     schoolId:      req.schoolId,
 *     ipAddress:     req.auditContext?.ipAddress,
 *     userAgent:     req.auditContext?.userAgent,
 *   });
 *
 *   if (!result.ok) {
 *     return res.status(400).json({ error: result.error, code: result.code });
 *   }
 */

const mongoose = require('mongoose');
const {
  PAYMENT_STATUS,
  PAYMENT_STATUS_TRANSITIONS,
  ADMIN_PAYMENT_STATUS_TRANSITIONS,
  isTransitionAllowed,
} = require('../constants/paymentStatus');
const { logAudit } = require('./auditService');
const logger = require('../utils/logger');
const Outbox = require('../models/outboxModel');
const { randomUUID } = require('crypto');

class InvalidTransitionError extends Error {
  constructor(fromStatus, toStatus) {
    super(`Cannot transition payment from ${fromStatus} to ${toStatus}`);
    this.name = 'InvalidTransitionError';
    this.code = 'INVALID_TRANSITION';
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

/**
 * Attempt a payment status transition and persist the result.
 *
 * @param {object} payment        - Mongoose Payment document (not a lean object)
 * @param {string} toStatus       - Target PAYMENT_STATUS value
 * @param {object} opts
 * @param {boolean} [opts.adminOverride=false] - Allow admin-only transitions
 * @param {string}  [opts.reason]       - Human-readable reason (required for audit)
 * @param {string}  [opts.performedBy]  - Actor identifier (email or userId)
 * @param {string}  [opts.schoolId]     - School scoping for audit entry
 * @param {string}  [opts.ipAddress]    - Request IP for audit entry
 * @param {string}  [opts.userAgent]    - User-Agent header for audit entry
 *
 * @returns {Promise<{ok: true, payment: object, previousStatus: string}
 *                 | {ok: false, error: string, code: string}>}
 */
async function transition(payment, toStatus, opts = {}) {
  const {
    adminOverride = false,
    reason        = null,
    performedBy   = 'unknown',
    schoolId      = payment.schoolId,
    ipAddress     = null,
    userAgent     = null,
  } = opts;

  const txHash = payment.txHash;
  if (!toStatus || !Object.values(PAYMENT_STATUS).includes(toStatus)) {
    throw new InvalidTransitionError(payment.status, toStatus);
  }
  if (toStatus === PAYMENT_STATUS.PENDING) {
    throw new InvalidTransitionError(payment.status, toStatus);
  }

  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      let current = await payment.constructor.findOne({ _id: payment._id, schoolId }).session(session);
      if (!current && payment.isNew) {
        const initialState = { ...payment.toObject(), ...(opts.initialUpdates || {}), status: payment.status || PAYMENT_STATUS.PENDING };
        [current] = await payment.constructor.create([initialState], { session });
      }
      if (!current) {
        const error = new Error('Payment not found');
        error.code = 'NOT_FOUND';
        throw error;
      }

      const fromStatus = current.status;
      if (fromStatus === toStatus) {
        result = { ok: true, payment: current, previousStatus: fromStatus, unchanged: true };
        return;
      }
      if (!isTransitionAllowed(fromStatus, toStatus, adminOverride)) {
        throw new InvalidTransitionError(fromStatus, toStatus);
      }

      current.set(opts.updates || {});
      current.status = toStatus;
      if (adminOverride) {
        current.$locals = current.$locals || {};
        current.$locals.adminOverride = true;
      }
      await current.save({ session });

      await logAudit({
        schoolId,
        action: 'payment_status_transition',
        performedBy,
        targetId: current.txHash || txHash || String(current._id),
        targetType: 'payment',
        details: {
          before: { status: fromStatus },
          after: { status: toStatus },
          reason: reason || null,
          adminOverride: !!adminOverride,
          transitionedAt: new Date().toISOString(),
        },
        result: 'success',
        ipAddress,
        userAgent,
        session,
        throwOnFailure: true,
      });

      if (opts.emitPaymentSaved) {
        await Outbox.create([{
          eventId: randomUUID(),
          eventType: 'payment.saved',
          aggregateId: current.txHash,
          aggregateType: 'payment',
          payload: current.toObject(),
        }], { session });
      }

      result = { ok: true, payment: current, previousStatus: fromStatus };
    });
    return result;
  } catch (error) {
    if (error instanceof InvalidTransitionError) {
      await _auditFailure(schoolId, txHash, error.fromStatus, toStatus, reason, performedBy, error.message, ipAddress, userAgent);
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

/**
 * Write a failure audit entry for a rejected transition (no secret values).
 * Internal helper — never throws.
 * @private
 */
async function _auditFailure(schoolId, txHash, from, to, reason, performedBy, errorMessage, ipAddress, userAgent) {
  try {
    await logAudit({
      schoolId,
      action:      'payment_status_transition',
      performedBy: performedBy || 'unknown',
      targetId:    txHash || 'unknown',
      targetType:  'payment',
      details: {
        from,
        to,
        reason: reason || null,
        rejected: true,
      },
      result:       'failure',
      errorMessage,
      ipAddress,
      userAgent,
    });
  } catch (auditErr) {
    logger.error('[PaymentTransitionService] Failed to write rejection audit entry', {
      error: auditErr.message,
    });
  }
}

/**
 * Convenience wrapper for a pre-fetched txHash.
 * Looks up the payment by txHash + schoolId, runs the transition, and returns
 * the envelope. Callers that already hold the Mongoose document should use
 * `transition()` directly.
 *
 * @param {object} Payment - Mongoose model (injected to avoid circular deps)
 * @param {string} txHash
 * @param {string} toStatus
 * @param {object} opts - same as transition()
 * @returns {Promise<{ok: true, payment, previousStatus}|{ok: false, error, code}>}
 */
async function transitionByHash(Payment, txHash, toStatus, opts = {}) {
  const { schoolId } = opts;
  const payment = await Payment.findOne({ schoolId, txHash });
  if (!payment) {
    return { ok: false, error: 'Payment not found', code: 'NOT_FOUND' };
  }
  return transition(payment, toStatus, opts);
}

module.exports = { transition, transitionByHash, InvalidTransitionError };
