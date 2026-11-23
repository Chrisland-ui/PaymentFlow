'use strict';

const mongoose = require('mongoose');

const paymentReconciliationRunSchema = new mongoose.Schema({
  runId: { type: String, required: true, unique: true, index: true },
  status: { type: String, enum: ['running', 'completed', 'failed'], required: true, index: true },
  startedAt: { type: Date, required: true, index: true },
  completedAt: { type: Date, default: null },
  scannedCount: { type: Number, default: 0 },
  matchedCount: { type: Number, default: 0 },
  mismatchCount: { type: Number, default: 0 },
  reconciledCount: { type: Number, default: 0 },
  errorCount: { type: Number, default: 0 },
  mismatchRate: { type: Number, default: 0 },
  mismatchThreshold: { type: Number, required: true },
  errorMessage: { type: String, default: null },
}, { timestamps: true });

paymentReconciliationRunSchema.index({ startedAt: -1 });
paymentReconciliationRunSchema.index({ status: 1, startedAt: -1 });

module.exports = mongoose.model('PaymentReconciliationRun', paymentReconciliationRunSchema);