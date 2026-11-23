#!/usr/bin/env node
'use strict';

/**
 * verify-rotation.js — Validates that a completed rotation produced a usable
 * credential set, without exposing any secret values in output or logs.
 *
 * Checks performed (based on secret_type argument):
 *   jwt        - Issues and immediately verifies a JWT signed with the current
 *                JWT_SECRET to confirm the secret is syntactically valid.
 *   webhook    - Encrypts a dummy value with WEBHOOK_SECRET_ENCRYPTION_KEY and
 *                decrypts it to confirm the key pair is consistent.
 *   signer     - Encrypts and decrypts a dummy Stellar key-sized buffer with
 *                SIGNER_MASTER_KEY to confirm the key is valid AES-256.
 *
 * Usage:
 *   node scripts/verify-rotation.js --type jwt
 *   node scripts/verify-rotation.js --type webhook
 *   node scripts/verify-rotation.js --type signer
 *
 * Exit 0 = credentials valid.
 * Exit 1 = credentials invalid or not set (rotation should be rolled back).
 *
 * SECURITY: This script deliberately never prints, logs, or returns any secret
 * value — only pass/fail status and error messages.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../backend/.env') });

const crypto = require('crypto');
const path = require('path');

function parseArgs(argv) {
  const args = { type: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--type') args.type = argv[++i];
  }
  return args;
}

// ── JWT verification ─────────────────────────────────────────────────────────
function verifyJwt() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET is not set or is shorter than 32 characters.');
  }
  // Use the same jsonwebtoken library the app uses to confirm compatibility.
  const jwt = require(path.resolve(__dirname, '../backend/node_modules/jsonwebtoken'));
  const token = jwt.sign({ sub: 'rotation-verify', iat: Math.floor(Date.now() / 1000) }, secret, {
    algorithm: 'HS256',
    expiresIn: '30s',
  });
  const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
  if (decoded.sub !== 'rotation-verify') {
    throw new Error('JWT round-trip produced unexpected payload.');
  }
  console.log('✓ JWT_SECRET is valid: sign → verify round-trip succeeded.');
}

// ── Webhook encryption key verification ──────────────────────────────────────
function verifyWebhook() {
  const { encryptWebhookSecret, decryptWebhookSecret } = require(
    path.resolve(__dirname, '../backend/src/services/webhookSecretEncryption')
  );
  // Use a fixed-length dummy secret (32 bytes = typical HMAC key size).
  const dummy = crypto.randomBytes(32).toString('hex');
  const encrypted = encryptWebhookSecret(dummy);
  const decrypted = decryptWebhookSecret(encrypted);
  if (decrypted !== dummy) {
    throw new Error('Webhook encryption key round-trip produced a mismatch — key is invalid.');
  }
  console.log('✓ WEBHOOK_SECRET_ENCRYPTION_KEY is valid: encrypt → decrypt round-trip succeeded.');
}

// ── Signer master key verification ───────────────────────────────────────────
function verifySigner() {
  const { encryptSecretKey, decryptSecretKey } = require(
    path.resolve(__dirname, '../backend/src/utils/signerKeyManager')
  );
  // A Stellar secret key is 56 characters (S…).  Use a syntactically valid
  // test key that never appears in the repo as a real credential.
  const dummyKey = 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const blob = encryptSecretKey(dummyKey);
  const recovered = decryptSecretKey(blob);
  if (recovered !== dummyKey) {
    throw new Error('Signer master key round-trip produced a mismatch — key is invalid.');
  }
  console.log('✓ SIGNER_MASTER_KEY is valid: encrypt → decrypt round-trip succeeded.');
}

const CHECKS = { jwt: verifyJwt, webhook: verifyWebhook, signer: verifySigner };

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.type || !CHECKS[args.type]) {
    console.error(`Usage: node scripts/verify-rotation.js --type <jwt|webhook|signer>`);
    console.error(`Available types: ${Object.keys(CHECKS).join(', ')}`);
    process.exit(1);
  }

  try {
    CHECKS[args.type]();
    console.log(`\nVerification PASSED for type: ${args.type}`);
    console.log('The new credential is usable. Proceed to drop the old credential and record the rotation.');
    process.exit(0);
  } catch (err) {
    console.error(`\nVerification FAILED for type: ${args.type}`);
    console.error(`Error: ${err.message}`);
    console.error('\nACTION REQUIRED: Roll back by restoring the previous secret value.');
    console.error('See docs/runbooks/secret-rotation-rollback.md for rollback steps.');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { verifyJwt, verifyWebhook, verifySigner };
