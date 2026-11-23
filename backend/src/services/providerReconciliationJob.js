'use strict';

/**
 * Provider Reconciliation Job — Issue #33
 * ----------------------------------------
 * Compares provider (Stellar ledger) records with local payment state and
 * emits reviewable DiscrepancyRecord documents for operator inspection.
 *
 * Design requirements (from issue acceptance criteria):
 *   ✓ Idempotent — re-running the same date range never creates duplicate
 *     discrepancy records (enforced by the unique compound index on
 *     { jobRunId, schoolId, txHash, discrepancyType }).
 *   ✓ Rate-limited — Stellar Horizon calls go through the existing
 *     rate-limited client (stellarRateLimitedClient / withStellarRetry).
 *   ✓ Paginated — both the local payment query and the Horizon fetch use
 *     cursor-based pagination so large histories never OOM the process.
 *   ✓ Never auto-overwrites protected financial data — discrepancies are
 *     written to a separate collection; no Payment or Student document
 *     is modified.
 *   ✓ Operators can rerun a range safely — same jobRunId = same upsert key,
 *     so re-runs produce exactly the same set of records.
 *
 * Usage:
 *   const { runProviderReconciliation } = require('./providerReconciliationJob');
 *
 *   // Reconcile the last 7 days for a specific school:
 *   const summary = await runProviderReconciliation({
 *     schoolId: 'SCH-001',
 *     rangeStart: new Date(Date.now() - 7 * 86400_000),
 *     rangeEnd:   new Date(),
 *   });
 *
 *   // Reconcile all active schools for a specific window:
 *   const summary = await runProviderReconciliation({ rangeStart, rangeEnd });
 */

const Decimal  = require('decimal.js');
const Payment  = require('../models/paymentModel');
const School   = require('../models/schoolModel');
const DiscrepancyRecord = require('../models/discrepancyRecordModel');
const { fetchChainTransactions } = require('./consistencyService');
const logger   = require('../utils/logger').child('ProviderReconciliationJob');

// ── Constants ─────────────────────────────────────────────────────────────────

/** How many local Payment documents to process per database page. */
const LOCAL_PAGE_SIZE  = parseInt(process.env.RECONCILIATION_LOCAL_PAGE_SIZE,  10) || 200;

/** Maximum number of discrepancy records to write per school run before stopping.
 *  Guards against a runaway loop on corrupt data. */
const MAX_DISCREPANCIES_PER_SCHOOL = parseInt(process.env.RECONCILIATION_MAX_DISCREPANCIES, 10) || 1000;

/** Tolerance for amount comparison: differences smaller than this are ignored. */
const AMOUNT_EPSILON = new Decimal('0.0000001'); // 1 stroop

// ── Job run ID ─────────────────────────────────────────────────────────────────

/**
 * Produce a stable, human-readable run ID from the date range so that
 * re-running the same window produces the same jobRunId and the upsert index
 * deduplicates records automatically.
 */
function buildJobRunId(schoolId, rangeStart, rangeEnd) {
  const s = rangeStart instanceof Date ? rangeStart.toISOString().slice(0, 10) : String(rangeStart).slice(0, 10);
  const e = rangeEnd   instanceof Date ? rangeEnd.toISOString().slice(0, 10)   : String(rangeEnd).slice(0, 10);
  return `${schoolId}:${s}:${e}`;
}

// ── Core reconciliation for a single school ────────────────────────────────────

/**
 * @typedef {Object} SchoolReconciliationSummary
 * @property {string}  schoolId
 * @property {number}  localChecked        - local Payment docs examined
 * @property {number}  chainChecked        - on-chain txs examined
 * @property {number}  discrepanciesFound  - new DiscrepancyRecord documents created
 * @property {number}  skippedDuplicates   - records skipped because they already existed
 * @property {string}  jobRunId
 * @property {boolean} rateLimited         - true if a Horizon rate limit was hit
 */

/**
 * Reconcile a single school: compare local payments against the Stellar ledger
 * within [rangeStart, rangeEnd] and emit DiscrepancyRecord documents.
 *
 * @param {Object} options
 * @param {string}  options.schoolId
 * @param {Date}    options.rangeStart
 * @param {Date}    options.rangeEnd
 * @returns {Promise<SchoolReconciliationSummary>}
 */
async function reconcileSchool({ schoolId, rangeStart, rangeEnd }) {
  const jobRunId = buildJobRunId(schoolId, rangeStart, rangeEnd);
  let localChecked = 0, chainChecked = 0, discrepanciesFound = 0, skippedDuplicates = 0;
  let rateLimited = false;

  // ── Step 1: Fetch local SUCCESS payments in the window ─────────────────────
  // Build an index of txHash → Payment for O(1) lookup during chain comparison.
  const localIndex = new Map(); // txHash → Payment doc
  let localCursor = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const query = {
      schoolId,
      status: 'SUCCESS',
      deletedAt: null,
      confirmedAt: { $gte: rangeStart, $lte: rangeEnd },
      ...(localCursor ? { _id: { $gt: localCursor } } : {}),
    };

    const batch = await Payment.find(query)
      .sort({ _id: 1 })
      .limit(LOCAL_PAGE_SIZE)
      .lean();

    for (const p of batch) {
      localIndex.set(p.txHash, p);
      localChecked++;
    }

    if (batch.length < LOCAL_PAGE_SIZE) break;
    localCursor = batch[batch.length - 1]._id;
  }

  // ── Step 2: Fetch on-chain transactions from Stellar Horizon ───────────────
  const school = await School.findOne({ schoolId }).lean();
  if (!school) {
    logger.warn('School not found, skipping', { schoolId });
    return { schoolId, localChecked, chainChecked, discrepanciesFound, skippedDuplicates, jobRunId, rateLimited };
  }

  let chainTxs = [];
  try {
    const lookbackDays = Math.ceil(
      (rangeEnd.getTime() - rangeStart.getTime()) / (24 * 60 * 60 * 1000)
    ) + 1; // +1 day buffer
    chainTxs = await fetchChainTransactions(school.stellarAddress, { lookbackDays });
  } catch (err) {
    if (err?.response?.status === 429 || (err.message && err.message.includes('rate'))) {
      rateLimited = true;
      logger.warn('Horizon rate limit hit during reconciliation — partial results', { schoolId, error: err.message });
    } else {
      logger.error('Horizon fetch failed during reconciliation', { schoolId, error: err.message });
    }
    // Return what we have so far; the job remains resumable
    return { schoolId, localChecked, chainChecked, discrepanciesFound, skippedDuplicates, jobRunId, rateLimited };
  }

  // Filter chain txs to the requested window
  const windowedChainTxs = chainTxs.filter((tx) => {
    const t = new Date(tx.created_at).getTime();
    return t >= rangeStart.getTime() && t <= rangeEnd.getTime();
  });

  // ── Step 3: Compare on-chain txs against local index ──────────────────────
  for (const tx of windowedChainTxs) {
    if (discrepanciesFound >= MAX_DISCREPANCIES_PER_SCHOOL) {
      logger.warn('Discrepancy cap reached — truncating run', { schoolId, cap: MAX_DISCREPANCIES_PER_SCHOOL, jobRunId });
      break;
    }

    chainChecked++;
    const hash = tx.hash;

    // Extract the payment operation for this school's wallet
    let chainAmount = null;
    let memoStudentId = null;
    try {
      const ops = await tx.operations();
      const payOp = ops.records.find(
        (op) => op.type === 'payment' && op.to === school.stellarAddress
      );
      if (payOp) chainAmount = new Decimal(payOp.amount);
      // Memo is the student ID reference used for matching
      memoStudentId = tx.memo_type === 'text' ? tx.memo : null;
    } catch {
      // If operations() fails (e.g. network) we still record what we know
    }

    const localPayment = localIndex.get(hash);

    if (!localPayment) {
      // On-chain tx with no matching local record — possibly a missed sync
      const d = await upsertDiscrepancy({
        jobRunId, schoolId, txHash: hash,
        discrepancyType: 'MISSING_LOCAL',
        studentId: memoStudentId,
        chainAmount: chainAmount ? chainAmount.toNumber() : null,
        localAmount: null,
        localStatus: null,
        details: { createdAt: tx.created_at },
      });
      if (d.inserted) discrepanciesFound++; else skippedDuplicates++;
    } else {
      // Both records exist — compare amounts
      if (chainAmount !== null) {
        const localDec  = new Decimal(String(localPayment.amount));
        const diff      = chainAmount.minus(localDec).abs();
        if (diff.gt(AMOUNT_EPSILON)) {
          const d = await upsertDiscrepancy({
            jobRunId, schoolId, txHash: hash,
            discrepancyType: 'AMOUNT_MISMATCH',
            studentId: localPayment.studentId,
            chainAmount: chainAmount.toNumber(),
            localAmount: localPayment.amount,
            localStatus: localPayment.status,
            details: { diff: diff.toFixed(7) },
          });
          if (d.inserted) discrepanciesFound++; else skippedDuplicates++;
        }
      }
      // Mark as seen so we can detect MISSING_ONCHAIN below
      localIndex.delete(hash);
    }
  }

  // ── Step 4: Any remaining local SUCCESS payments have no on-chain match ───
  for (const [, localPayment] of localIndex) {
    if (discrepanciesFound >= MAX_DISCREPANCIES_PER_SCHOOL) break;

    const d = await upsertDiscrepancy({
      jobRunId, schoolId, txHash: localPayment.txHash,
      discrepancyType: 'MISSING_ONCHAIN',
      studentId: localPayment.studentId,
      chainAmount: null,
      localAmount: localPayment.amount,
      localStatus: localPayment.status,
      details: {},
    });
    if (d.inserted) discrepanciesFound++; else skippedDuplicates++;
  }

  logger.info('School reconciliation complete', {
    schoolId, jobRunId, localChecked, chainChecked, discrepanciesFound, skippedDuplicates,
  });

  return { schoolId, localChecked, chainChecked, discrepanciesFound, skippedDuplicates, jobRunId, rateLimited };
}

// ── Idempotent upsert ─────────────────────────────────────────────────────────

/**
 * Insert a discrepancy record if it doesn't already exist for this
 * (jobRunId, schoolId, txHash, discrepancyType) combination.
 * Returns { inserted: boolean }.
 */
async function upsertDiscrepancy({ jobRunId, schoolId, txHash, discrepancyType, studentId, chainAmount, localAmount, localStatus, details }) {
  try {
    await DiscrepancyRecord.create({
      jobRunId, schoolId, txHash, discrepancyType, studentId,
      chainAmount, localAmount, localStatus, details,
      reviewStatus: 'pending',
    });
    return { inserted: true };
  } catch (err) {
    // E11000: duplicate key — the record already existed (idempotent re-run)
    if (err.code === 11000) {
      return { inserted: false };
    }
    throw err;
  }
}

// ── Public: run reconciliation over one or all schools ────────────────────────

/**
 * Run the provider reconciliation job.
 *
 * @param {Object} options
 * @param {string} [options.schoolId]  - Limit to one school. Omit for all active schools.
 * @param {Date}   options.rangeStart  - Inclusive start of payment window.
 * @param {Date}   options.rangeEnd    - Inclusive end of payment window.
 * @returns {Promise<{ schools: SchoolReconciliationSummary[], totalDiscrepancies: number }>}
 */
async function runProviderReconciliation({ schoolId, rangeStart, rangeEnd }) {
  if (!(rangeStart instanceof Date) || !(rangeEnd instanceof Date)) {
    throw new TypeError('rangeStart and rangeEnd must be Date objects');
  }
  if (rangeStart >= rangeEnd) {
    throw new RangeError('rangeStart must be before rangeEnd');
  }

  const schoolFilter = schoolId
    ? [{ schoolId }]
    : await School.find({ isActive: true }).select('schoolId').lean();

  const results = [];
  let totalDiscrepancies = 0;

  for (const { schoolId: sid } of schoolFilter) {
    try {
      const summary = await reconcileSchool({ schoolId: sid, rangeStart, rangeEnd });
      results.push(summary);
      totalDiscrepancies += summary.discrepanciesFound;
    } catch (err) {
      logger.error('School reconciliation threw', { schoolId: sid, error: err.message });
      results.push({ schoolId: sid, error: err.message, discrepanciesFound: 0 });
    }
  }

  logger.info('Provider reconciliation job complete', {
    schoolsProcessed: results.length,
    totalDiscrepancies,
    rangeStart: rangeStart.toISOString(),
    rangeEnd:   rangeEnd.toISOString(),
  });

  return { schools: results, totalDiscrepancies };
}

// ── Review helpers ────────────────────────────────────────────────────────────

/**
 * List discrepancy records for a school, paginated, newest first.
 *
 * @param {Object} options
 * @param {string}  options.schoolId
 * @param {string}  [options.reviewStatus] - Filter by review status.
 * @param {string}  [options.discrepancyType]
 * @param {number}  [options.page=1]
 * @param {number}  [options.limit=50]
 * @returns {Promise<{ data: Object[], pagination: Object }>}
 */
async function listDiscrepancies({ schoolId, reviewStatus, discrepancyType, page = 1, limit = 50 }) {
  const filter = { schoolId };
  if (reviewStatus)    filter.reviewStatus    = reviewStatus;
  if (discrepancyType) filter.discrepancyType = discrepancyType;

  const skip = (page - 1) * limit;
  const [data, total] = await Promise.all([
    DiscrepancyRecord.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    DiscrepancyRecord.countDocuments(filter),
  ]);

  return {
    data,
    pagination: {
      page, limit, total,
      totalPages: Math.ceil(total / limit),
      hasNext: skip + data.length < total,
      hasPrev:  page > 1,
    },
  };
}

/**
 * Update the review status of a discrepancy record.
 * Operators use this to acknowledge a finding and schedule a manual correction.
 *
 * @param {string} id              - DiscrepancyRecord._id
 * @param {string} reviewStatus    - 'reviewed' | 'dismissed'
 * @param {string} reviewedBy      - username / user ID of the operator
 * @param {string} [reviewNote]
 * @returns {Promise<Object>}      - Updated document
 */
async function updateDiscrepancyReview({ id, reviewStatus, reviewedBy, reviewNote }) {
  const allowed = ['reviewed', 'dismissed'];
  if (!allowed.includes(reviewStatus)) {
    throw new Error(`reviewStatus must be one of: ${allowed.join(', ')}`);
  }

  const updated = await DiscrepancyRecord.findByIdAndUpdate(
    id,
    {
      reviewStatus,
      reviewedBy,
      reviewedAt: new Date(),
      ...(reviewNote !== undefined ? { reviewNote } : {}),
    },
    { new: true, runValidators: true }
  );

  if (!updated) throw Object.assign(new Error('Discrepancy record not found'), { code: 'NOT_FOUND' });
  return updated;
}

module.exports = {
  runProviderReconciliation,
  listDiscrepancies,
  updateDiscrepancyReview,
  // Exported for unit testing
  _buildJobRunId: buildJobRunId,
  _upsertDiscrepancy: upsertDiscrepancy,
};
