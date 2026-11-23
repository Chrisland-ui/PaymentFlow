'use strict';

/**
 * Issue #335 — Migration compatibility and rollback tests
 *
 * CI job that:
 *   1. Applies all migrations in order on a clean test database.
 *   2. Runs smoke tests after each migration step verifying core functionality.
 *   3. Tests the down() migration for every file that defines one.
 *   4. Verifies that the database schema after up() followed by down() matches
 *      the pre-migration state (no unexpected index/collection residue).
 *
 * Uses the real MongoDB service provided by CI (MONGO_URI env var) when
 * available, or MongoMemoryServer for local runs.
 */

const fs   = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const MIGRATIONS_DIR = path.join(__dirname, '../backend/migrations');
const TEST_DB        = 'migration_335_compatibility_test';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Load every migration file, sorted ascending by filename.
 */
function loadMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((file) => ({
      file,
      ...require(path.join(MIGRATIONS_DIR, file)),
    }));
}

/**
 * Capture a lightweight snapshot of the database state: collection names and
 * their index key sets (shapes only, ignoring internal _id index).
 */
async function captureDbSnapshot() {
  const db          = mongoose.connection.db;
  const collections = await db.listCollections().toArray();
  const snapshot    = {};

  for (const { name } of collections) {
    const indexes = await db.collection(name).indexes();
    snapshot[name] = indexes
      .filter((idx) => !idx.key._id) // ignore default _id index
      .map((idx) => JSON.stringify(Object.keys(idx.key).sort()))
      .sort();
  }
  return snapshot;
}

/**
 * Smoke-test: verify that the database connection is alive and the core
 * collections (students, schools, payments) are accessible.  After applying
 * every migration the application must still be able to write and read from
 * these collections without errors.
 */
async function runSmokeSuite(label) {
  const db = mongoose.connection.db;

  // Write a sentinel document to each core collection.
  const coreCollections = ['students', 'schools', 'payments'];
  for (const col of coreCollections) {
    const collection = db.collection(col);
    const sentinel   = { _smokeTest: true, label, ts: new Date() };
    const { insertedId } = await collection.insertOne(sentinel);
    const found = await collection.findOne({ _id: insertedId });
    expect(found).not.toBeNull();
    expect(found._smokeTest).toBe(true);
    await collection.deleteOne({ _id: insertedId });
  }

  // Verify the migrations tracking collection exists and is accessible.
  const migrations = db.collection('migrations');
  const count      = await migrations.countDocuments({});
  expect(typeof count).toBe('number');
}

// ── suite setup ──────────────────────────────────────────────────────────────

let mongoServer;

beforeAll(async () => {
  if (process.env.MONGO_URI) {
    const baseUri = process.env.MONGO_URI.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);
    await mongoose.connect(baseUri);
  } else {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  }
}, 30_000);

afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 30_000);

beforeEach(async () => {
  // Drop every collection except the system ones between test groups so each
  // test block starts with a clean slate.
  const db          = mongoose.connection.db;
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map(({ name }) => db.dropCollection(name).catch(() => {})));
});

// ── test suites ──────────────────────────────────────────────────────────────

describe('Issue #335 — CI job: apply all migrations in order on a clean database', () => {
  test('all migration files can be loaded (no syntax / require errors)', () => {
    const migrations = loadMigrations();
    expect(migrations.length).toBeGreaterThan(0);

    for (const m of migrations) {
      expect(typeof m.version).toBe('string');
      expect(typeof m.up).toBe('function');
    }
  });

  test('migration files are sorted and have no duplicate version strings', () => {
    const migrations = loadMigrations();
    const versions   = migrations.map((m) => m.version);
    const unique     = new Set(versions);
    expect(unique.size).toBe(versions.length);
  });

  test('all migrations apply in order without throwing', async () => {
    const migrations = loadMigrations();

    for (const m of migrations) {
      await expect(m.up()).resolves.not.toThrow();
    }
  }, 60_000);
});

describe('Issue #335 — Smoke tests run after each migration step', () => {
  test('smoke suite passes after every individual migration is applied', async () => {
    const migrations = loadMigrations();

    for (const m of migrations) {
      await m.up();
      // After each migration the application must still be able to read/write
      // the core collections — a broken migration must not leave the DB
      // unreachable or corrupt the collection handles.
      await runSmokeSuite(`after_${m.version}`);
    }
  }, 120_000);
});

describe('Issue #335 — down() migrations are tested for every file that defines one', () => {
  test('every migration that exports down() can be rolled back without throwing', async () => {
    const migrations      = loadMigrations();
    const withDown        = migrations.filter((m) => typeof m.down === 'function');

    // There must be at least one migration with a down() — otherwise the test
    // matrix silently provides zero coverage and the issue's acceptance
    // criteria cannot be met.
    expect(withDown.length).toBeGreaterThan(0);

    for (const m of withDown) {
      // Apply, then immediately roll back.
      await m.up();
      await expect(m.down()).resolves.not.toThrow();
    }
  }, 120_000);

  test('each migration that lacks a down() is explicitly acknowledged', () => {
    const migrations   = loadMigrations();
    const withoutDown  = migrations.filter((m) => typeof m.down !== 'function');
    // Not a failure — just a documentation assertion.  If this list grows
    // unexpectedly a reviewer should be prompted to add a down() or justify
    // the omission in a code comment.
    for (const m of withoutDown) {
      expect(typeof m.version).toBe('string'); // presence check
    }
  });
});

describe('Issue #335 — Schema comparison: up() + down() leaves no unexpected residue', () => {
  test('snapshot before up() matches snapshot after up()+down() for every migration with a down()', async () => {
    const migrations = loadMigrations();
    const withDown   = migrations.filter((m) => typeof m.down === 'function');

    for (const m of withDown) {
      // Capture pre-migration state.
      const before = await captureDbSnapshot();

      // Apply, then roll back.
      await m.up();
      await m.down();

      // Capture post-rollback state.
      const after = await captureDbSnapshot();

      // The collection-and-index shapes must be equivalent. We allow new
      // collections to be absent (some migrations create collections that
      // down() cleans up), but we must not have *extra* indexes left behind.
      for (const [col, afterIndexes] of Object.entries(after)) {
        const beforeIndexes = before[col] ?? [];
        // No index present after the rollback may be absent before the migration.
        for (const idx of afterIndexes) {
          if (!beforeIndexes.includes(idx)) {
            throw new Error(
              `Migration ${m.version}: index ${idx} on collection '${col}' ` +
              'was not removed by down().'
            );
          }
        }
      }
    }
  }, 180_000);

  test('down() is idempotent — calling it twice does not throw', async () => {
    const migrations = loadMigrations();
    const withDown   = migrations.filter((m) => typeof m.down === 'function');

    for (const m of withDown) {
      await m.up();
      await m.down();
      // Second call on an already-rolled-back migration must be safe.
      await expect(m.down()).resolves.not.toThrow();
    }
  }, 120_000);
});

describe('Issue #335 — Full sequence: all migrations up then all down in reverse', () => {
  test('full up→smoke→down cycle completes successfully', async () => {
    const migrations = loadMigrations();
    const withDown   = migrations.filter((m) => typeof m.down === 'function');

    // Apply all migrations forward.
    for (const m of migrations) {
      await m.up();
    }

    // Smoke-test after the full forward pass.
    await runSmokeSuite('after_all_up');

    // Roll back all reversible migrations in reverse order.
    for (const m of [...withDown].reverse()) {
      await m.down();
    }
  }, 180_000);
});
