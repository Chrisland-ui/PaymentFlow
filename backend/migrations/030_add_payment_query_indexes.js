'use strict';

/**
 * Migration 030 — Add targeted compound indexes for payment, audit, student,
 * and pending-verification query performance (Issue #39).
 *
 * Target queries and the indexes that serve them:
 *
 *   payments
 *   ─────────────────────────────────────────────────────────────────────────
 *   getAllPayments with status filter
 *     → { schoolId:1, status:1, deletedAt:1 }
 *
 *   getOverpayments  (feeValidationStatus = 'overpaid', not deleted)
 *     → { schoolId:1, feeValidationStatus:1, deletedAt:1 }
 *       (extends the single-field { schoolId, feeValidationStatus } index to
 *       avoid a separate deletedAt scan step)
 *
 *   getStudentPayments sorted by confirmedAt, excluding deleted
 *     → { schoolId:1, studentId:1, deletedAt:1, confirmedAt:-1 }
 *       (supersedes the existing { schoolId, studentId, confirmedAt } index
 *       for queries that include deletedAt:null in the filter)
 *
 *   auditlogs
 *   ─────────────────────────────────────────────────────────────────────────
 *   getAuditLogs filtered by result field
 *     → { schoolId:1, result:1, createdAt:-1 }
 *       (performedBy and action compound indexes already exist in the model)
 *
 *   students
 *   ─────────────────────────────────────────────────────────────────────────
 *   getAllStudents list (not deleted, sorted by createdAt)
 *     → { schoolId:1, deletedAt:1, createdAt:-1 }
 *
 *   pendingverifications
 *   ─────────────────────────────────────────────────────────────────────────
 *   getPendingPayments by school + status
 *     → { schoolId:1, status:1, createdAt:1 }
 *       (the existing { schoolId, status, nextRetryAt } covers the retry
 *       worker; this index covers the admin list endpoint which sorts by
 *       createdAt)
 *
 * Write overhead analysis
 * ─────────────────────────────────────────────────────────────────────────────
 * Each index adds ~1–5 ms write latency and ~100–500 bytes storage per
 * document depending on field cardinality.  These are all non-unique indexes
 * on moderate-cardinality fields; the overhead is expected to be low.
 * Payments are write-infrequent (one record per blockchain transaction), so
 * the indexes on the payments collection carry minimal operational cost.
 * Full analysis in docs/payment-query-indexes.md.
 */

const mongoose = require('mongoose');

const VERSION = '030_add_payment_query_indexes';

// ── Helper — idempotent index creation ────────────────────────────────────────

async function createIndexIfMissing(collection, keySpec, options, label) {
  const existing = await collection.indexes().catch((err) => {
    if (err.code === 26) return []; // collection does not exist yet
    throw err;
  });

  const alreadyExists = existing.some((idx) => {
    const idxKeys = Object.keys(idx.key);
    const wantKeys = Object.keys(keySpec);
    if (idxKeys.length !== wantKeys.length) return false;
    return wantKeys.every((k) => idx.key[k] === keySpec[k]);
  });

  if (!alreadyExists) {
    await collection.createIndex(keySpec, { background: true, ...options });
    console.log(`[030] Created index ${label}`);
  } else {
    console.log(`[030] Index ${label} already exists — skipping`);
  }
}

async function dropIndexIfExists(collection, keySpec, label) {
  try {
    await collection.dropIndex(keySpec);
    console.log(`[030] Dropped index ${label}`);
  } catch (err) {
    if (err.code === 27 || err.code === 26) {
      console.log(`[030] Index ${label} not found — skipping drop`);
    } else {
      throw err;
    }
  }
}

// ── up ────────────────────────────────────────────────────────────────────────

async function up() {
  const db = mongoose.connection.db;

  // ── payments ──────────────────────────────────────────────────────────────
  const payments = db.collection('payments');

  await createIndexIfMissing(
    payments,
    { schoolId: 1, status: 1, deletedAt: 1 },
    {},
    '{ schoolId, status, deletedAt } on payments',
  );

  await createIndexIfMissing(
    payments,
    { schoolId: 1, feeValidationStatus: 1, deletedAt: 1 },
    {},
    '{ schoolId, feeValidationStatus, deletedAt } on payments',
  );

  await createIndexIfMissing(
    payments,
    { schoolId: 1, studentId: 1, deletedAt: 1, confirmedAt: -1 },
    {},
    '{ schoolId, studentId, deletedAt, confirmedAt } on payments',
  );

  // ── auditlogs ─────────────────────────────────────────────────────────────
  const auditlogs = db.collection('auditlogs');

  await createIndexIfMissing(
    auditlogs,
    { schoolId: 1, result: 1, createdAt: -1 },
    {},
    '{ schoolId, result, createdAt } on auditlogs',
  );

  // ── students ──────────────────────────────────────────────────────────────
  const students = db.collection('students');

  await createIndexIfMissing(
    students,
    { schoolId: 1, deletedAt: 1, createdAt: -1 },
    {},
    '{ schoolId, deletedAt, createdAt } on students',
  );

  // ── pendingverifications ──────────────────────────────────────────────────
  const pv = db.collection('pendingverifications');

  await createIndexIfMissing(
    pv,
    { schoolId: 1, status: 1, createdAt: 1 },
    {},
    '{ schoolId, status, createdAt } on pendingverifications',
  );
}

// ── down ──────────────────────────────────────────────────────────────────────

async function down() {
  const db = mongoose.connection.db;

  const payments = db.collection('payments');
  await dropIndexIfExists(payments, { schoolId: 1, status: 1, deletedAt: 1 }, '{ schoolId, status, deletedAt } on payments');
  await dropIndexIfExists(payments, { schoolId: 1, feeValidationStatus: 1, deletedAt: 1 }, '{ schoolId, feeValidationStatus, deletedAt } on payments');
  await dropIndexIfExists(payments, { schoolId: 1, studentId: 1, deletedAt: 1, confirmedAt: -1 }, '{ schoolId, studentId, deletedAt, confirmedAt } on payments');

  const auditlogs = db.collection('auditlogs');
  await dropIndexIfExists(auditlogs, { schoolId: 1, result: 1, createdAt: -1 }, '{ schoolId, result, createdAt } on auditlogs');

  const students = db.collection('students');
  await dropIndexIfExists(students, { schoolId: 1, deletedAt: 1, createdAt: -1 }, '{ schoolId, deletedAt, createdAt } on students');

  const pv = db.collection('pendingverifications');
  await dropIndexIfExists(pv, { schoolId: 1, status: 1, createdAt: 1 }, '{ schoolId, status, createdAt } on pendingverifications');
}

module.exports = { version: VERSION, up, down };
