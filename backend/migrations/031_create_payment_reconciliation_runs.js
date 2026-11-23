'use strict';

const mongoose = require('mongoose');

const VERSION = '031_create_payment_reconciliation_runs';
const COLLECTION = 'paymentreconciliationruns';

async function up() {
  const collection = mongoose.connection.collection(COLLECTION);
  await collection.createIndex({ runId: 1 }, { unique: true, name: 'runId_1' });
  await collection.createIndex({ status: 1 }, { name: 'status_1' });
  await collection.createIndex({ startedAt: -1 }, { name: 'startedAt_-1' });
  await collection.createIndex({ status: 1, startedAt: -1 }, { name: 'status_1_startedAt_-1' });
}

async function down() {
  const collection = mongoose.connection.collection(COLLECTION);
  const indexes = await collection.indexes().catch((error) => {
    if (error.codeName === 'NamespaceNotFound') return [];
    throw error;
  });
  for (const index of indexes) {
    if (index.name !== '_id_') await collection.dropIndex(index.name);
  }
  await collection.drop().catch((error) => {
    if (error.codeName !== 'NamespaceNotFound') throw error;
  });
}

module.exports = { version: VERSION, up, down };