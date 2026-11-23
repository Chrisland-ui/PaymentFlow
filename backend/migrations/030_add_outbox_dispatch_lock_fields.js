'use strict';

/**
 * Migration 030 — Add dispatch locking and TTL indexes to the outbox collection.
 *
 * Adds:
 *   1. A compound index for the dispatcher's claim query
 *      (processed + deadLettered + lockedUntil + scheduledAfter + createdAt).
 *      This lets the dispatcher efficiently find claimable, un-delayed events
 *      without a full collection scan.
 *
 *   2. A partial TTL index on processedAt (excludes dead-lettered events).
 *      Processed events are auto-expired after OUTBOX_PROCESSED_TTL_SECONDS
 *      (default 30 days = 2 592 000 s).  Dead-lettered events are never
 *      expired so they remain observable and replayable by admins.
 *
 * Both indexes are idempotent: running this migration again when the indexes
 * already exist is a no-op (createIndex is idempotent by name).
 */

const mongoose = require('mongoose');

const VERSION = '030_add_outbox_dispatch_lock_fields';
const COLLECTION = 'outboxes';

const PROCESSED_TTL_SECONDS =
  parseInt(process.env.OUTBOX_PROCESSED_TTL_SECONDS, 10) || 2592000; // 30 days

async function up() {
  const collection = mongoose.connection.collection(COLLECTION);

  // 1. Compound dispatcher-claim index.
  await collection.createIndex(
    { processed: 1, deadLettered: 1, lockedUntil: 1, scheduledAfter: 1, createdAt: 1 },
    { name: 'outbox_dispatcher_claim_idx', background: true },
  );
  console.log(`[030] Created dispatcher claim index on ${COLLECTION}`);

  // 2. Partial TTL index on processedAt — only fires for non-dead-lettered events.
  await collection.createIndex(
    { processedAt: 1 },
    {
      name: 'outbox_processed_ttl_idx',
      expireAfterSeconds: PROCESSED_TTL_SECONDS,
      partialFilterExpression: { deadLettered: false },
      background: true,
    },
  );
  console.log(
    `[030] Created TTL index on ${COLLECTION}.processedAt ` +
      `(${PROCESSED_TTL_SECONDS}s = ${Math.round(PROCESSED_TTL_SECONDS / 86400)} days, non-dead-lettered only)`,
  );
}

async function down() {
  const collection = mongoose.connection.collection(COLLECTION);

  for (const name of ['outbox_dispatcher_claim_idx', 'outbox_processed_ttl_idx']) {
    try {
      await collection.dropIndex(name);
      console.log(`[030] Dropped index ${name} from ${COLLECTION}`);
    } catch (err) {
      // Index may not exist if migration was only partially applied.
      if (err.code !== 27 /* IndexNotFound */) throw err;
    }
  }
}

module.exports = { version: VERSION, up, down };
