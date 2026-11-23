'use strict';

const { Queue, Worker } = require('bullmq');
const Payment = require('../models/paymentModel');
const School = require('../models/schoolModel');
const PaymentReconciliationRun = require('../models/paymentReconciliationRunModel');
const { verifyTransaction } = require('./stellarService');
const { transition: transitionPayment } = require('./paymentTransitionService');
const { updateStudentBalance } = require('../utils/studentBalanceUpdater');
const { getRedisClient } = require('../config/redisClient');
const logger = require('../utils/logger').child('StuckPaymentReconciliation');
const { randomUUID } = require('crypto');

const STUCK_PAYMENT_THRESHOLD_MS = parseInt(process.env.STUCK_PAYMENT_THRESHOLD_MS, 10) || 10 * 60 * 1000;
const STUCK_PAYMENT_RECONCILIATION_INTERVAL_MS = parseInt(process.env.STUCK_PAYMENT_RECONCILIATION_INTERVAL_MS, 10) || 15 * 60 * 1000;
const STUCK_PAYMENT_RECONCILIATION_MAX_BATCH = parseInt(process.env.STUCK_PAYMENT_RECONCILIATION_MAX_BATCH, 10) || 100;
const configuredMismatchThreshold = Number(process.env.PAYMENT_RECONCILIATION_MISMATCH_RATE_THRESHOLD || 0.1);
const MISMATCH_RATE_THRESHOLD = Number.isFinite(configuredMismatchThreshold) && configuredMismatchThreshold >= 0 && configuredMismatchThreshold <= 1
  ? configuredMismatchThreshold
  : 0.1;
const QUEUE_NAME = 'payment-reconciliation';
const PERMANENT_PROVIDER_FAILURES = new Set([
  'TX_FAILED', 'INVALID_DESTINATION', 'UNSUPPORTED_ASSET', 'MISSING_MEMO',
  'UNSUPPORTED_MEMO_TYPE', 'AMOUNT_TOO_LOW', 'AMOUNT_TOO_HIGH', 'UNDERPAID',
]);

let reconciliationQueue = null;
let reconciliationWorker = null;

async function findStuckPayments(limit = STUCK_PAYMENT_RECONCILIATION_MAX_BATCH) {
  return Payment.find({
    status: 'SUBMITTED',
    submittedAt: { $lt: new Date(Date.now() - STUCK_PAYMENT_THRESHOLD_MS) },
    deletedAt: null,
  })
    .sort({ submittedAt: 1 })
    .limit(limit)
    .lean();
}

async function reconcileOne(payment, run) {
  const school = await School.findOne({ schoolId: payment.schoolId }).lean();
  if (!school?.stellarAddress) {
    run.errorCount++;
    return;
  }

  try {
    const verified = await verifyTransaction(payment.txHash, school.stellarAddress, payment.schoolId);
    if (verified.studentId !== payment.studentId) {
      run.mismatchCount++;
      run.errorCount++;
      logger.error('Payment reconciliation identity mismatch', {
        runId: run.runId,
        txHash: payment.txHash,
        paymentStudentId: payment.studentId,
        ledgerStudentId: verified.studentId,
      });
      return;
    }

    if (verified.feeValidation.status === 'underpaid') {
      const failed = await transitionPayment(await Payment.findById(payment._id), 'FAILED', {
        performedBy: 'scheduled-payment-reconciliation',
        schoolId: payment.schoolId,
        reason: verified.feeValidation.message,
        updates: { confirmationStatus: 'failed', suspicionReason: verified.feeValidation.message },
      });
      run.mismatchCount++;
      if (failed.ok) run.reconciledCount++;
      return;
    }

    const current = await Payment.findById(payment._id);
    const result = await transitionPayment(current, 'SUCCESS', {
      performedBy: 'scheduled-payment-reconciliation',
      schoolId: payment.schoolId,
      reason: 'Provider and Stellar ledger confirmed the payment',
      emitPaymentSaved: true,
      updates: {
        amount: verified.amount,
        feeAmount: verified.feeAmount,
        feeValidationStatus: verified.feeValidation.status,
        excessAmount: verified.feeValidation.excessAmount,
        assetCode: verified.assetCode,
        assetType: verified.assetType,
        senderAddress: verified.senderAddress,
        confirmationStatus: 'confirmed',
        confirmedAt: verified.date ? new Date(verified.date) : new Date(),
        verifiedAt: new Date(),
        ledgerSequence: verified.ledger,
      },
    });

    if (result.ok && !result.unchanged) {
      run.mismatchCount++;
      run.reconciledCount++;
      await updateStudentBalance(payment.schoolId, payment.studentId);
    } else {
      run.matchedCount++;
    }
  } catch (error) {
    if (!PERMANENT_PROVIDER_FAILURES.has(error.code)) {
      run.errorCount++;
      logger.warn('Provider lookup failed during payment reconciliation', {
        runId: run.runId,
        txHash: payment.txHash,
        code: error.code,
        error: error.message,
      });
      return;
    }

    const failed = await transitionPayment(await Payment.findById(payment._id), 'FAILED', {
      performedBy: 'scheduled-payment-reconciliation',
      schoolId: payment.schoolId,
      reason: error.message,
      updates: { confirmationStatus: 'failed', suspicionReason: error.message },
    });
    run.mismatchCount++;
    if (failed.ok) run.reconciledCount++;
  }
}

async function reconcileStuckPayments() {
  const run = await PaymentReconciliationRun.create({
    runId: randomUUID(),
    status: 'running',
    startedAt: new Date(),
    mismatchThreshold: MISMATCH_RATE_THRESHOLD,
  });
  let lastId = null;

  try {
    while (true) {
      const query = {
        status: 'SUBMITTED',
        submittedAt: { $lt: new Date(Date.now() - STUCK_PAYMENT_THRESHOLD_MS) },
        deletedAt: null,
        ...(lastId ? { _id: { $gt: lastId } } : {}),
      };
      const payments = await Payment.find(query)
        .sort({ _id: 1 })
        .limit(STUCK_PAYMENT_RECONCILIATION_MAX_BATCH)
        .lean();
      if (!payments.length) break;

      for (const payment of payments) {
        run.scannedCount++;
        try {
          await reconcileOne(payment, run);
        } catch (error) {
          run.errorCount++;
          logger.error('Payment reconciliation failed', {
            runId: run.runId,
            txHash: payment.txHash,
            error: error.message,
          });
        }
      }
      lastId = payments[payments.length - 1]._id;
      await PaymentReconciliationRun.findByIdAndUpdate(run._id, {
        scannedCount: run.scannedCount,
        matchedCount: run.matchedCount,
        mismatchCount: run.mismatchCount,
        reconciledCount: run.reconciledCount,
        errorCount: run.errorCount,
      });
      if (payments.length < STUCK_PAYMENT_RECONCILIATION_MAX_BATCH) break;
    }

    run.mismatchRate = run.scannedCount ? run.mismatchCount / run.scannedCount : 0;
    run.status = 'completed';
    run.completedAt = new Date();
    await run.save();

    const { paymentReconciliationMismatchRate, paymentReconciliationMismatchThreshold } = require('../metrics');
    paymentReconciliationMismatchRate.set(run.mismatchRate);
    paymentReconciliationMismatchThreshold.set(run.mismatchThreshold);
    if (run.mismatchRate > run.mismatchThreshold) {
      logger.error('Payment reconciliation mismatch rate exceeded threshold', {
        runId: run.runId,
        mismatchRate: run.mismatchRate,
        threshold: run.mismatchThreshold,
      });
    }

    logger.info('Scheduled payment reconciliation completed', {
      runId: run.runId,
      scannedCount: run.scannedCount,
      matchedCount: run.matchedCount,
      mismatchCount: run.mismatchCount,
      reconciledCount: run.reconciledCount,
      errorCount: run.errorCount,
      mismatchRate: run.mismatchRate,
    });
    return run.toObject();
  } catch (error) {
    run.status = 'failed';
    run.errorMessage = error.message;
    run.completedAt = new Date();
    await run.save();
    throw error;
  }
}

function startStuckPaymentReconciliationScheduler() {
  if (reconciliationWorker) return;
  const connection = getRedisClient();
  if (!connection) {
    logger.warn('Scheduled reconciliation unavailable because Redis is not configured');
    return;
  }

  reconciliationQueue = new Queue(QUEUE_NAME, { connection });
  reconciliationWorker = new Worker(QUEUE_NAME, reconcileStuckPayments, {
    connection,
    concurrency: 1,
  });
  reconciliationWorker.on('failed', (job, error) => {
    logger.error('Scheduled payment reconciliation job failed', {
      jobId: job?.id,
      error: error.message,
    });
  });

  reconciliationQueue.add('scheduled-reconciliation', {}, {
    jobId: 'scheduled-payment-reconciliation',
    repeat: { every: STUCK_PAYMENT_RECONCILIATION_INTERVAL_MS },
    removeOnComplete: { age: 3600, count: 10 },
    removeOnFail: false,
  }).catch((error) => logger.error('Failed to schedule payment reconciliation', { error: error.message }));
  logger.info('BullMQ payment reconciliation schedule started', {
    intervalMs: STUCK_PAYMENT_RECONCILIATION_INTERVAL_MS,
    ageThresholdMs: STUCK_PAYMENT_THRESHOLD_MS,
  });
}

function stopStuckPaymentReconciliationScheduler() {
  const closing = [];
  if (reconciliationWorker) closing.push(reconciliationWorker.close());
  if (reconciliationQueue) closing.push(reconciliationQueue.close());
  reconciliationWorker = null;
  reconciliationQueue = null;
  Promise.allSettled(closing).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') logger.warn('Failed to close reconciliation queue', { error: result.reason?.message });
    }
  });
}

module.exports = {
  reconcileStuckPayments,
  findStuckPayments,
  STUCK_PAYMENT_THRESHOLD_MS,
  STUCK_PAYMENT_RECONCILIATION_INTERVAL_MS,
  startStuckPaymentReconciliationScheduler,
  stopStuckPaymentReconciliationScheduler,
};
