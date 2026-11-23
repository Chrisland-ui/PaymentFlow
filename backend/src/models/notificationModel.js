'use strict';

const mongoose = require('mongoose');

/**
 * Notification model — stores in-app notifications scoped to a school (tenant).
 *
 * TTL: Documents expire automatically after 30 days via a MongoDB TTL index on createdAt.
 * (Issue #362 — "Retain the last 30 days of notifications per user")
 *
 * Supported notification types (Issue #362):
 *   - payment.confirmed  — a payment has been confirmed on-chain
 *   - payment.failed     — payment verification failed
 *   - dispute.created    — a new dispute was opened
 *   - dispute.updated    — a dispute's status changed
 *   - report.ready       — a report has been generated and is ready for download
 *   - system.alert       — a system-wide alert (e.g. maintenance, sync lag)
 *
 * Security:
 *   - schoolId is the tenant scope; all queries MUST include it.
 *   - metadata must NOT store txHash, wallet addresses, or PII beyond studentId.
 */
const notificationSchema = new mongoose.Schema(
  {
    // Tenant isolation — every query MUST include schoolId
    schoolId: {
      type: String,
      required: true,
      index: true,
    },

    type: {
      type: String,
      enum: [
        'payment.confirmed',
        'payment.failed',
        'dispute.created',
        'dispute.updated',
        'report.ready',
        'system.alert',
      ],
      required: true,
    },

    severity: {
      type: String,
      enum: ['info', 'warning', 'critical'],
      required: true,
    },

    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },

    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },

    // Optional deep-link URL for navigation (e.g. /dashboard?student=STU001)
    deepLink: {
      type: String,
      default: null,
      trim: true,
    },

    read: {
      type: Boolean,
      default: false,
    },

    readAt: {
      type: Date,
      default: null,
    },

    // TTL field — MongoDB will expire documents 30 days after createdAt
    createdAt: {
      type: Date,
      default: Date.now,
    },

    // Arbitrary context data — must NOT contain txHash, wallet addresses, or PII
    // beyond studentId. Use for UI hints (e.g. { studentId, amount, assetCode }).
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    // Disable automatic timestamps since we manage createdAt manually for TTL
    timestamps: false,
  }
);

// TTL index: automatically remove notifications older than 30 days (Issue #362)
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// Compound indexes for common access patterns
notificationSchema.index({ schoolId: 1, createdAt: -1 });
notificationSchema.index({ schoolId: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
