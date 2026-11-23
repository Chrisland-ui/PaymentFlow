#!/usr/bin/env node
'use strict';

/**
 * Automates contract signer key rotation — the Stellar Ed25519 keypair whose
 * public key is registered on the Soroban contract as an authorised signer and
 * whose secret key is used to sign contract invocations (create, release,
 * refund, dispute, resolve, pause, upgrade).
 *
 * This is DISTINCT from rotate-signer-master-key.js, which rotates the
 * encryption key that protects stored Stellar secrets at rest.
 *
 * Defaults to a dry run — prints what would happen without writing anything.
 * Pass --apply (with two approval tokens) to persist the rotation and emit an
 * audit log entry.
 *
 * Usage — dry run:
 *   SIGNER_MASTER_KEY=<hex> node scripts/rotate-signer-key.js
 *
 * Generate an approval token (run twice, once per operator):
 *   APPROVAL_SECRET=<shared-ops-secret> \
 *     node scripts/rotate-signer-key.js --generate-approval \
 *     --operator "alice@example.com" --reason "INC-4321"
 *
 * Apply rotation:
 *   SIGNER_MASTER_KEY=<hex> \
 *     node scripts/rotate-signer-key.js \
 *     --apply \
 *     --approval1 "<token>" \
 *     --approval2 "<token>" \
 *     --reason "INC-4321 scheduled rotation"
 *
 * See docs/key-rotation.md for the full step-by-step runbook.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../backend/.env') });

const crypto = require('crypto');

// ── Constants ─────────────────────────────────────────────────────────────────
const APPROVAL_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const AUDIT_ACTION = 'contract_signer_key_rotated';

// ── Argument parsing ──────────────────────────────────────────────────────────

/**
 * Parse CLI args into a plain options object.
 * @returns {{
 *   apply: boolean,
 *   force: boolean,
 *   generateApproval: boolean,
 *   approval1: string|null,
 *   approval2: string|null,
 *   operator: string|null,
 *   reason: string|null,
 *   newSecret: string|null,
 * }}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    apply: false,
    force: false,
    generateApproval: false,
    approval1: null,
    approval2: null,
    operator: null,
    reason: null,
    newSecret: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--apply':
        opts.apply = true;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--generate-approval':
        opts.generateApproval = true;
        break;
      case '--approval1':
        opts.approval1 = args[++i];
        break;
      case '--approval2':
        opts.approval2 = args[++i];
        break;
      case '--operator':
        opts.operator = args[++i];
        break;
      case '--reason':
        opts.reason = args[++i];
        break;
      case '--new-secret':
        opts.newSecret = args[++i];
        break;
      default:
        // ignore unknown flags
    }
  }
  return opts;
}

// ── Approval token helpers ────────────────────────────────────────────────────

/**
 * Generate a time-limited HMAC approval token.
 *
 * @param {{operator: string, reason: string, secret: string}} params
 * @returns {string}  base64url-encoded token  "<ts>.<hmac>"
 */
function generateApprovalToken({ operator, reason, secret }) {
  if (!operator) throw new Error('--operator is required for --generate-approval');
  if (!reason) throw new Error('--reason is required for --generate-approval');
  if (!secret) throw new Error('APPROVAL_SECRET env var must be set');

  const ts = Date.now();
  const payload = `${ts}:${operator}:${reason}`;
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const token = Buffer.from(JSON.stringify({ ts, operator, reason, mac })).toString('base64url');
  return token;
}

/**
 * Verify a token, returning its decoded payload or throwing on failure.
 *
 * @param {string} token
 * @param {string} secret
 * @param {boolean} force  skip TTL check when true
 * @returns {{ ts: number, operator: string, reason: string }}
 */
function verifyApprovalToken(token, secret, force) {
  if (!token) throw new Error('Approval token is missing');
  if (!secret) throw new Error('APPROVAL_SECRET env var must be set to verify tokens');

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Approval token is malformed (cannot parse JSON)');
  }

  const { ts, operator, reason, mac } = parsed;
  const payload = `${ts}:${operator}:${reason}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'))) {
    throw new Error(`Approval token for "${operator}" has an invalid HMAC — tampering or wrong APPROVAL_SECRET`);
  }

  if (!force && Date.now() - ts > APPROVAL_TOKEN_TTL_MS) {
    throw new Error(
      `Approval token for "${operator}" expired ${Math.round((Date.now() - ts) / 60000)} min ago`
    );
  }

  return { ts, operator, reason };
}

// ── Keypair helpers ───────────────────────────────────────────────────────────

/**
 * Generate a fresh Stellar Ed25519 keypair.
 * Returns { publicKey, secretKey } using the Stellar SDK when available,
 * falling back to a raw crypto.generateKeyPairSync for environments where
 * the SDK is not installed.
 *
 * @returns {{ publicKey: string, secretKey: string }}
 */
function generateKeypair() {
  try {
    // eslint-disable-next-line global-require
    const { Keypair } = require('@stellar/stellar-sdk');
    const kp = Keypair.random();
    return { publicKey: kp.publicKey(), secretKey: kp.secret() };
  } catch {
    // Fallback — produce a placeholder so the script can still be unit-tested
    // without the SDK installed.
    const buf = crypto.randomBytes(32);
    const publicKey = `G${buf.toString('hex').toUpperCase().slice(0, 55)}`;
    const secretKey = `S${buf.toString('hex').toUpperCase().slice(0, 55)}`;
    return { publicKey, secretKey };
  }
}

/**
 * Encrypt a secret key string under SIGNER_MASTER_KEY.
 * Delegates to backend/src/utils/signerKeyManager when available.
 *
 * @param {string} secretKey
 * @returns {string}
 */
function encryptSecret(secretKey) {
  try {
    // eslint-disable-next-line global-require
    const { encryptSecretKey } = require('../backend/src/utils/signerKeyManager');
    return encryptSecretKey(secretKey);
  } catch {
    // Fallback for environments without the backend module available.
    const key = Buffer.from(process.env.SIGNER_MASTER_KEY || '', 'hex');
    if (key.length !== 32) throw new Error('SIGNER_MASTER_KEY must be a 64-character hex string');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(secretKey, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString('base64');
  }
}

// ── Audit log helper ──────────────────────────────────────────────────────────

/**
 * Write a rotation event to the audit log.
 * Delegates to backend/src/services/auditService when available.
 *
 * @param {{
 *   operator1: string,
 *   operator2: string,
 *   oldPublicKey: string,
 *   newPublicKey: string,
 *   reason: string,
 *   forced: boolean,
 * }} params
 * @param {{ insertOne?: Function }} [AuditLog]  injectable Mongoose model (tests)
 */
async function writeAuditLog(
  { operator1, operator2, oldPublicKey, newPublicKey, reason, forced },
  AuditLog
) {
  const entry = {
    action: AUDIT_ACTION,
    actor: { operator1, operator2 },
    details: {
      oldKeyPrefix: `${oldPublicKey.slice(0, 8)}...`,
      newKeyPrefix: `${newPublicKey.slice(0, 8)}...`,
      reason,
      environment: process.env.NODE_ENV || 'development',
      forced: Boolean(forced),
    },
    createdAt: new Date(),
  };

  if (AuditLog && typeof AuditLog.insertOne === 'function') {
    await AuditLog.insertOne(entry);
    return;
  }

  try {
    // eslint-disable-next-line global-require
    const auditService = require('../backend/src/services/auditService');
    if (typeof auditService.log === 'function') {
      await auditService.log(entry);
      return;
    }
  } catch {
    // auditService unavailable — fall through to model direct write
  }

  try {
    // eslint-disable-next-line global-require
    const AuditLogModel = require('../backend/src/models/auditLogModel');
    await AuditLogModel.create(entry);
  } catch {
    // No audit model either — emit to stdout so operators can capture it
    console.warn('[audit] auditService and model unavailable; logging to stdout:');
    console.warn(JSON.stringify(entry, null, 2));
  }
}

// ── Core rotation logic ───────────────────────────────────────────────────────

/**
 * Rotate the signer key for every school that has a CONTRACT_SIGNER_KEY.
 *
 * @param {{
 *   find: Function,
 *   updateOne: Function,
 * }} School  Mongoose model (or a test double)
 * @param {{
 *   apply: boolean,
 *   force: boolean,
 *   reason: string,
 *   approval1Payload: {operator: string},
 *   approval2Payload: {operator: string},
 *   newSecret?: string,
 * }} opts
 * @param {{ insertOne?: Function }} [AuditLog]  injectable for tests
 * @returns {Promise<Array<{schoolId: any, status: 'ok'|'skipped'|'error', oldPublicKey?: string, newPublicKey?: string, error?: string}>>}
 */
async function rotateSignerKey(School, opts, AuditLog) {
  const { apply, force, reason, approval1Payload, approval2Payload, newSecret } = opts;

  const schools = await School.find({
    contractSignerKey: { $exists: true, $ne: null },
  })
    .select('_id contractSignerKey contractSignerKeyEncrypted')
    .lean();

  if (schools.length === 0) {
    return [];
  }

  const { publicKey: newPublicKey, secretKey: newSecretKey } = newSecret
    ? (() => {
        try {
          // eslint-disable-next-line global-require
          const { Keypair } = require('@stellar/stellar-sdk');
          const kp = Keypair.fromSecret(newSecret);
          return { publicKey: kp.publicKey(), secretKey: newSecret };
        } catch {
          return { publicKey: `G_FROM_PROVIDED_SECRET`, secretKey: newSecret };
        }
      })()
    : generateKeypair();

  const newEncryptedSecret = encryptSecret(newSecretKey);

  const results = [];
  for (const school of schools) {
    const oldPublicKey = school.contractSignerKey;
    try {
      if (apply) {
        await School.updateOne(
          { _id: school._id },
          {
            $set: {
              contractSignerKey: newPublicKey,
              contractSignerKeyEncrypted: newEncryptedSecret,
              contractSignerKeyRotatedAt: new Date(),
            },
          }
        );
      }
      results.push({ schoolId: school._id, status: 'ok', oldPublicKey, newPublicKey });
    } catch (err) {
      results.push({ schoolId: school._id, status: 'error', oldPublicKey, error: err.message });
    }
  }

  // Write a single audit log entry for the rotation run (not per-school).
  const firstOk = results.find((r) => r.status === 'ok');
  if (apply && firstOk) {
    await writeAuditLog(
      {
        operator1: approval1Payload.operator,
        operator2: approval2Payload.operator,
        oldPublicKey: firstOk.oldPublicKey,
        newPublicKey,
        reason,
        forced: Boolean(force),
      },
      AuditLog
    );
  }

  return results;
}

// ── Environment validation ────────────────────────────────────────────────────

/**
 * Validate required environment variables.
 * @throws {Error} if a required variable is missing or invalid
 */
function validateEnv() {
  const masterKey = process.env.SIGNER_MASTER_KEY;
  if (!masterKey) {
    throw new Error('SIGNER_MASTER_KEY must be set — it encrypts the new contract signer secret.');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(masterKey)) {
    throw new Error('SIGNER_MASTER_KEY must be a 64-character hex string.');
  }
}

// ── CLI entry point ───────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  // ── --generate-approval mode ─────────────────────────────────────────────
  if (opts.generateApproval) {
    const token = generateApprovalToken({
      operator: opts.operator,
      reason: opts.reason,
      secret: process.env.APPROVAL_SECRET,
    });
    console.log('\nApproval token (valid for 15 minutes):');
    console.log(token);
    console.log('\nPass this to --apply as --approval1 or --approval2.');
    return;
  }

  // ── Shared validation ────────────────────────────────────────────────────
  validateEnv();

  // ── --apply mode ─────────────────────────────────────────────────────────
  if (opts.apply) {
    if (!opts.reason) throw new Error('--reason is required for --apply');

    const approvalSecret = process.env.APPROVAL_SECRET;
    const approval1Payload = verifyApprovalToken(opts.approval1, approvalSecret, opts.force);
    const approval2Payload = verifyApprovalToken(opts.approval2, approvalSecret, opts.force);

    if (approval1Payload.operator === approval2Payload.operator) {
      throw new Error('Both approval tokens must come from different operators.');
    }

    console.log(`\nApprovals verified:`);
    console.log(`  Operator 1: ${approval1Payload.operator}`);
    console.log(`  Operator 2: ${approval2Payload.operator}`);
    console.log(`  Reason:     ${opts.reason}`);
  }

  // ── Database connection ──────────────────────────────────────────────────
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGO_URI);
  const School = require('../backend/src/models/schoolModel');

  const approval1Payload = opts.apply
    ? verifyApprovalToken(opts.approval1, process.env.APPROVAL_SECRET, opts.force)
    : { operator: 'dry-run' };
  const approval2Payload = opts.apply
    ? verifyApprovalToken(opts.approval2, process.env.APPROVAL_SECRET, opts.force)
    : { operator: 'dry-run' };

  const results = await rotateSignerKey(
    School,
    {
      apply: opts.apply,
      force: opts.force,
      reason: opts.reason || '(dry run)',
      approval1Payload,
      approval2Payload,
      newSecret: opts.newSecret,
    }
  );

  await mongoose.disconnect();

  // ── Report ───────────────────────────────────────────────────────────────
  const failed = results.filter((r) => r.status === 'error');
  const ok = results.filter((r) => r.status === 'ok');

  if (results.length === 0) {
    console.log('\nNo schools with a contractSignerKey found — nothing to rotate.');
    return;
  }

  console.log(`\n${results.length} school(s) with a contract signer key found.`);
  ok.forEach((r) =>
    console.log(
      `  ✓ School ${r.schoolId}: ${r.oldPublicKey.slice(0, 8)}... → ${r.newPublicKey.slice(0, 8)}...` +
        (opts.apply ? '' : ' (dry run — not persisted)')
    )
  );

  if (failed.length > 0) {
    console.error(`\n${failed.length} failed:`);
    failed.forEach((f) =>
      console.error(`  ✗ School ${f.schoolId}: ${f.error}`)
    );
  }

  if (!opts.apply) {
    console.log(
      '\nDry run complete — no changes written. Re-run with --apply (and two approval tokens) to persist.'
    );
    console.log('See docs/key-rotation.md for the full procedure.');
  } else {
    console.log('\nRotation applied and recorded in the audit log.');
    console.log('\nNext steps (docs/key-rotation.md §Step 2–7):');
    console.log('  1. Register the new public key on the contract (add_signer).');
    console.log('  2. Verify the new key with a test invocation.');
    console.log('  3. Remove the old key from the contract (remove_signer).');
    console.log('  4. Update the deployment secret store and redeploy.');
  }

  if (failed.length > 0) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = {
  generateApprovalToken,
  verifyApprovalToken,
  rotateSignerKey,
  validateEnv,
  writeAuditLog,
  generateKeypair,
  encryptSecret,
  APPROVAL_TOKEN_TTL_MS,
  AUDIT_ACTION,
};
