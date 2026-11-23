'use strict';

/**
 * Migration: Ensure idempotencykeys collection has all required indexes
 *
 * The idempotency store relies on two indexes for correctness:
 *   1. Unique index on `key`  — this is the compare-and-set arbiter that makes
 *      concurrent duplicate requests safe.  Exactly one caller wins the INSERT;
 *      the rest see a duplicate-key error (code 11000) and back off.
 *   2. TTL index on `createdAt` — automatically purges records after
 *      IDEMPOTENCY_KEY_TTL_SECONDS (default 24 h) so the collection doesn't
 *      grow unbounded.
 *
 * Both indexes are declared in idempotencyKeyModel.js.  Mongoose only
 * auto-creates schema indexes on *new* collections; this migration ensures
 * they exist on collections that pre-date these model changes.
 *
 * Idempotent: safe to run multiple times.
 */

const mongoose = require('mongoose');

const VERSION = '030_ensure_idempotency_key_indexes';
const TTL_SECONDS = parseInt(process.env.IDEMPOTENCY_KEY_TTL_SECONDS || '86400', 10);

async function up() {
  const collection = mongoose.connection.collection('idempotencykeys');

  // Fetch existing indexes, tolerating a not-yet-created collection.
  const existing = await collection.indexes().catch((err) => {
    if (err.code === 26) return []; // NamespaceNotFound — collection doesn't exist yet
    throw err;
  });

  const hasUniqueKey = existing.some(
    (idx) => idx.key && idx.key.key === 1 && idx.unique === true
  );

  const hasTtl = existing.some(
    (idx) => idx.key && idx.key.createdAt !== undefined && idx.expireAfterSeconds !== undefined
  );

  if (!hasUniqueKey) {
    await collection.createIndex({ key: 1 }, { unique: true, name: 'key_unique' });
    console.log('[030] Created unique index on idempotencykeys.key');
  } else {
    console.log('[030] Unique index on idempotencykeys.key already exists — skipping');
  }

  if (!hasTtl) {
    await collection.createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: TTL_SECONDS, name: 'createdAt_ttl' }
    );
    console.log(`[030] Created TTL index on idempotencykeys.createdAt (${TTL_SECONDS}s)`);
  } else {
    console.log('[030] TTL index on idempotencykeys.createdAt already exists — skipping');
  }
}

async function down() {
  const collection = mongoose.connection.collection('idempotencykeys');
  const existing = await collection.indexes().catch((err) => {
    if (err.code === 26) return [];
    throw err;
  });

  for (const idx of existing) {
    if (idx.name === 'key_unique' || idx.name === 'createdAt_ttl') {
      await collection.dropIndex(idx.name);
      console.log(`[030] Dropped index: ${idx.name}`);
    }
  }
}

module.exports = { version: VERSION, up, down };
