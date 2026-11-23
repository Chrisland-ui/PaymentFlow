#!/usr/bin/env node
/**
 * check-version-drift.js
 *
 * Fails when any shared dependency's declared major version is inconsistent.
 *
 * Two checks are performed:
 *
 *   1. ROOT ↔ WORKSPACE  (original check)
 *      Any package that appears in both the root package.json and a workspace
 *      package.json (backend or frontend) must declare the same major version.
 *
 *   2. BACKEND ↔ FRONTEND  (new — issue #50)
 *      Any package that appears in both the backend package.json and the
 *      frontend package.json must declare the same major version.  Shared
 *      runtime dependencies (e.g. axios, i18next) that diverge between the
 *      two workspaces can cause subtle cross-package inconsistencies that
 *      aren't caught by the root-vs-workspace check alone.
 *
 * Approved exceptions
 * ───────────────────
 * Intentional version differences can be documented in
 * `version-exceptions.json` at the repository root.  Each entry suppresses
 * exactly one expected mismatch:
 *
 *   {
 *     "exceptions": [
 *       {
 *         "package": "axios",
 *         "aLabel": "backend",
 *         "bLabel": "frontend",
 *         "reason": "frontend pins axios@1 for a browser compat shim"
 *       }
 *     ]
 *   }
 *
 * Fields:
 *   package — exact npm package name
 *   aLabel  — one side of the pair (e.g. "root", "backend", "frontend")
 *   bLabel  — the other side
 *   reason  — mandatory human-readable justification (enforced by this script)
 *
 * Usage:
 *   node scripts/check-version-drift.js
 *
 * Exit codes:
 *   0 — no un-excepted major-version drift detected
 *   1 — one or more drift violations found
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse major version from a semver range string (e.g. "^8.0.0" → 8). */
function parseMajor(range) {
  if (!range) return null;
  // Strip leading range specifiers: ^, ~, >=, <=, =, >, <, whitespace
  const cleaned = range.replace(/^[~^>=<\s]+/, '').trim();
  const match = cleaned.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/** Read and parse a package.json, returning a combined dependencies map. */
function readDeps(pkgPath) {
  const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return Object.assign(
    {},
    raw.dependencies    || {},
    raw.devDependencies || {},
    raw.peerDependencies || {}
  );
}

/**
 * Load and validate the version-exceptions.json file (if it exists).
 * Returns a Set of "<package>::<labelA>::<labelB>" keys for fast O(1) lookup.
 * Labels are normalised to lowercase and sorted so the key is symmetric.
 */
function loadExceptions() {
  const exceptionsPath = path.join(ROOT, 'version-exceptions.json');
  if (!fs.existsSync(exceptionsPath)) {
    return new Set();
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(exceptionsPath, 'utf8'));
  } catch (e) {
    console.error(`[version-drift] ERROR: Could not parse version-exceptions.json — ${e.message}`);
    process.exit(1);
  }

  if (!Array.isArray(parsed.exceptions)) {
    console.error(
      '[version-drift] ERROR: version-exceptions.json must have an "exceptions" array.'
    );
    process.exit(1);
  }

  const keys = new Set();
  for (const exc of parsed.exceptions) {
    if (!exc.package || !exc.aLabel || !exc.bLabel || !exc.reason) {
      console.error(
        `[version-drift] ERROR: Every exception entry must have "package", "aLabel", ` +
        `"bLabel", and "reason".  Offending entry: ${JSON.stringify(exc)}`
      );
      process.exit(1);
    }
    // Build a symmetric key: sort the two labels so order does not matter.
    const [labelA, labelB] = [exc.aLabel.toLowerCase(), exc.bLabel.toLowerCase()].sort();
    keys.add(`${exc.package}::${labelA}::${labelB}`);
  }

  return keys;
}

/**
 * Returns true if the given pair has an approved exception.
 * Labels are sorted for symmetric matching.
 */
function isExcepted(exceptions, packageName, labelA, labelB) {
  const [la, lb] = [labelA.toLowerCase(), labelB.toLowerCase()].sort();
  return exceptions.has(`${packageName}::${la}::${lb}`);
}

// ── Load manifests ────────────────────────────────────────────────────────────

const rootDeps     = readDeps(path.join(ROOT, 'package.json'));
const backendPath  = path.join(ROOT, 'backend',  'package.json');
const frontendPath = path.join(ROOT, 'frontend', 'package.json');
const backendDeps  = fs.existsSync(backendPath)  ? readDeps(backendPath)  : {};
const frontendDeps = fs.existsSync(frontendPath) ? readDeps(frontendPath) : {};

const exceptions = loadExceptions();

let violations = 0;

// ── Check 1: root ↔ each workspace ───────────────────────────────────────────

const workspaces = [
  { label: 'backend',  deps: backendDeps  },
  { label: 'frontend', deps: frontendDeps },
];

for (const ws of workspaces) {
  for (const [pkg, wsRange] of Object.entries(ws.deps)) {
    if (!(pkg in rootDeps)) continue; // not in root — nothing to compare

    const rootMajor = parseMajor(rootDeps[pkg]);
    const wsMajor   = parseMajor(wsRange);
    if (rootMajor === null || wsMajor === null) continue;

    if (rootMajor !== wsMajor) {
      if (isExcepted(exceptions, pkg, 'root', ws.label)) {
        console.log(
          `[version-drift] EXCEPTED: "${pkg}" root@${rootMajor} vs ${ws.label}@${wsMajor}`
        );
        continue;
      }
      console.error(
        `[version-drift] MISMATCH: "${pkg}" — root declares major ${rootMajor} ` +
          `(${rootDeps[pkg]}), ${ws.label} declares major ${wsMajor} (${wsRange})`
      );
      violations++;
    }
  }
}

// ── Check 2: backend ↔ frontend shared dependencies (issue #50) ─────────────

for (const [pkg, beRange] of Object.entries(backendDeps)) {
  if (!(pkg in frontendDeps)) continue; // not shared — skip

  const beMajor = parseMajor(beRange);
  const feMajor = parseMajor(frontendDeps[pkg]);
  if (beMajor === null || feMajor === null) continue;

  if (beMajor !== feMajor) {
    if (isExcepted(exceptions, pkg, 'backend', 'frontend')) {
      console.log(
        `[version-drift] EXCEPTED: "${pkg}" backend@${beMajor} vs frontend@${feMajor}`
      );
      continue;
    }
    console.error(
      `[version-drift] MISMATCH (backend ↔ frontend): "${pkg}" — ` +
        `backend declares major ${beMajor} (${beRange}), ` +
        `frontend declares major ${feMajor} (${frontendDeps[pkg]})`
    );
    violations++;
  }
}

// ── Result ────────────────────────────────────────────────────────────────────

if (violations > 0) {
  console.error(
    `\n${violations} major-version drift violation(s) found.\n` +
    'Options:\n' +
    '  • Align the version ranges in the affected package.json files, or\n' +
    '  • Add an approved exception to version-exceptions.json with a mandatory "reason".\n' +
    'Then re-run: node scripts/check-version-drift.js'
  );
  process.exit(1);
} else {
  console.log('check-version-drift: no major-version drift detected.');
}
