'use strict';

const crypto = require('crypto');

const CURSOR_TTL_MS = 60 * 60 * 1000;
const CURSOR_KEY = process.env.LIST_CURSOR_HMAC_KEY || process.env.JWT_SECRET || 'list-cursor-key';

function cursorError(message) {
  const error = new Error(message);
  error.code = 'INVALID_CURSOR';
  return error;
}

function filtersFingerprint(filters) {
  return crypto.createHash('sha256').update(JSON.stringify(filters)).digest('hex');
}

function encodeListCursor(record, filters) {
  const payload = {
    createdAt: new Date(record.createdAt).toISOString(),
    id: String(record._id),
    filters: filtersFingerprint(filters),
    expiresAt: Date.now() + CURSOR_TTL_MS,
  };
  const data = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', CURSOR_KEY).update(data).digest('hex');
  return Buffer.from(JSON.stringify({ data, signature })).toString('base64url');
}

function decodeListCursor(token, filters) {
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw cursorError('Cursor is malformed');
  }

  if (typeof envelope?.data !== 'string' || typeof envelope?.signature !== 'string') {
    throw cursorError('Cursor is malformed');
  }

  const expected = crypto.createHmac('sha256', CURSOR_KEY).update(envelope.data).digest();
  let supplied;
  try {
    supplied = Buffer.from(envelope.signature, 'hex');
  } catch {
    throw cursorError('Cursor signature is invalid');
  }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw cursorError('Cursor signature is invalid');
  }

  let payload;
  try {
    payload = JSON.parse(envelope.data);
  } catch {
    throw cursorError('Cursor payload is malformed');
  }

  if (!Number.isFinite(payload.expiresAt) || Date.now() > payload.expiresAt) {
    throw cursorError('Cursor has expired');
  }
  if (payload.filters !== filtersFingerprint(filters)) {
    throw cursorError('Cursor does not match the current filters');
  }
  if (!Number.isFinite(Date.parse(payload.createdAt)) || typeof payload.id !== 'string' || !/^[a-f\d]{24}$/i.test(payload.id)) {
    throw cursorError('Cursor position is invalid');
  }

  return payload;
}

function cursorCondition(payload) {
  const createdAt = new Date(payload.createdAt);
  return {
    $or: [
      { createdAt: { $lt: createdAt } },
      { createdAt, _id: { $lt: payload.id } },
    ],
  };
}

module.exports = { encodeListCursor, decodeListCursor, cursorCondition };
