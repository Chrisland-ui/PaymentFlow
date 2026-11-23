'use strict';

/**
 * PendingApproval — persists multisig approval state for high-risk operations.
 *
 * A PendingApproval document tracks an operation that requires sign-off from
 * at least `requiredSigners` distinct principals before it executes.  The
 * default threshold is 2-of-3 (two approvals out of three authorised signers).
 *
 * Fields:
 *   operationType  — 'pause' | 'unpause' | 'upgrade'
 *   proposedBy     — identity of the admin who proposed the operation
 *   payload        — operation-specific data (e.g. { newVersionHash } for upgrade)
 *   reason         — human-readable justification supplied by the proposer
 *   approvals      — array of { signerId, approvedAt } — distinct signers who approved
 *   rejections     — array of { signerId, rejectedAt, reason } — signers who rejected
 *   requiredSigners— quorum threshold (default 2)
 *   status         — 'pending' | 'approved' | 'rejected' | 'executed' | 'expired'
 *   expiresAt      — hard deadline; unexecuted approvals past this are rejected
 *   executedAt     — when the underlying operation was actually applied
 *   ipAddress      — proposer's IP
 *   userAgent      — proposer's user-agent
 */

const mongoose = require('mongoose');

const approvalEntrySchema = new mongoose.Schema(
  {
    signerId:   { type: String, required: true },
    approvedAt: { type: Date,   required: true },
  },
  { _id: false },
);

const rejectionEntrySchema = new mongoose.Schema(
  {
    signerId:   { type: String, required: true },
    rejectedAt: { type: Date,   required: true },
    reason:     { type: String, default: null },
  },
  { _id: false },
);

const pendingApprovalSchema = new mongoose.Schema(
  {
    operationType: {
      type:     String,
      enum:     ['pause', 'unpause', 'upgrade'],
      required: true,
      index:    true,
    },
    proposedBy: { type: String, required: true },
    payload:    { type: mongoose.Schema.Types.Mixed, default: {} },
    reason:     { type: String, default: null },

    approvals:  { type: [approvalEntrySchema],   default: [] },
    rejections: { type: [rejectionEntrySchema],  default: [] },

    requiredSigners: { type: Number, default: 2, min: 1 },

    status: {
      type:    String,
      enum:    ['pending', 'approved', 'rejected', 'executed', 'expired'],
      default: 'pending',
      index:   true,
    },

    expiresAt:  { type: Date, required: true, index: true },
    executedAt: { type: Date, default: null },

    ipAddress:  { type: String, default: null },
    userAgent:  { type: String, default: null },
  },
  { timestamps: true },
);

// Compound index for efficient lookup of open approvals by type
pendingApprovalSchema.index({ operationType: 1, status: 1 });

// TTL — Mongoose/MongoDB will automatically remove expired documents
// 7 days after expiresAt so the collection does not grow unbounded.
// Note: MongoDB's TTL index fires once per minute, so docs may linger
// briefly beyond expiresAt.
pendingApprovalSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

/**
 * Return true if this approval has reached quorum.
 */
pendingApprovalSchema.methods.hasQuorum = function () {
  return this.approvals.length >= this.requiredSigners;
};

/**
 * Return true if a given signerId has already voted (approved or rejected).
 */
pendingApprovalSchema.methods.hasVoted = function (signerId) {
  return (
    this.approvals.some((a) => a.signerId === signerId) ||
    this.rejections.some((r) => r.signerId === signerId)
  );
};

module.exports = mongoose.model('PendingApproval', pendingApprovalSchema);
