# Database Migration Authoring and Rollback Policy

Schema/data migrations live in [`backend/migrations/`](../backend/migrations).
Each file exports a `version` string plus `up()` (and optionally `down()`)
functions. They are executed in filename order by
[`backend/src/services/migrationRunner.js`](../backend/src/services/migrationRunner.js).

## Table of Contents

- [Naming Convention](#naming-convention)
- [Authoring a Migration](#authoring-a-migration)
  - [Sample Migration](#sample-migration)
  - [Forward and Backward Compatibility](#forward-and-backward-compatibility)
  - [Data Backfills](#data-backfills)
  - [Security — PII and Secrets in Migrations](#security--pii-and-secrets-in-migrations)
- [Rollback Policy and Limitations](#rollback-policy-and-limitations)
- [Validation and CI Steps](#validation-and-ci-steps)

---

## Naming Convention

Every migration file must follow the pattern:

```
NNN_short_description.js
```

where `NNN` is a **zero-padded three-digit number** that is unique and
strictly sequential (no gaps, no duplicates). Examples:

```
001_backfill_remaining_balance.js
029_encrypt_student_pii.js
030_my_new_change.js   ← always one more than the current highest
```

The `scripts/validate-migrations.js` script enforces this convention
automatically — see [Validation and CI Steps](#validation-and-ci-steps).

---

## Authoring a Migration

### Sample Migration

The following annotated example shows the complete structure expected by the
migration runner. Copy it and replace the `VERSION` constant and the bodies
of `up()` / `down()`.

```js
'use strict';

/**
 * Migration NNN — Short description of what this migration does.
 *
 * Include:
 *   - What schema/data change it makes
 *   - Why the change is needed (link to issue if relevant)
 *   - Whether it is safe to run during a rolling deploy
 *   - Any required env vars (e.g. encryption keys)
 *
 * Rollback: describe what down() does and any caveats.
 */

const mongoose = require('mongoose');

// VERSION must match the filename (without the .js extension) exactly.
const VERSION = 'NNN_short_description';

async function up() {
  const db = mongoose.connection.db;
  const collection = db.collection('mycollection');

  // Always guard index creation with error code 85 (index already exists with
  // different options) and 86 (index already exists with same name):
  try {
    await collection.createIndex(
      { schoolId: 1, myField: 1 },
      { name: 'schoolId_1_myField_1', unique: true }
    );
    console.log(`[${VERSION}] Created compound unique index.`);
  } catch (err) {
    if (err.code === 85 || err.code === 86) {
      // Index already exists — idempotent, nothing to do.
      console.log(`[${VERSION}] Index already exists, skipping.`);
    } else {
      throw err;
    }
  }

  // Data backfills must use { upsert: false } or conditional $set to stay
  // idempotent. Never overwrite fields that are already correctly set.
  await collection.updateMany(
    { myField: { $exists: false } },
    { $set: { myField: 'default_value' } }
  );
  console.log(`[${VERSION}] Backfilled myField on existing documents.`);
}

async function down() {
  // Implementing down() is required for every migration.
  // For index-creating migrations: drop the index.
  // For data backfills: $unset the fields that up() added.
  // If rollback is truly impossible (e.g. destructive encryption),
  // throw explicitly so the runner never silently succeeds.
  const db = mongoose.connection.db;
  const collection = db.collection('mycollection');

  try {
    await collection.dropIndex('schoolId_1_myField_1');
    console.log(`[${VERSION}] Dropped compound unique index.`);
  } catch (err) {
    if (err.code === 27) {
      console.log(`[${VERSION}] Index did not exist — skipping drop.`);
    } else {
      throw err;
    }
  }

  await collection.updateMany({}, { $unset: { myField: '' } });
  console.log(`[${VERSION}] Removed myField from all documents.`);
}

module.exports = { version: VERSION, up, down };
```

**Required exports**

| Export | Type | Required | Description |
|--------|------|----------|-------------|
| `version` | `string` | Yes | Must equal the filename without `.js` |
| `up` | `async function` | Yes | Apply the migration |
| `down` | `async function` | Strongly recommended | Roll back the migration |

### Forward and Backward Compatibility

Migrations run **before** new application code is served (see
[Where it runs automatically](#where-it-runs-automatically-in-the-deployment-pipeline)).
This means there is always a window where the old version of the app runs
against the new schema. Follow these rules:

1. **Additive changes are always safe.** Adding a new optional field,
   creating a new index, or creating a new collection does not break the
   running app.

2. **Removing or renaming a field is a two-step process.**
   - Deploy 1: stop writing the old field (app no longer reads it either),
     keep the field in the schema.
   - Deploy 2: migration removes the field from the database.
   Never drop a field and update the app in the same release.

3. **Unique-index creation must consider existing data.** Before creating a
   unique index, verify (or backfill) that no duplicate values already exist.
   A failed `createIndex` will abort the migration run and block the deploy.

4. **Foreground index builds can briefly block writes** on large collections.
   Prefer `{ background: true }` (MongoDB 4.4+: implicit) for large
   collections in production. Note: this option is a no-op on MongoDB 7+,
   where all index builds are non-blocking by default.

5. **Multi-document operations should be chunked.** `updateMany` on millions
   of documents is safe but can be slow. Chunk via cursor if the collection is
   large (`> 100k` documents) to avoid blocking the event loop.

### Data Backfills

Backfills must be **idempotent** — running `up()` twice should leave the
database in the same state as running it once. Use these patterns:

```js
// Only update documents that don't already have the field:
await collection.updateMany(
  { myField: { $exists: false } },
  { $set: { myField: 'default' } }
);

// For encrypted values that already carry an "enc:" prefix:
// skip documents that are already encrypted — see migration 029 for the pattern.
```

Never use `{ $set: { myField: newValue } }` unconditionally in a backfill —
that would overwrite data on every re-run.

### Security — PII and Secrets in Migrations

- **Never log plaintext PII, credentials, or secret values** from within a
  migration. Use counts and status codes in `console.log` statements only
  (e.g. `"Updated 142 records"`, not a list of email addresses).
- Migrations that encrypt PII (e.g. `029_encrypt_student_pii`) read their key
  from an env var (`STUDENT_PII_ENCRYPTION_KEY`). If the key is absent the
  migration must skip encryption and log a warning — it must **not** fail
  silently or store plaintext as if encrypted.
- Do not hard-code sample values, test email addresses, student IDs, wallet
  addresses, or any PII in migration files. Use env vars or derive values from
  the database itself.
- Migrations touching PII fields (`parentEmail`, `parentPhone`, `memo`,
  `webhookSecret`, etc.) must be reviewed for data exposure before merging.

---

## How migrations run

There is a single entrypoint used everywhere:

```bash
# from the backend/ directory (or inside the container, where WORKDIR=/app)
npm run migrate            # apply all pending migrations
npm run migrate:rollback   # roll back the last applied migration
```

`runMigrations()` claims each migration atomically using the unique index on
`Migration.version` as a distributed lock, so it is **safe to run concurrently
from multiple instances** — only one applies a given migration and the rest
skip it. If a migration throws, its lock document is removed and the process
exits non-zero so the failure is loud and the deploy is blocked.

If the `migrations/` directory is missing entirely, `runMigrations()` throws
rather than silently returning — a missing directory means a broken image or
checkout, not "nothing to do".

## Where it runs automatically in the deployment pipeline

Migrations are wired into every deployment topology this repo describes, so a
new release's migrations are always applied **before traffic reaches the new
version**:

| Topology | Mechanism |
| --- | --- |
| Kubernetes (`deploy/k8s/backend-deployment.yaml`) | An `initContainer` runs `npm run migrate` to completion before the app container starts. A failed migration leaves the pod un-Ready and blocks the rollout. |
| Docker Compose (`docker-compose.yml`) | The `backend` service command is `sh -c "npm run migrate && npm start"`, so the server only starts after migrations succeed. |
| Local development | Run `npm run migrate` from `backend/` after pulling changes that add migration files. |

## Image contents

The production image **must** contain the migration files and the migration
CLI. [`backend/Dockerfile`](../backend/Dockerfile) copies both:

```dockerfile
COPY migrations/ ./migrations/
COPY scripts/ ./scripts/
```

Without these, `npm run migrate` cannot run and `runMigrations()` fails loudly
by design.

## Migrations 019–025 reference

Summary of what each of these migrations does, whether it's safe to run
during a rolling deploy, and any prerequisites an operator needs before
running `npm run migrate`. (See `CHANGELOG.md` for the same information in
release-note form.)

| Migration | What it does | Rolling-deploy safe? | Prerequisites |
| --- | --- | --- | --- |
| `019_add_reminder_time_window` | Backfills `schools.settings.reminderTimeWindow` to `{ startHour: 8, endHour: 18 }` on schools missing it. Data-only. | Yes — idempotent, no index/lock impact. | None. |
| `020_tenant_isolate_source_validation_rules` | Fixes #904: drops the old global-unique `name_1` index on `sourcevalidationrules`, creates a compound unique index on `{ schoolId, name }` plus a `{ schoolId }` lookup index, and backfills any rule missing `schoolId` to `DEFAULT_SCHOOL_ID` (default `"SCH-DEFAULT"`). | Caution — index creation is foreground (no `background: true`); can briefly hold a write lock on a large `sourcevalidationrules` collection. | **Operator action after running**: review rules that were backfilled to the default school — they were previously global and are now owned by one tenant. Optionally set `DEFAULT_SCHOOL_ID` before running to control the owning tenant. |
| `021_encrypt_webhook_secrets` | Encrypts existing plaintext `School.webhookSecret` values with AES-256-GCM (#75) and strips any lingering plaintext `secret` field from `WebhookRetry` documents. | Yes, once the key is set — idempotent (skips values already prefixed `enc:`). | **Must set `WEBHOOK_SECRET_ENCRYPTION_KEY`** (64-char hex) before running, or the migration no-ops and secrets remain plaintext (logged as a skip, not an error). |
| `022_create_reminder_logs` | Creates the `reminderlogs` collection with a unique compound index on `{ schoolId, studentId, windowStart }` (cross-replica reminder idempotency) and a TTL index on `createdAt`. | Yes — new collection, no contention with existing data. | None. Optionally set `REMINDER_LOG_TTL_SECONDS` to override the default 90-day retention. |
| `023_add_dispute_fields` | Adds evidence/SLA/escalation fields to existing `disputes` documents (`evidence`, `txReference`, `slaDeadline`, `slaBreachedAt`, `escalationLevel`, `escalatedAt`, `lastActivityAt`, `assignedTo`), computing `slaDeadline` from `createdAt + DISPUTE_SLA_HOURS`. Creates two non-unique indexes for SLA/escalation queries. | Yes, but the aggregation-pipeline `updateMany` backfill can take noticeable time on a large `disputes` collection. | Optionally set `DISPUTE_SLA_HOURS` (default 72) before running. |
| `024_add_underpaid_reconciliation_field` | Backfills an `underpaidReconciliation` sub-document onto every `payments` document that lacks one. Data-only. | Yes — idempotent, no index changes. | None. |
| `025_scope_payment_intent_memo_index` | Fixes #1202: drops the global-unique `memo` index on `paymentintents` and replaces it with a compound unique index on `{ schoolId, memo }`, built with `background: true`. | Yes — background index build, no write lock. Duplicate-memo protection is effectively index-less until the background build completes on large collections. | None. |

All seven are already ordered correctly by filename and require no manual
intervention beyond the prerequisites above — `npm run migrate` applies them
in sequence like any other migration.

## Recovering from the `_db` ReferenceError (pre-fix deployments)

Before this fix, `runMigrations()` referenced a `_db` variable that did not
exist in its scope, so **every** invocation of `npm run migrate` threw a
`ReferenceError` immediately after the migrations-directory check — before
any migration file was read or any lock document was written to the
`migrations` collection. The failure was loud (a non-zero exit code, a failed
CI step, a failed deploy/rollout), but it left **no record** of what was
attempted, so a database that went through this code path is in an unknown
state: some operators may have applied the pending migrations by hand,
skipped the step entirely and shipped anyway, or the deploy simply never went
out.

If you operate a database that was ever provisioned or deployed to through
`npm run migrate` before this fix, do not assume the `migrations` collection
reflects reality. Reconcile it before trusting it:

1. **List what the runner believes is applied.**
   ```js
   db.migrations.find({}, { version: 1, appliedAt: 1, lockedAt: 1 }).sort({ version: 1 })
   ```
   Any document with `lockedAt` set but no `appliedAt` is a stale lock from a
   run that crashed mid-migration (or from the `_db` bug itself, on versions
   of the runner old enough to write the lock before hitting the
   `ReferenceError` — check `git blame` on `migrationRunner.js` for your
   deployed version to see whether the lock write happened before or after
   the crash point). Stale locks block re-application; see below.

2. **Check each migration's actual effect against the database directly**,
   rather than trusting the collection. For index-creating migrations
   (`00[2346789]_*`, `012`, `015`, `016`, `018`, `025`), list existing indexes
   on the relevant collection and compare against what the migration file's
   `up()` creates:
   ```js
   db.<collection>.getIndexes()
   ```
   For backfill/encryption migrations (`001`, `005`, `010`, `011`, `013`,
   `021`, `024`), sample a handful of documents and check whether the fields
   the migration sets (e.g. an encrypted memo, a `deletedAt` backfill) are
   actually present.

3. **Reconcile the collection to match what you found in step 2** — do not
   just delete it and let the runner start clean, since a version marked
   "applied" that was never actually applied would then be silently skipped
   forever (the lock is a no-op skip, not a re-run):
   - A migration that **is** genuinely applied but has no `migrations`
     document (or only a stale lock): insert
     `{ version, appliedAt: new Date() }` so it is not re-run.
   - A migration that has an `appliedAt` but you cannot confirm its effect:
     treat this as the higher-risk case — read the migration's `up()` to
     understand whether re-running it is safe (most here are idempotent,
     e.g. `createIndex` and `$set`-style backfills guarded by a filter), and
     if so, delete its document and let the runner re-apply it; if not,
     apply the effect manually and then insert the `appliedAt` document.
   - A stale `lockedAt`-only document with no `appliedAt`: delete it so the
     migration is treated as pending again, after confirming (step 2) whether
     its `up()` partially ran and needs manual cleanup first.

4. **Only after reconciling**, run `npm run migrate` — from this point on,
   every future run is trustworthy: a completed migration always has both
   `version` and `appliedAt` recorded, because the fixed `runMigrations()` can
   actually reach that write.

---

## Rollback Policy and Limitations

### How rollback works

`npm run migrate:rollback` (or `node scripts/migrate.js rollback`) calls
`rollback()` in `migrationRunner.js`, which:

1. Finds the most recently `appliedAt` migration document in the `migrations`
   collection.
2. Loads that migration file and calls its `down()` function.
3. Removes the migration's tracking document so it can be re-applied later.

```bash
# Roll back the last applied migration
node scripts/migrate.js rollback
```

### Explicit limitations

| Limitation | Detail |
|------------|--------|
| **One step at a time** | `rollback` undoes exactly one migration per invocation. To revert three migrations you must run it three times. |
| **No automatic chaining** | The runner does not detect or roll back dependent migrations. Operators must reason about dependencies manually. |
| **`down()` must be present** | If a migration file exports no `down`, calling rollback succeeds silently — the tracking document is deleted but no schema change is reversed. Always implement `down()`. |
| **Destructive backfills may be irreversible** | A `down()` that `$unset` fields cannot restore values that were not preserved elsewhere. For encryption migrations (e.g. 029), `down()` requires the same encryption key used in `up()`. If the key is lost, rollback is impossible. |
| **Dropped collections / indexes** | Once a collection is dropped by `up()` the data is gone. `down()` can recreate an empty collection and its indexes but cannot restore data. Plan accordingly and take a backup before running destructive migrations in production. |
| **Rollback in production requires a coordinated deploy** | Because migrations run before app code, rolling back a migration without also rolling back the app version that depends on the new schema will cause runtime errors. Always co-ordinate schema and code rollbacks. |
| **`locked`-only documents block re-application** | A migration that crashed after inserting its lock document but before writing `appliedAt` will be skipped on the next `runMigrations` call (the existing lock document is seen and the runner skips). Inspect the `migrations` collection for stale locks and remove them manually (see [Recovering from a stale lock](#recovering-from-the-_db-referenceerror-pre-fix-deployments)). |

### When to roll back vs. fix forward

Prefer **fix forward** (write a new `NNN+1_fix_*.js` migration) over rollback in
production in all but the most critical cases. Rollback is appropriate when:

- The migration was applied minutes ago and has not been relied upon by any
  production traffic.
- The new schema is incompatible with the currently running app version and a
  code rollback is already in progress.
- A backup has been taken and the operator is confident the `down()` function
  is correct.

For everything else, write a corrective migration.

---

## Validation and CI Steps

The CI pipeline runs the following checks on every pull request before merging.
All checks must pass — a PR that changes any migration file must pass the
`migrations` job without warnings.

### 1 — Migration numbering (`migrations` CI job)

```bash
node scripts/validate-migrations.js
```

This script enforces:

- Every file in `backend/migrations/` matches the `NNN_description.js` pattern.
- All three-digit prefixes are **unique** (no two files share the same number).
- Numbers are **sequential** — no gaps in the sequence.
- No file anywhere in the repository `require()`s or `import`s a migration path
  that does not resolve (catches stale test references after a migration is
  renumbered).

A PR that introduces a gap, a duplicate number, or a dangling reference will
fail this job and must be corrected before merging.

### 2 — Migration smoke test (`test` CI job)

As part of the full test suite, the CI runner executes:

```bash
# In the test job, after installing dependencies:
cd backend && npm run migrate
```

This applies all pending migrations against a real single-node MongoDB replica
set (`rs0`) provisioned as a GitHub Actions service container. Any migration
that throws will fail the CI run immediately with a non-zero exit code.

### 3 — Syntax check (`test` CI job)

```bash
npm run check:syntax
```

Parses every JS file (including migration files) for syntax errors before tests
run. A migration with a syntax error is caught here before it ever reaches the
runner.

### 4 — Backend lint (`lint-backend` CI job)

```bash
cd backend && npx eslint src/ --max-warnings=0
```

Migration files in `backend/migrations/` are **not** covered by ESLint (they
live outside `src/`), but the migration runner itself is. Keep migration files
consistent with the project style (single quotes, `'use strict'`, semicolons)
even if they are not auto-linted.

### Pre-merge checklist for migration authors

Before opening a pull request that adds a migration:

- [ ] Filename matches `NNN_description.js` where `NNN` is the next sequential
      number after the current highest.
- [ ] `version` export equals the filename without `.js`.
- [ ] `up()` is idempotent (safe to run twice).
- [ ] `down()` is implemented and tested locally with
      `node scripts/migrate.js rollback`.
- [ ] No PII, credentials, or secret values appear in `console.log` output.
- [ ] Migration is documented in the `CHANGELOG.md` `[Unreleased]` section
      with rolling-deploy safety and any required env vars.
- [ ] `node scripts/validate-migrations.js` passes locally.
- [ ] Any test file that references a migration by path uses the new filename.
