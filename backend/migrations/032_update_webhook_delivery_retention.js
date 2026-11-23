'use strict';

/**
 * Migration 032 — Set the default webhook delivery retention to 30 days.
 *
 * Rebuilds the TTL index so databases that already applied migration 028 pick
 * up the new default. Explicit environment overrides continue to take effect.
 */

const mongoose = require('mongoose');
const { resolveTtlSeconds } = require('../src/models/webhookDeliveryModel');

const VERSION = '032_update_webhook_delivery_retention';
const COLLECTION = 'webhookdeliveries';

async function existingIndexes(collection) {
  return collection.indexes().catch((err) => {
    if (err.code === 26) return [];
    throw err;
  });
}

async function replaceCreatedAtTtl(collection, ttlSeconds) {
  for (const index of await existingIndexes(collection)) {
    if (index.key?.createdAt !== undefined && index.expireAfterSeconds !== undefined) {
      await collection.dropIndex(index.name);
    }
  }
  await collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: ttlSeconds });
}

async function up() {
  const collection = mongoose.connection.collection(COLLECTION);
  await replaceCreatedAtTtl(collection, resolveTtlSeconds());
}

async function down() {
  const collection = mongoose.connection.collection(COLLECTION);
  const configuredSeconds = parseInt(process.env.WEBHOOK_DELIVERY_TTL_SECONDS, 10);
  const configuredDays = parseInt(process.env.WEBHOOK_DELIVERY_RETENTION_DAYS, 10);
  const rollbackTtl = Number.isFinite(configuredSeconds) && configuredSeconds > 0
    ? configuredSeconds
    : Number.isFinite(configuredDays) && configuredDays > 0
      ? configuredDays * 86400
      : 90 * 86400;
  await replaceCreatedAtTtl(collection, rollbackTtl);
}

module.exports = { version: VERSION, up, down };
