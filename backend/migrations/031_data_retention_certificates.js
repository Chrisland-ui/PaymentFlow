'use strict';

const mongoose = require('mongoose');

const VERSION = '031_data_retention_certificates';

async function getIndexes(collection) {
  try {
    return await collection.getIndexes();
  } catch (error) {
    if (error.code === 26) return {};
    throw error;
  }
}

async function up() {
  const db = mongoose.connection;
  const auditLogs = db.collection('auditlogs');
  for (const [name, spec] of Object.entries(await getIndexes(auditLogs))) {
    if (spec.expireAfterSeconds !== undefined) {
      await auditLogs.dropIndex(name);
    }
  }
  await auditLogs.createIndex({ createdAt: -1 });

  const students = db.collection('students');
  await students.createIndex({ graduatedAt: 1 });

  const certificates = db.collection('datadeletioncertificates');
  await certificates.createIndex({ category: 1, recordId: 1 }, { unique: true });
  await certificates.createIndex({ purgedAt: -1, _id: -1 });
}

async function down() {
  const db = mongoose.connection;
  const certificates = db.collection('datadeletioncertificates');
  for (const [name] of Object.entries(await getIndexes(certificates))) {
    if (name !== '_id_') await certificates.dropIndex(name);
  }
  const students = db.collection('students');
  for (const [name, spec] of Object.entries(await getIndexes(students))) {
    if (spec.key?.graduatedAt !== undefined) await students.dropIndex(name);
  }
}

module.exports = { version: VERSION, up, down };
