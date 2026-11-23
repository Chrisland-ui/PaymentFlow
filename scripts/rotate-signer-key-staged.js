#!/usr/bin/env node
'use strict';

/**
 * Staged signer key rotation — Issue #63.
 *
 * Automates a four-phase SIGNER_MASTER_KEY rotation with explicit verification
 * at each step. Old keys are revoked only after operator confirmation that all
 * records decrypt correctly under the new key.
 *
 * Phases
 * ──────
 * Phase 1 — PREPARE
 *   Verify the old key can decrypt every stored signing key without writing
 *   anything. Emit a structured audit log entry listing affected schools.
 *   Fails fast if any record cannot be decrypted — prevents a partial rotation.
 *
 * Phase 2 — APPLY  (requires --apply flag)
 *   Re-encrypt all records under the new key and persist to the database.
 *   A per-record error does NOT stop the run; the summary lists failures so
 *   the operator can decide whether to proceed.
 *
 * Phase 3 — VERIFY  (runs automatically after --apply)
 *   Decrypt every newly-written blob under the new key and confirm each
 *   produces a valid Stellar keypair. A single failure marks the run as
 *   failed and prints rollback instructions.
 *
 * Phase 4 — COMMIT  (informational; no automatic action)
 *   Prints step-by-step instructions to update the deployment secret and
 *   revoke SIGNER_MASTER_KEY_OLD from the environment. The operator must
 *   complete this manually after reviewing the audit output.
 *
 * Rollback
 * ────────
 * If Phase 2 or 3 fails, the script prints an explicit rollback instruction.
 * It does NOT auto-rollback because the DB may be partially updated and
 * requires operator review. The operator can re-run Phase 1 with the old key
 * to confirm which records were affected.
 *
 * Audit log
 * ─────────
 * Each phase emits a structured JSON entry to stdout. Log entries include:
 *   timestamp, operator, phase, result, affectedCount, failedCount
 * Private keys are NEVER included in log output.
 *
 * Usage
 * ─────
 *   # Dry run — Phase 1 only, no writes:
 *   SIGNER_MASTER_KEY_OLD=<old> SIGNER_MASTER_KEY=<new> \
 *     ROTATION_OPERATOR=alice \
 *     node scripts/rotate-signer-key-staged.js
 *
 *   # Full rotation — Phases 1-4:
 *   SIGNER_MASTER_KEY_OLD=<old> SIGNER_MASTER_KEY=<new> \
 *     ROTATION_OPERATOR=alice \
 *     node scripts/rotate-signer-key-staged.js --apply
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../backend/.env') });

const mongoose = require('mongoose');
const {
  decryptSecretKey,
  reEncryptSecretKey,
} = require('../backend/src/utils/signerKeyManager');

// ---------------------------------------------------------------------------
// Audit logging — structured JSON, no secrets
// ---------------------------------------------------------------------------

/**
 * Emit a structured audit log entry to stdout.
 * Fields intentionally exclude any key material.
 *
 * @param {object} entry
 */
function auditLog(entry) {
  const record = {
    timestamp: new Date().toISOString(),
    operator: process.env.ROTATION_OPERATOR || 'unknown',
    service: 'signer-key-rotation',
    ...entry,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(record));
}

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv() {
  const oldKey = process.env.SIGNER_MASTER_KEY_OLD;
  const newKey = process.env.SIGNER_MASTER_KEY;

  if (!oldKey) {
    throw new Error('SIGNER_MASTER_KEY_OLD must be set to the key currently protecting stored records.');
  }
  if (!newKey) {
    throw new Error('SIGNER_MASTER_KEY must be set to the new key to re-encrypt under.');
  }
  if (oldKey === newKey) {
    throw new Error('SIGNER_MASTER_KEY and SIGNER_MASTER_KEY_OLD must differ.');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(oldKey)) {
    throw new Error('SIGNER_MASTER_KEY_OLD must be a 64-character hex string (32 bytes).');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(newKey)) {
    throw new Error('SIGNER_MASTER_KEY must be a 64-character hex string (32 bytes).');
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — PREPARE: verify all records are readable under the old key
// ---------------------------------------------------------------------------

/**
 * @param {object} School  Mongoose model (or test double).
 * @returns {Promise<{schoolIds: string[], failedIds: string[]}>}
 */
async function phaseOne(School) {
  const schools = await School.find({ encryptedSigningKey: { $exists: true, $ne: null } })
    .select('_id encryptedSigningKey')
    .lean();

  const schoolIds = [];
  const failedIds = [];

  // Temporarily switch to the OLD key for decryption
  const savedKey = process.env.SIGNER_MASTER_KEY;
  process.env.SIGNER_MASTER_KEY = process.env.SIGNER_MASTER_KEY_OLD;

  try {
    for (const school of schools) {
      try {
        decryptSecretKey(school.encryptedSigningKey);
        schoolIds.push(String(school._id));
      } catch {
        failedIds.push(String(school._id));
      }
    }
  } finally {
    process.env.SIGNER_MASTER_KEY = savedKey;
  }

  auditLog({
    phase: 'prepare',
    result: failedIds.length === 0 ? 'ok' : 'failed',
    affectedCount: schoolIds.length,
    failedCount: failedIds.length,
    // School IDs (not keys) are safe to log for audit trail
    affectedSchools: schoolIds,
    failedSchools: failedIds,
    message: failedIds.length === 0
      ? `All ${schoolIds.length} school(s) readable under old key.`
      : `${failedIds.length} school(s) could NOT be decrypted. Rotation aborted.`,
  });

  return { schoolIds, failedIds };
}

// ---------------------------------------------------------------------------
// Phase 2 — APPLY: re-encrypt and persist under the new key
// ---------------------------------------------------------------------------

/**
 * @param {object} School
 * @returns {Promise<Array<{schoolId: string, status: 'ok'|'error', error?: string}>>}
 */
async function phaseTwo(School) {
  const schools = await School.find({ encryptedSigningKey: { $exists: true, $ne: null } })
    .select('_id encryptedSigningKey')
    .lean();

  const results = [];

  for (const school of schools) {
    try {
      const newBlob = reEncryptSecretKey(school.encryptedSigningKey);
      await School.updateOne(
        { _id: school._id },
        { $set: { encryptedSigningKey: newBlob } },
      );
      results.push({ schoolId: String(school._id), status: 'ok' });
    } catch (err) {
      results.push({ schoolId: String(school._id), status: 'error', error: err.message });
    }
  }

  const failed = results.filter((r) => r.status === 'error');
  auditLog({
    phase: 'apply',
    result: failed.length === 0 ? 'ok' : 'partial_failure',
    affectedCount: results.length,
    failedCount: failed.length,
    failedSchools: failed.map((f) => f.schoolId),
    message: failed.length === 0
      ? `Re-encrypted ${results.length} school(s).`
      : `${failed.length} school(s) failed re-encryption. See failedSchools.`,
  });

  return results;
}

// ---------------------------------------------------------------------------
// Phase 3 — VERIFY: confirm every persisted blob decrypts under the new key
// ---------------------------------------------------------------------------

/**
 * @param {object} School
 * @returns {Promise<{verified: number, failed: number, failedSchools: string[]}>}
 */
async function phaseThree(School) {
  const schools = await School.find({ encryptedSigningKey: { $exists: true, $ne: null } })
    .select('_id encryptedSigningKey')
    .lean();

  let verified = 0;
  const failedSchools = [];

  for (const school of schools) {
    try {
      // decryptSecretKey validates the blob AND confirms the decrypted value
      // is a valid Stellar StrKey secret seed — no need for a separate Keypair check.
      decryptSecretKey(school.encryptedSigningKey);
      verified++;
    } catch {
      failedSchools.push(String(school._id));
    }
  }

  const allOk = failedSchools.length === 0;

  auditLog({
    phase: 'verify',
    result: allOk ? 'ok' : 'failed',
    verifiedCount: verified,
    failedCount: failedSchools.length,
    failedSchools,
    message: allOk
      ? `Verified ${verified} school(s) successfully decrypt under new key.`
      : `${failedSchools.length} school(s) failed verification. ROLLBACK REQUIRED — see instructions.`,
  });

  return { verified, failed: failedSchools.length, failedSchools };
}

// ---------------------------------------------------------------------------
// Phase 4 — COMMIT: print operator instructions
// ---------------------------------------------------------------------------

function phaseFour() {
  auditLog({
    phase: 'commit',
    result: 'instructions_printed',
    message: 'All phases passed. Follow the commit instructions below to complete rotation.',
  });

  // eslint-disable-next-line no-console
  console.log([
    '',
    '╔══════════════════════════════════════════════════════╗',
    '║  Phase 4 — COMMIT: complete the rotation             ║',
    '╚══════════════════════════════════════════════════════╝',
    '',
    '  1. Update SIGNER_MASTER_KEY in your deployment secret',
    '     (Kubernetes Secret, AWS Secrets Manager, etc.) to',
    '     the NEW key value.',
    '',
    '  2. Remove SIGNER_MASTER_KEY_OLD from the deployment',
    '     environment ONLY after step 1 is confirmed live.',
    '',
    '  3. Redeploy the API and all workers so they pick up',
    '     the new key.',
    '',
    '  4. Run a smoke test: verify a test payment can be',
    '     processed end-to-end after redeployment.',
    '',
    '  5. Record the rotation in your audit log:',
    `     operator=${process.env.ROTATION_OPERATOR || 'unknown'}, timestamp=${new Date().toISOString()}`,
    '',
    '  See docs/runbooks/signer-key-rotation.md for full details.',
    '',
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// Rollback instructions
// ---------------------------------------------------------------------------

function printRollbackInstructions(failedSchools) {
  // eslint-disable-next-line no-console
  console.error([
    '',
    '╔══════════════════════════════════════════════════════╗',
    '║  ROLLBACK REQUIRED                                   ║',
    '╚══════════════════════════════════════════════════════╝',
    '',
    '  Verification failed. The database may be partially',
    '  updated. Do NOT drop SIGNER_MASTER_KEY_OLD.',
    '',
    '  Immediate steps:',
    '  1. Keep SIGNER_MASTER_KEY_OLD set in the environment.',
    '  2. Run Phase 1 (dry run) with the old key as SIGNER_MASTER_KEY',
    '     to confirm which records remain readable.',
    '  3. For each failed school, manually inspect the record:',
    ...(failedSchools.length > 0
      ? failedSchools.map((id) => `     - School: ${id}`)
      : ['     (no specific school IDs available)']),
    '  4. Contact the on-call operator. Do NOT proceed to commit.',
    '',
    '  See docs/runbooks/signer-key-rotation.md#rollback.',
    '',
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Execute staged rotation against a live Mongoose School model.
 * Exported for programmatic use in tests and CI.
 *
 * @param {object} School   Mongoose model or test double.
 * @param {{ apply: boolean }} opts
 * @returns {Promise<{ phase1: object, phase2?: object[], phase3?: object }>}
 */
async function runStagedRotation(School, { apply }) {
  // ── Phase 1: Prepare ───────────────────────────────────────────────────
  const prepare = await phaseOne(School);

  if (prepare.failedIds.length > 0) {
    throw new Error(
      `Phase 1 FAILED: ${prepare.failedIds.length} school(s) could not be decrypted under old key. ` +
      'Rotation aborted — no changes written.',
    );
  }

  if (!apply) {
    // eslint-disable-next-line no-console
    console.log(
      `\nDry run complete (${prepare.schoolIds.length} school(s) verified readable). ` +
      'Re-run with --apply to perform the rotation.\n',
    );
    return { phase1: prepare };
  }

  // ── Phase 2: Apply ─────────────────────────────────────────────────────
  const applyResults = await phaseTwo(School);
  const applyFailed = applyResults.filter((r) => r.status === 'error');

  if (applyFailed.length > 0) {
    const ids = applyFailed.map((r) => r.schoolId);
    printRollbackInstructions(ids);
    throw new Error(`Phase 2 PARTIAL FAILURE: ${applyFailed.length} school(s) failed re-encryption.`);
  }

  // ── Phase 3: Verify ────────────────────────────────────────────────────
  const verify = await phaseThree(School);

  if (verify.failed > 0) {
    printRollbackInstructions(verify.failedSchools);
    throw new Error(`Phase 3 FAILED: ${verify.failed} school(s) did not verify under new key.`);
  }

  // ── Phase 4: Commit ────────────────────────────────────────────────────
  phaseFour();

  return { phase1: prepare, phase2: applyResults, phase3: verify };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const apply = process.argv.includes('--apply');
  validateEnv();

  await mongoose.connect(process.env.MONGO_URI);
  const School = require('../backend/src/models/schoolModel');

  try {
    await runStagedRotation(School, { apply });
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { runStagedRotation, validateEnv, phaseOne, phaseTwo, phaseThree, auditLog };
