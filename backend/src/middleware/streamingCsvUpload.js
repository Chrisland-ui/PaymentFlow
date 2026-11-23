'use strict';

/**
 * Streaming CSV upload middleware.
 *
 * Bounds and validates a multipart/form-data CSV upload before the request
 * body reaches any controller:
 *
 *  Byte limit  — Busboy fileSize limit rejects oversized uploads with 413
 *                before a single row is parsed (no full-file buffering).
 *  Row limit   — Exceeded mid-stream: stream is destroyed, 400 returned.
 *  Column limit — Exceeded per-row: stream is destroyed, 400 returned.
 *  Extension   — Must end in .csv; 400 otherwise.
 *  MIME type   — Must be text/csv, application/csv, or application/vnd.ms-excel.
 *  Headers     — Optional `requiredHeaders` list; 400 CSV_MISSING_HEADERS when
 *                any required column is absent from the first data row.
 *
 * On success, req.csvFileId references a streamed GridFS file for the worker.
 */

const Busboy = require('busboy');
const csv = require('csv-parser');
const mongoose = require('mongoose');

function streamingCsvUpload(options = {}) {
  const maxSize = options.maxSize || parseInt(process.env.CSV_MAX_SIZE_BYTES, 10) || 10 * 1024 * 1024;
  const maxRows = options.maxRows || parseInt(process.env.CSV_MAX_ROWS, 10) || 50000;
  const maxColumns = options.maxColumns || parseInt(process.env.CSV_MAX_COLUMNS, 10) || 20;
  const maxFieldLength = options.maxFieldLength || parseInt(process.env.CSV_MAX_FIELD_LENGTH, 10) || 4096;
  const requiredHeaders = Array.isArray(options.requiredHeaders) ? options.requiredHeaders : [];

  return (req, res, next) => {
    const contentType = req.headers['content-type'] || '';

    if (!contentType.includes('multipart/form-data')) {
      return next();
    }

    let rowCount = 0;
    let aborted = false;
    let seenFile = false;
    let parserEnded = false;
    let uploadFinished = false;
    let busboyClosed = false;
    let uploadStream = null;
    let parser = null;
    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: 'studentImports',
    });

    const cleanup = () => {
      if (!uploadStream) return;
      uploadStream.abort().catch(() => {});
      bucket.delete(uploadStream.id).catch(() => {});
    };

    const fail = (status, body) => {
      if (aborted) return;
      aborted = true;
      parser?.destroy();
      cleanup();
      if (!res.headersSent) res.status(status).json(body);
    };

    const finishUpload = () => {
      if (aborted || !parserEnded || !uploadFinished || !busboyClosed) return;
      req.csvFileId = uploadStream.id;
      req.csvRowCount = rowCount;
      next();
    };

    const bb = Busboy({
      headers: req.headers,
      limits: { fileSize: maxSize, files: 1 },
      defParamCharset: 'utf-8',
    });

    const allowedMimeTypes = ['text/csv', 'application/csv', 'application/vnd.ms-excel'];

    bb.on('file', (fieldname, file, info) => {
      if (seenFile) {
        file.resume();
        return fail(400, { error: 'Only one CSV file may be uploaded', code: 'CSV_INVALID_FORMAT' });
      }
      seenFile = true;

      if (fieldname !== 'file') {
        file.resume();
        return fail(400, { error: 'CSV file must use the "file" field', code: 'CSV_INVALID_FORMAT' });
      }

      const filename = info.filename || '';
      const mimeType = info.mimeType || info.mime || '';

      if (!filename.toLowerCase().endsWith('.csv')) {
        file.resume();
        return fail(400, {
          error: 'Uploaded file must have a .csv extension',
          code: 'CSV_INVALID_EXTENSION',
        });
      }

      if (!allowedMimeTypes.includes(mimeType.toLowerCase())) {
        file.resume();
        return fail(400, {
          error: `Uploaded file must be text/csv or application/csv, got ${mimeType}`,
          code: 'CSV_INVALID_MIME_TYPE',
        });
      }

      uploadStream = bucket.openUploadStream(`student-import-${Date.now()}.csv`, {
        metadata: { schoolId: req.schoolId, uploadedAt: new Date() },
      });
      parser = csv({ maxRowBytes: maxFieldLength * maxColumns * 4 });
      uploadStream.on('error', (err) => {
        if (aborted) return;
        aborted = true;
        parser?.destroy();
        cleanup();
        next(err);
      });
      uploadStream.on('finish', () => {
        uploadFinished = true;
        finishUpload();
      });
      file.on('limit', () => fail(413, {
        error: `CSV file exceeds maximum allowed size of ${maxSize} bytes`,
        code: 'CSV_TOO_LARGE',
      }));

      file.pipe(uploadStream);
      file
        .pipe(parser)
        .on('headers', (headers) => {
          req.csvHeaders = headers;
          const oversizedHeader = headers.find((header) => header.length > maxFieldLength);
          if (oversizedHeader) {
            fail(400, { error: `CSV header exceeds ${maxFieldLength} characters`, code: 'CSV_FIELD_TOO_LARGE' });
            return;
          }
          const missingColumns = requiredHeaders.filter((header) => !headers.includes(header));
          if (missingColumns.length > 0) {
            fail(400, {
              error: `CSV is missing required columns: ${missingColumns.join(', ')}`,
              code: 'CSV_MISSING_HEADERS',
              missingColumns,
            });
          } else if (headers.length > maxColumns) {
            fail(400, { error: `CSV has too many columns. Max is ${maxColumns}`, code: 'CSV_INVALID_FORMAT' });
          }
        })
        .on('data', (row) => {
          if (aborted) return;

          rowCount++;
          if (rowCount > maxRows) {
            return fail(400, {
              error: `CSV exceeds maximum row limit of ${maxRows}`,
              code: 'CSV_TOO_MANY_ROWS',
            });
          }

          if (Object.keys(row).length > maxColumns) {
            return fail(400, {
              error: `Row ${rowCount + 1} has too many columns. Max is ${maxColumns}`,
              code: 'CSV_INVALID_FORMAT',
            });
          }

          const oversizedField = Object.entries(row).find(([, value]) =>
            typeof value === 'string' && value.length > maxFieldLength
          );
          if (oversizedField) {
            return fail(400, {
              error: `Row ${rowCount + 1} contains a field longer than ${maxFieldLength} characters`,
              code: 'CSV_FIELD_TOO_LARGE',
              field: oversizedField[0],
            });
          }
        })
        .on('end', () => {
          parserEnded = true;
          finishUpload();
        })
        .on('error', (err) => {
          if (aborted) return;
          aborted = true;
          cleanup();
          next(err);
        });
    });

    bb.on('filesLimit', () => {
      fail(400, { error: 'Only one CSV file may be uploaded', code: 'CSV_INVALID_FORMAT' });
    });

    bb.on('error', (err) => {
      if (aborted) return;
      aborted = true;
      cleanup();
      next(err);
    });

    bb.on('close', () => {
      busboyClosed = true;
      if (!aborted && !seenFile) {
        return res.status(400).json({
          error: 'Provide a CSV file (field "file") or a JSON body with { "students": [...] }',
          code: 'VALIDATION_ERROR',
        });
      }
      finishUpload();
    });

    req.pipe(bb);
  };
}

module.exports = streamingCsvUpload;
