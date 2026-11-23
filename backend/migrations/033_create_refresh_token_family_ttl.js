'use strict';

const mongoose = require('mongoose');

const VERSION = '033_create_refresh_token_family_ttl';
const COLLECTION = 'refreshtokenfamilies';

async function up() {
  const collection = mongoose.connection.collection(COLLECTION);
  await collection.createIndex({ familyId: 1 }, { unique: true, name: 'familyId_1' });
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'expiresAt_1' });
}

async function down() {
  const collection = mongoose.connection.collection(COLLECTION);
  for (const indexName of ['expiresAt_1', 'familyId_1']) {
    await collection.dropIndex(indexName).catch((error) => {
      if (error.codeName !== 'IndexNotFound' && error.code !== 27) throw error;
    });
  }
}

module.exports = { version: VERSION, up, down };
