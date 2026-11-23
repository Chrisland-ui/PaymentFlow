'use strict';

const mongoose = require('mongoose');
const csv = require('csv-parser');
const Student = require('../models/studentModel');
const FeeStructure = require('../models/feeStructureModel');
const School = require('../models/schoolModel');
const ImportJob = require('../models/importJobModel');
const { encryptStudentPii, hashParentEmail } = require('./studentPiiEncryption');
const { del, KEYS } = require('../cache');
const { startWorker: startQueueWorker, closeQueue } = require('../queue/studentImportQueue');
const logger = require('../utils/logger');

const BATCH_SIZE = 500;
const MAX_ERRORS = 100;
const STUDENT_ID_RE = /^[A-Za-z0-9_-]{3,20}$/;

function validateRow(row) {
  if (!row || typeof row !== 'object') return { error: 'Row must contain CSV fields', code: 'INVALID_ROW' };
  if (Object.keys(row).some((field) => /^_\d+$/.test(field))) {
    return { error: 'Row contains more fields than the CSV header', code: 'CSV_INVALID_ROW' };
  }
  if (typeof row.studentId !== 'string' || !STUDENT_ID_RE.test(row.studentId.trim())) {
    return { field: 'studentId', error: 'studentId must be 3–20 alphanumeric characters (letters, digits, _ or -)', code: 'VALIDATION_ERROR' };
  }
  if (typeof row.name !== 'string' || !row.name.trim()) {
    return { field: 'name', error: 'name is required', code: 'VALIDATION_ERROR' };
  }
  if (typeof row.class !== 'string' || !row.class.trim()) {
    return { field: 'class', error: 'class is required', code: 'VALIDATION_ERROR' };
  }
  if (row.feeAmount != null && row.feeAmount !== '') {
    const amount = Number(row.feeAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { field: 'feeAmount', error: 'feeAmount must be a positive number', code: 'VALIDATION_ERROR' };
    }
  }
  return null;
}

async function recordBatch(jobId, schoolId, rows, school, quotaRemaining) {
  const classes = [...new Set(rows.map(({ data }) => data.class?.trim()).filter(Boolean))];
  const feeStructures = classes.length
    ? await FeeStructure.find({ schoolId, className: { $in: classes }, isActive: true }).lean()
    : [];
  const feeByClass = new Map(feeStructures.map((item) => [item.className, item.feeAmount]));
  const studentIds = [...new Set(rows.map(({ data }) => data.studentId?.trim()).filter(Boolean))];
  const existing = await Student.find({ schoolId, studentId: { $in: studentIds } }).select('studentId').lean();
  const existingIds = new Set(existing.map((item) => item.studentId));
  const seenIds = new Set();
  const outcomes = [];
  const inserts = [];
  let remainingQuota = quotaRemaining;

  for (const { data, rowNumber } of rows) {
    const invalid = validateRow(data);
    if (invalid) {
      outcomes.push({ row: rowNumber, studentId: data?.studentId || null, ...invalid });
      continue;
    }

    const studentId = data.studentId.trim();
    if (existingIds.has(studentId) || seenIds.has(studentId)) {
      outcomes.push({ row: rowNumber, studentId, error: 'Student ID already exists in this school', code: 'DUPLICATE_STUDENT_ID' });
      continue;
    }
    seenIds.add(studentId);

    if (remainingQuota <= 0) {
      outcomes.push({
        row: rowNumber,
        studentId,
        error: `School has reached maximum student quota of ${school.maxStudents}`,
        code: 'STUDENT_QUOTA_EXCEEDED',
      });
      continue;
    }

    let feeAmount = data.feeAmount != null && data.feeAmount !== '' ? Number(data.feeAmount) : feeByClass.get(data.class.trim());
    if (feeAmount == null) {
      outcomes.push({
        row: rowNumber,
        studentId,
        field: 'class',
        error: `No feeAmount provided and no fee structure found for class "${data.class.trim()}"`,
        code: 'FEE_STRUCTURE_NOT_FOUND',
      });
      continue;
    }

    const parentEmail = data.parentEmail ? data.parentEmail.trim().toLowerCase() : null;
    const parentPhone = data.parentPhone ? data.parentPhone.trim() : null;
    inserts.push({
      schoolId,
      studentId,
      name: data.name.trim(),
      class: data.class.trim(),
      feeAmount,
      parentEmail: encryptStudentPii(parentEmail),
      parentPhone: encryptStudentPii(parentPhone),
      parentEmailHash: hashParentEmail(parentEmail),
    });
    outcomes.push({ row: rowNumber, studentId, created: true });
    remainingQuota--;
  }

  const failed = outcomes.filter((outcome) => !outcome.created);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (inserts.length) await Student.insertMany(inserts, { session, ordered: true });
      const update = await ImportJob.updateOne(
        { jobId, status: 'processing' },
        {
          $inc: {
            processedRows: rows.length,
            createdRows: inserts.length,
            failedRows: failed.length,
          },
          ...(failed.length ? { $push: { errors: { $each: failed, $slice: -MAX_ERRORS } } } : {}),
        },
        { session }
      );
      if (!update.matchedCount) throw new Error('Import job is no longer processing');
    });
  } finally {
    await session.endSession();
  }
  del(KEYS.studentsAll());

  return { created: inserts.length, failed: failed.length, quotaRemaining: remainingQuota };
}

async function processStudentImport(job) {
  const { jobId, schoolId, fileId } = job.data;
  const ImportFileId = new mongoose.mongo.ObjectId(fileId);
  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'studentImports' });
  const importJob = await ImportJob.findOne({ jobId }).lean();
  if (!importJob) throw new Error('Import job record not found');
  if (importJob.status === 'completed') return { jobId, status: 'completed' };

  await ImportJob.updateOne(
    { jobId, status: { $in: ['pending', 'processing'] } },
    { status: 'processing', startedAt: importJob.startedAt || new Date() }
  );

  const school = await School.findOne({ schoolId }).select('maxStudents').lean();
  const currentCount = await Student.countDocuments({ schoolId, deletedAt: null });
  let quotaRemaining = school?.maxStudents ? Math.max(0, school.maxStudents - currentCount) : Infinity;
  let processedRows = importJob.processedRows || 0;
  let rowsRead = 0;
  let batch = [];
  const maxFieldLength = parseInt(process.env.CSV_MAX_FIELD_LENGTH, 10) || 4096;
  const maxColumns = parseInt(process.env.CSV_MAX_COLUMNS, 10) || 20;
  const parser = bucket.openDownloadStream(ImportFileId).pipe(csv({ maxRowBytes: maxFieldLength * maxColumns * 4 }));

  try {
    for await (const data of parser) {
      rowsRead++;
      if (rowsRead <= processedRows) continue;
      batch.push({ data, rowNumber: rowsRead + 1 });
      if (batch.length === BATCH_SIZE) {
        const result = await recordBatch(jobId, schoolId, batch, school || {}, quotaRemaining);
        processedRows += batch.length;
        quotaRemaining = result.quotaRemaining;
        batch = [];
      }
    }
    if (batch.length) {
      const result = await recordBatch(jobId, schoolId, batch, school || {}, quotaRemaining);
      processedRows += batch.length;
    }

    await ImportJob.updateOne(
      { jobId, status: 'processing' },
      { status: 'completed', completedAt: new Date() }
    );
    del(KEYS.studentsAll());
    await bucket.delete(ImportFileId).catch(() => {});
    return { jobId, status: 'completed', processedRows };
  } catch (error) {
    logger.error('[StudentImportQueueService] Import processing failed', { jobId, error: error.message });
    throw error;
  }
}

function startWorker() {
  return startQueueWorker(processStudentImport);
}

async function stopWorker() {
  await closeQueue();
}

module.exports = { startWorker, stopWorker, processStudentImport, BATCH_SIZE };
