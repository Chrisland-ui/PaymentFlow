"use strict";

const Payment = require("../models/paymentModel");
const Outbox = require("../models/outboxModel");
const { generateReferenceCode } = require("../utils/generateReferenceCode");
const logger = require("../utils/logger").child("TransactionService");
const paymentEvents = require("../events/paymentEvents");
const { v4: uuidv4 } = require("uuid");

/**
 * Write concern for financial writes ensuring durability across replica set failover.
 * Uses 'majority' write concern to guarantee writes are acknowledged by a majority
 * of replica set members, preventing data loss on primary failure.
 */
const FINANCIAL_WRITE_CONCERN = { w: 'majority', wtimeout: 5000 };

/**
 * Persist a payment record, idempotently keyed on (schoolId, txHash).
 *
 * Idempotency is guaranteed by the unique compound DB index {schoolId, txHash}.
 * We rely on that constraint directly instead of a findOne pre-check, which has a
 * TOCTOU race window between concurrent poller/verify paths processing the same tx.
 * When the DB rejects a duplicate (error 11000) we throw DUPLICATE_TX so callers
 * can handle it as a normal idempotency case rather than an unexpected error.
 *
 * Side effects (webhooks, receipts, etc) are recorded in the outbox and processed
 * asynchronously by the outbox dispatcher, ensuring atomic writes with at-least-once
 * delivery guarantees.
 *
 * Throws DUPLICATE_TX if the transaction was already recorded by any concurrent path.
 */
async function savePayment(data, options = {}) {
  const { session = null } = options;

  if (!data.referenceCode) {
    data = { ...data, referenceCode: await generateReferenceCode() };
  }
  try {
    const payment = new Payment(data);
    await payment.save(session ? { session } : {});

    const eventId = uuidv4();
    const outboxEvent = new Outbox({
      eventId,
      eventType: "payment.saved",
      aggregateId: payment.txHash,
      aggregateType: "payment",
      payload: payment.toObject(),
    });
    await outboxEvent.save(session ? { session } : {});

    logger.debug("Payment saved with outbox event", {
      txHash: payment.txHash,
      correlationId: payment.correlationId,
      schoolId: payment.schoolId,
    });

    return payment;
  } catch (e) {
    if (e.code === 11000) {
      if (options.allowFailedReplay) {
        const replayedPayment = await Payment.findOneAndUpdate(
          { schoolId: data.schoolId, txHash: data.txHash, status: 'FAILED' },
          { $set: data },
          { new: true, runValidators: true, session },
        );
        if (replayedPayment) {
          await Outbox.create({
            eventId: uuidv4(),
            eventType: 'payment.saved',
            aggregateId: replayedPayment.txHash,
            aggregateType: 'payment',
            payload: replayedPayment.toObject(),
          }, { session, writeConcern: FINANCIAL_WRITE_CONCERN });
          return replayedPayment;
        }
      }
      const txHash = data.txHash || data.transactionHash;
      const err = new Error(`Transaction ${txHash} has already been processed`);
      err.code = "DUPLICATE_TX";
      logger.warn("Duplicate transaction rejected (concurrent path)", {
        txHash,
        correlationId: data.correlationId,
        schoolId: data.schoolId,
      });
      throw err;
    }
    logger.error("Failed to record payment", {
      error: e.message,
      txHash: data.txHash || data.transactionHash,
      correlationId: data.correlationId,
      schoolId: data.schoolId,
    });
    throw e;
  }
}

/**
 * Retrieve all payments for a given student within a specific school, sorted by most recent first.
 * schoolId is required to prevent cross-tenant data leaks: studentId is only unique per school,
 * so two different schools can legitimately share the same studentId value.
 * @param {string} schoolId - Required tenant scope.
 * @param {string} studentId - Student identifier within the school.
 */
async function getPaymentsByStudent(schoolId, studentId) {
  if (!schoolId) {
    const err = new Error('schoolId is required for getPaymentsByStudent');
    err.code = 'MISSING_SCHOOL_ID';
    throw err;
  }
  return Payment.find({ schoolId, studentId, deletedAt: null }).sort({ confirmedAt: -1 }).lean();
}

module.exports = { savePayment, getPaymentsByStudent };
