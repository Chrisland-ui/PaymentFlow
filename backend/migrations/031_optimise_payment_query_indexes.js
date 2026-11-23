'use strict';

/**
 * Migration 031 — Optimise compound indexes for additional payment query
 * patterns identified during the Issue #287 index audit.
 *
 * Background
 * ───────────
 * Migration 030 covered the six most obvious query patterns.  After profiling
 * the remaining top-20 payment queries with explain() the following patterns
 * were found to lack proper index coverage:
 *
 *   1. Suspicious-payment list  (dashboard + admin review)
 *      Filter:  { schoolId, isSuspicious: true, deletedAt: null }
 *      Sort:    { createdAt: -1 }
 *      Gap:     existing { schoolId, isSuspicious } single-field index forces
 *               a post-index deletedAt filter step on every result document.
 *
 *   2. Confirmation-state reconciliation sweep  (startup + scheduled job)
 *      Filter:  { schoolId, confirmationState: <non-terminal> }
 *      Sort:    { createdAt: -1 }
 *      Gap:     single-field { confirmationState } index cannot satisfy the
 *               schoolId equality prefix, triggering a full-index scan.
 *
 *   3. Asset-based report aggregation  (report service)
 *      Filter:  { schoolId, assetCode: 'XLM'|'USDC', deletedAt: null }
 *      Sort:    { confirmedAt: -1 }
 *      Gap:     no compound index exists; query falls back to a collection scan
 *               filtered in memory.
 *
 *   4. Dashboard compound query  (paymentQueryController.getSummary)
 *      Filter:  { schoolId, status, confirmedAt: { $gte, $lte } }
 *      Covered: { schoolId, status, confirmedAt } partial index (model-level)
 *               already exists but excludes soft-deleted documents via a
 *               partial filter on deletedAt.  The dashboard query also slices
 *               by feeValidationStatus in a $facet stage that reads ALL
 *               matching documents; the partial index is not used for that
 *               facet branch.  Adding feeValidationStatus as a trailing field
 *               allows MongoDB to satisfy both branches from one index.
 *
 *   5. Fiat-currency report  (reportService.generatePaymentReport with
 *      fiatCurrency filter)
 *      Filter:  { schoolId, 'fiatSnapshot.fiatCurrency': 'USD', deletedAt: null }
 *      Sort:    { confirmedAt: -1 }
 *      Gap:     dotted-path field has no compound index.
 *
 * Write overhead analysis
 * ───────────────────────
 * Payments are written once per on-chain transaction (low-frequency relative
 * to reads).  Each new index adds roughly 1–3 ms write latency and 100–200
 * bytes storage per document.  Total estimated index size increase across a
 * 1 M document corpus: < 5 %.  Well within the 20 % budget stipulated by
 * the acceptance criteria.
 *
 * Full index strategy documented in docs/payment-query-indexes.md.
 */

const mongoose = require('mongoose');

const VERSION = '031_optimise_payment_query_indexes';

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
    console.log(`[031] Created index ${label}`);
  } else {
    console.log(`[031] Index ${label} already exists — skipping`);
  }
}

async function dropIndexIfExists(collection, keySpec, label) {
  try {
    await collection.dropIndex(keySpec);
    console.log(`[031] Dropped index ${label}`);
  } catch (err) {
    if (err.code === 27 || err.code === 26) {
      console.log(`[031] Index ${label} not found — skipping drop`);
    } else {
      throw err;
    }
  }
}

// ── up ────────────────────────────────────────────────────────────────────────

async function up() {
  const db = mongoose.connection.db;
  const payments = db.collection('payments');

  // 1. Suspicious-payment list with soft-delete filter
  await createIndexIfMissing(
    payments,
    { schoolId: 1, isSuspicious: 1, deletedAt: 1, createdAt: -1 },
    {},
    '{ schoolId, isSuspicious, deletedAt, createdAt } on payments',
  );

  // 2. Confirmation-state reconciliation sweep
  await createIndexIfMissing(
    payments,
    { schoolId: 1, confirmationState: 1, createdAt: -1 },
    {},
    '{ schoolId, confirmationState, createdAt } on payments',
  );

  // 3. Asset-based report aggregation
  await createIndexIfMissing(
    payments,
    { schoolId: 1, assetCode: 1, deletedAt: 1, confirmedAt: -1 },
    {},
    '{ schoolId, assetCode, deletedAt, confirmedAt } on payments',
  );

  // 4. Dashboard compound query covering feeValidationStatus facet
  await createIndexIfMissing(
    payments,
    { schoolId: 1, status: 1, feeValidationStatus: 1, confirmedAt: -1 },
    {},
    '{ schoolId, status, feeValidationStatus, confirmedAt } on payments',
  );

  // 5. Fiat-currency report filter
  await createIndexIfMissing(
    payments,
    { schoolId: 1, 'fiatSnapshot.fiatCurrency': 1, deletedAt: 1, confirmedAt: -1 },
    {},
    "{ schoolId, 'fiatSnapshot.fiatCurrency', deletedAt, confirmedAt } on payments",
  );
}

// ── down ──────────────────────────────────────────────────────────────────────

async function down() {
  const db = mongoose.connection.db;
  const payments = db.collection('payments');

  await dropIndexIfExists(
    payments,
    { schoolId: 1, isSuspicious: 1, deletedAt: 1, createdAt: -1 },
    '{ schoolId, isSuspicious, deletedAt, createdAt } on payments',
  );

  await dropIndexIfExists(
    payments,
    { schoolId: 1, confirmationState: 1, createdAt: -1 },
    '{ schoolId, confirmationState, createdAt } on payments',
  );

  await dropIndexIfExists(
    payments,
    { schoolId: 1, assetCode: 1, deletedAt: 1, confirmedAt: -1 },
    '{ schoolId, assetCode, deletedAt, confirmedAt } on payments',
  );

  await dropIndexIfExists(
    payments,
    { schoolId: 1, status: 1, feeValidationStatus: 1, confirmedAt: -1 },
    '{ schoolId, status, feeValidationStatus, confirmedAt } on payments',
  );

  await dropIndexIfExists(
    payments,
    { schoolId: 1, 'fiatSnapshot.fiatCurrency': 1, deletedAt: 1, confirmedAt: -1 },
    "{ schoolId, 'fiatSnapshot.fiatCurrency', deletedAt, confirmedAt } on payments",
  );
}

module.exports = { version: VERSION, up, down };
