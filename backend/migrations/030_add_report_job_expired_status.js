'use strict';

/**
 * Migration 030 — Add 'expired' to ReportJob status enum index.
 *
 * The ReportJob model gained an 'expired' status value (issue #44) to
 * explicitly represent artifacts whose expiresAt TTL has passed. MongoDB
 * schema enums are not enforced at the database level, but this migration
 * recreates the status index to ensure query plans remain valid after the
 * new value is in production use.
 *
 * This migration is idempotent: dropping and recreating the same index is safe.
 */

const mongoose = require('mongoose');

const VERSION = '030_add_report_job_expired_status';

async function up() {
  const db = mongoose.connection;
  const collection = db.collection('reportjobs');

  try {
    // Ensure the collection exists before operating on indexes.
    let indexes = {};
    try {
      indexes = await collection.getIndexes();
    } catch (error) {
      if (error.code !== 26) throw error;
      // Collection does not exist yet — nothing to do.
      console.log('[030] reportjobs collection does not exist yet — skipping index recreation');
      return;
    }

    // Drop the existing status index if present so it is recreated cleanly.
    for (const [indexName, indexSpec] of Object.entries(indexes)) {
      if (indexSpec.key && indexSpec.key.status !== undefined && indexName !== '_id_') {
        await collection.dropIndex(indexName);
        console.log(`[030] Dropped existing status index: ${indexName}`);
      }
    }

    // Recreate the status + createdAt compound index used for queue queries.
    await collection.createIndex({ status: 1, createdAt: -1 });
    console.log('[030] Recreated status index on reportjobs');
  } catch (error) {
    console.error('[030] Error recreating ReportJob status index:', error);
    throw error;
  }
}

async function down() {
  const db = mongoose.connection;
  const collection = db.collection('reportjobs');

  try {
    let indexes = {};
    try {
      indexes = await collection.getIndexes();
    } catch (error) {
      if (error.code !== 26) throw error;
      return;
    }

    for (const [indexName, indexSpec] of Object.entries(indexes)) {
      if (indexSpec.key && indexSpec.key.status !== undefined && indexName !== '_id_') {
        await collection.dropIndex(indexName);
        console.log(`[030] Dropped status index: ${indexName}`);
      }
    }
  } catch (error) {
    console.error('[030] Error dropping ReportJob status index:', error);
    throw error;
  }
}

module.exports = { version: VERSION, up, down };
