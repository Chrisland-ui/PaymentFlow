'use strict';

/**
 * Tests for Issue #39 — Database index review for payment queries.
 *
 * Verifies:
 *   - Migration 030 creates and drops all documented indexes
 *   - Migration is idempotent (up can be called twice without error)
 *   - Model files declare the expected indexes in their schemas
 *
 * All tests run without a live MongoDB connection (DB layer is mocked).
 */

const path = require('path');
const fs   = require('fs');

// ── Migration source tests ────────────────────────────────────────────────────

const MIGRATION_SRC = fs.readFileSync(
  path.join(__dirname, '../backend/migrations/030_add_payment_query_indexes.js'),
  'utf8',
);

describe('Migration 030 — source structure', () => {
  test('exports version, up, and down', () => {
    expect(MIGRATION_SRC).toContain("version: VERSION");
    expect(MIGRATION_SRC).toContain('async function up()');
    expect(MIGRATION_SRC).toContain('async function down()');
  });

  test('up creates the payments status+deletedAt index', () => {
    expect(MIGRATION_SRC).toContain('schoolId: 1, status: 1, deletedAt: 1');
  });

  test('up creates the payments feeValidationStatus+deletedAt index', () => {
    expect(MIGRATION_SRC).toContain('schoolId: 1, feeValidationStatus: 1, deletedAt: 1');
  });

  test('up creates the payments studentId+deletedAt+confirmedAt index', () => {
    expect(MIGRATION_SRC).toContain('schoolId: 1, studentId: 1, deletedAt: 1, confirmedAt: -1');
  });

  test('up creates the auditlogs result index', () => {
    expect(MIGRATION_SRC).toContain('schoolId: 1, result: 1, createdAt: -1');
  });

  test('up creates the students deletedAt+createdAt index', () => {
    expect(MIGRATION_SRC).toContain('schoolId: 1, deletedAt: 1, createdAt: -1');
  });

  test('up creates the pendingverifications status+createdAt index', () => {
    expect(MIGRATION_SRC).toContain('schoolId: 1, status: 1, createdAt: 1');
  });

  test('down drops all indexes created by up', () => {
    // Every index created in up must also appear in down
    const indexPatterns = [
      'schoolId: 1, status: 1, deletedAt: 1',
      'schoolId: 1, feeValidationStatus: 1, deletedAt: 1',
      'schoolId: 1, studentId: 1, deletedAt: 1, confirmedAt: -1',
      'schoolId: 1, result: 1, createdAt: -1',
      'schoolId: 1, deletedAt: 1, createdAt: -1',
      'schoolId: 1, status: 1, createdAt: 1',
    ];
    for (const pattern of indexPatterns) {
      const count = (MIGRATION_SRC.match(new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      // Each pattern should appear at least twice: once in up(), once in down()
      expect(count).toBeGreaterThanOrEqual(2);
    }
  });

  test('uses createIndexIfMissing helper for idempotency', () => {
    expect(MIGRATION_SRC).toContain('createIndexIfMissing');
  });

  test('uses dropIndexIfExists helper for safe rollback', () => {
    expect(MIGRATION_SRC).toContain('dropIndexIfExists');
  });

  test('version constant is 030_add_payment_query_indexes', () => {
    expect(MIGRATION_SRC).toContain("'030_add_payment_query_indexes'");
  });
});

// ── Migration idempotency — mocked DB ────────────────────────────────────────

describe('Migration 030 — idempotency (mocked DB)', () => {
  let up;
  let down;

  // Build a fake MongoDB collection that records calls
  function makeCollection(existingIndexes = []) {
    return {
      indexes:     jest.fn().mockResolvedValue(existingIndexes),
      createIndex: jest.fn().mockResolvedValue('ok'),
      dropIndex:   jest.fn().mockResolvedValue('ok'),
    };
  }

  beforeEach(() => {
    jest.resetModules();

    // Mock mongoose with a controlled db object
    jest.mock('mongoose', () => {
      const collections = {
        payments:             makeCollection(),
        auditlogs:            makeCollection(),
        students:             makeCollection(),
        pendingverifications: makeCollection(),
      };
      return {
        connection: {
          db: {
            collection: jest.fn((name) => collections[name] || makeCollection()),
          },
        },
      };
    });

    const migration = require('../backend/migrations/030_add_payment_query_indexes');
    up   = migration.up;
    down = migration.down;
  });

  afterEach(() => {
    jest.resetModules();
  });

  test('up() runs without throwing', async () => {
    await expect(up()).resolves.not.toThrow();
  });

  test('down() runs without throwing', async () => {
    await expect(down()).resolves.not.toThrow();
  });

  test('up() called twice does not throw (idempotent)', async () => {
    await up();
    await expect(up()).resolves.not.toThrow();
  });

  test('up() calls createIndex on the payments collection', async () => {
    const mongoose = require('mongoose');
    await up();
    const paymentsCol = mongoose.connection.db.collection('payments');
    expect(paymentsCol.createIndex).toHaveBeenCalled();
  });

  test('down() calls dropIndex on the payments collection', async () => {
    const mongoose = require('mongoose');
    await down();
    const paymentsCol = mongoose.connection.db.collection('payments');
    expect(paymentsCol.dropIndex).toHaveBeenCalled();
  });

  test('down() handles already-dropped indexes (code 27) without throwing', async () => {
    jest.resetModules();
    jest.mock('mongoose', () => {
      function makeErrCol() {
        return {
          indexes:     jest.fn().mockResolvedValue([]),
          createIndex: jest.fn().mockResolvedValue('ok'),
          dropIndex:   jest.fn().mockRejectedValue(Object.assign(new Error('index not found'), { code: 27 })),
        };
      }
      return {
        connection: {
          db: { collection: jest.fn(() => makeErrCol()) },
        },
      };
    });
    const { down: freshDown } = require('../backend/migrations/030_add_payment_query_indexes');
    await expect(freshDown()).resolves.not.toThrow();
  });
});

// ── Model index declarations ──────────────────────────────────────────────────

describe('paymentModel — index declarations (Issue #39)', () => {
  const MODEL_SRC = fs.readFileSync(
    path.join(__dirname, '../backend/src/models/paymentModel.js'),
    'utf8',
  );

  test('declares { schoolId, status, deletedAt } index', () => {
    expect(MODEL_SRC).toContain('schoolId: 1, status: 1, deletedAt: 1');
  });

  test('declares { schoolId, feeValidationStatus, deletedAt } index', () => {
    expect(MODEL_SRC).toContain('schoolId: 1, feeValidationStatus: 1, deletedAt: 1');
  });

  test('declares { schoolId, studentId, deletedAt, confirmedAt } index', () => {
    expect(MODEL_SRC).toContain('schoolId: 1, studentId: 1, deletedAt: 1, confirmedAt: -1');
  });
});

describe('studentModel — index declarations (Issue #39)', () => {
  const MODEL_SRC = fs.readFileSync(
    path.join(__dirname, '../backend/src/models/studentModel.js'),
    'utf8',
  );

  test('declares { schoolId, deletedAt, createdAt } index', () => {
    expect(MODEL_SRC).toContain('schoolId: 1, deletedAt: 1, createdAt: -1');
  });
});

describe('auditLogModel — index declarations (Issue #39)', () => {
  const MODEL_SRC = fs.readFileSync(
    path.join(__dirname, '../backend/src/models/auditLogModel.js'),
    'utf8',
  );

  test('declares { schoolId, result, createdAt } index', () => {
    expect(MODEL_SRC).toContain('schoolId: 1, result: 1, createdAt: -1');
  });
});

// ── Documentation ─────────────────────────────────────────────────────────────

describe('docs/payment-query-indexes.md', () => {
  const DOC_SRC = fs.readFileSync(
    path.join(__dirname, '../docs/payment-query-indexes.md'),
    'utf8',
  );

  test('documents all new indexes', () => {
    expect(DOC_SRC).toContain('status');
    expect(DOC_SRC).toContain('feeValidationStatus');
    expect(DOC_SRC).toContain('deletedAt');
    expect(DOC_SRC).toContain('result');
  });

  test('documents write overhead', () => {
    expect(DOC_SRC).toMatch(/write overhead/i);
  });

  test('documents migration and rollback paths', () => {
    expect(DOC_SRC).toMatch(/migration/i);
    expect(DOC_SRC).toMatch(/rollback/i);
  });
});
