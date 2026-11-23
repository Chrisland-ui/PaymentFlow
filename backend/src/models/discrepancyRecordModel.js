'use strict';

const mongoose = require('mongoose');
const tenantScope = require('../plugins/tenantScope');

/**
 * DiscrepancyRecord — a single reviewable mismatch found by the provider
 * reconciliation job.
 *
 * Design constraints (Issue #33):
 *  - Never auto-overwrites protected financial data (Payment, Student).
 *  - Operators review records here first; corrections must be applied manually.
 *  - Protected fields (payment amounts, feePaid, totalPaid) are immutable once
 *    written. The job only appends new records, never updates existing ones.
 *
 * Discrepancy types:
 *  - AMOUNT_MISMATCH   — local Payment.amount differs from on-chain amount
 *  - MISSING_LOCAL     — on-chain tx exists but no local Payment record
 *  - MISSING_ONCHAIN   — local SUCCESS Payment has no matching on-chain tx
 *  - STATUS_MISMATCH   — local status differs from on-chain finality
 */
const discrepancyRecordSchema = new mongoose.Schema(
  {
    // Which reconciliation job run produced this record (ISO date string of
    // the run's rangeStart / rangeEnd window).
    jobRunId: { type: String, required: true, index: true },

    schoolId:  { type: String, required: true, index: true },

    /** Stellar transaction hash (64-char hex). */
    txHash: {
      type:  String,
      match: /^[a-f0-9]{64}$/,
      index: true,
    },

    /** Student ID extracted from the transaction memo, if present. */
    studentId: { type: String, index: true },

    discrepancyType: {
      type: String,
      enum: ['AMOUNT_MISMATCH', 'MISSING_LOCAL', 'MISSING_ONCHAIN', 'STATUS_MISMATCH'],
      required: true,
      index: true,
    },

    /** Amount as recorded in the local Payment document (null if no local record). */
    localAmount: { type: Number, default: null },

    /** Amount as read from the Stellar ledger (null if on-chain tx not found). */
    chainAmount: { type: Number, default: null },

    /** Local payment status at the time the discrepancy was detected. */
    localStatus: { type: String, default: null },

    /** Structured details for operator review — never contains PII or secrets. */
    details: { type: mongoose.Schema.Types.Mixed, default: {} },

    /**
     * Review workflow:
     *  pending   — awaiting operator action
     *  reviewed  — operator has acknowledged and will correct manually
     *  dismissed — operator determined it is a false positive
     */
    reviewStatus: {
      type:    String,
      enum:    ['pending', 'reviewed', 'dismissed'],
      default: 'pending',
      index:   true,
    },

    reviewedBy: { type: String, default: null },
    reviewedAt: { type: Date,   default: null },
    reviewNote: { type: String, default: null },
  },
  {
    timestamps: true,
  }
);

// Unique index: one record per (schoolId, txHash, discrepancyType) per run.
// Prevents the job from creating duplicate records on a re-run of the same
// window — satisfying the idempotency requirement.
discrepancyRecordSchema.index(
  { jobRunId: 1, schoolId: 1, txHash: 1, discrepancyType: 1 },
  { unique: true, sparse: true }
);

discrepancyRecordSchema.index({ schoolId: 1, reviewStatus: 1, createdAt: -1 });

// TTL: auto-expire dismissed records after 90 days to prevent unbounded growth.
// Pending and reviewed records are not expired — operators must explicitly act.
discrepancyRecordSchema.index(
  { reviewedAt: 1 },
  {
    expireAfterSeconds: 90 * 24 * 60 * 60,
    partialFilterExpression: { reviewStatus: 'dismissed' },
  }
);

discrepancyRecordSchema.plugin(tenantScope, { modelName: 'DiscrepancyRecord' });

module.exports = mongoose.model('DiscrepancyRecord', discrepancyRecordSchema);
