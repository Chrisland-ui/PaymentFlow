'use strict';

/**
 * ImportJob model.
 *
 * Tracks the lifecycle and progress of a background bulk-import job.
 * Records are automatically purged after 24 hours via a TTL index so
 * the collection stays bounded even with frequent imports.
 *
 * Lifecycle:
 *   pending    — job accepted, not yet started
 *   processing — job is actively processing rows
 *   completed  — all rows processed (some may have failed)
 *   failed     — job itself failed before completing (e.g. DB error)
 */

const mongoose = require('mongoose');

const importJobSchema = new mongoose.Schema(
  {
    jobId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    schoolId: {
      type: String,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
    },
    // Total rows in the uploaded file (set after parsing)
    totalRows: {
      type: Number,
      default: 0,
    },
    // Rows processed so far (updated incrementally)
    processedRows: {
      type: Number,
      default: 0,
    },
    createdRows: {
      type: Number,
      default: 0,
    },
    failedRows: {
      type: Number,
      default: 0,
    },
    // Per-row errors (capped to avoid unbounded growth)
    errors: [
      {
        row: { type: Number },
        studentId: { type: String, default: null },
        field: { type: String, default: null },
        error: { type: String },
        code: { type: String },
        _id: false,
      },
    ],
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    // Error message when status = 'failed'
    failureReason: { type: String, default: null },
    // TTL: auto-delete 24 hours after creation
    createdAt: { type: Date, default: Date.now, expires: 86400 },
  },
  { versionKey: false }
);

/**
 * Progress percentage (0–100) derived from processedRows / totalRows.
 * Returns 0 when totalRows is not yet known.
 */
importJobSchema.virtual('progressPercent').get(function () {
  if (!this.totalRows) return 0;
  return Math.round((this.processedRows / this.totalRows) * 100);
});

module.exports = mongoose.model('ImportJob', importJobSchema);
