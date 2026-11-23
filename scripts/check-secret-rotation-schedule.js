#!/usr/bin/env node
'use strict';

/**
 * check-secret-rotation-schedule.js
 *
 * Reads the last-rotation dates for each managed secret from environment
 * variables (set as GitHub Secrets in CI, or locally for testing) and
 * checks whether any secret is past its rotation due date.
 *
 * Outputs GitHub Actions step output variables:
 *   overdue_secrets  — comma-separated list of overdue secret names (empty if none)
 *   any_overdue      — 'true' | 'false'
 *
 * Rotation schedule (defined in docs/secret-rotation-schedule.md):
 *   JWT_SECRET                    — 90  days
 *   WEBHOOK_SECRET_ENCRYPTION_KEY — 90  days
 *   SIGNER_MASTER_KEY             — 180 days
 *   MongoDB credentials           — 180 days
 *
 * Environment variables:
 *   LAST_JWT_ROTATION         — ISO-8601 date of last JWT_SECRET rotation
 *   LAST_WEBHOOK_ENC_ROTATION — ISO-8601 date of last WEBHOOK_SECRET_ENCRYPTION_KEY rotation
 *   LAST_SIGNER_ROTATION      — ISO-8601 date of last SIGNER_MASTER_KEY rotation
 *   LAST_MONGO_ROTATION       — ISO-8601 date of last MongoDB credential rotation
 *   GITHUB_OUTPUT             — set automatically by GitHub Actions runner
 */

const fs = require('fs');
const path = require('path');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Rotation schedule: { envVar, displayName, maxAgeDays }
const ROTATION_SCHEDULE = [
  {
    envVar: 'LAST_JWT_ROTATION',
    displayName: 'JWT_SECRET',
    maxAgeDays: 90,
    runbook: 'scripts/rotate-jwt-secret.js',
  },
  {
    envVar: 'LAST_WEBHOOK_ENC_ROTATION',
    displayName: 'WEBHOOK_SECRET_ENCRYPTION_KEY',
    maxAgeDays: 90,
    runbook: 'scripts/rotate-webhook-encryption-key.js',
  },
  {
    envVar: 'LAST_SIGNER_ROTATION',
    displayName: 'SIGNER_MASTER_KEY',
    maxAgeDays: 180,
    runbook: 'scripts/rotate-signer-key-staged.js',
  },
  {
    envVar: 'LAST_MONGO_ROTATION',
    displayName: 'MongoDB credentials',
    maxAgeDays: 180,
    runbook: 'docs/secret-rotation-schedule.md#mongodb-credentials',
  },
];

/**
 * Parse a date string. Returns null if the value is missing or unparseable.
 * @param {string|undefined} value
 * @returns {Date|null}
 */
function parseDate(value) {
  if (!value || value.trim() === '') return null;
  const d = new Date(value.trim());
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Write a GitHub Actions step output variable.
 * Falls back to console.log when GITHUB_OUTPUT is not set (local testing).
 * @param {string} name
 * @param {string} value
 */
function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    // GitHub Actions multi-line safe format
    fs.appendFileSync(outputFile, `${name}=${value}\n`);
  } else {
    console.log(`[output] ${name}=${value}`);
  }
}

function main() {
  const now = new Date();
  const overdue = [];
  const results = [];

  for (const secret of ROTATION_SCHEDULE) {
    const lastRotatedRaw = process.env[secret.envVar];
    const lastRotated = parseDate(lastRotatedRaw);

    if (!lastRotated) {
      // Secret rotation date is not recorded — treat as overdue to be safe.
      const entry = {
        secret: secret.displayName,
        status: 'unknown',
        message: `${secret.envVar} is not set. Unable to determine last rotation date. Treating as overdue.`,
        runbook: secret.runbook,
      };
      results.push(entry);
      overdue.push(secret.displayName);
      console.log(`::warning::${entry.message}`);
      continue;
    }

    const ageMs = now - lastRotated;
    const ageDays = Math.floor(ageMs / MS_PER_DAY);
    const dueDate = new Date(lastRotated.getTime() + secret.maxAgeDays * MS_PER_DAY);
    const daysUntilDue = Math.ceil((dueDate - now) / MS_PER_DAY);
    const isOverdue = ageDays >= secret.maxAgeDays;

    const entry = {
      secret: secret.displayName,
      lastRotatedAt: lastRotated.toISOString(),
      ageDays,
      maxAgeDays: secret.maxAgeDays,
      dueDate: dueDate.toISOString(),
      daysUntilDue: isOverdue ? 0 : daysUntilDue,
      status: isOverdue ? 'overdue' : (daysUntilDue <= 14 ? 'due_soon' : 'ok'),
      runbook: secret.runbook,
    };
    results.push(entry);

    if (isOverdue) {
      overdue.push(secret.displayName);
      console.log(
        `::error::${secret.displayName} is OVERDUE for rotation. Last rotated: ${lastRotated.toISOString()} (${ageDays} days ago, max ${secret.maxAgeDays} days). Runbook: ${secret.runbook}`
      );
    } else if (daysUntilDue <= 14) {
      console.log(
        `::warning::${secret.displayName} rotation is due in ${daysUntilDue} day(s) (${dueDate.toISOString()}). Runbook: ${secret.runbook}`
      );
    } else {
      console.log(
        `✓ ${secret.displayName} — last rotated ${ageDays} days ago, due in ${daysUntilDue} days (${dueDate.toISOString().slice(0, 10)})`
      );
    }
  }

  // Emit structured audit log entry to stdout (captured by CI logs)
  const auditEntry = {
    timestamp: now.toISOString(),
    service: 'secret-rotation-schedule-check',
    event: 'audit_complete',
    results,
    overdueCount: overdue.length,
    overdueSecrets: overdue,
  };
  console.log('\n--- Audit Log Entry ---');
  console.log(JSON.stringify(auditEntry, null, 2));

  // Set GitHub Actions step outputs
  setOutput('overdue_secrets', overdue.join(','));
  setOutput('any_overdue', overdue.length > 0 ? 'true' : 'false');

  if (overdue.length > 0) {
    console.log(`\n${overdue.length} secret(s) are overdue for rotation: ${overdue.join(', ')}`);
    console.log('See docs/secret-rotation-schedule.md for rotation procedures.');
    process.exit(1);
  } else {
    console.log('\nAll secrets are within their rotation schedule.');
  }
}

main();
