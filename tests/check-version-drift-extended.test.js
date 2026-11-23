'use strict';

/**
 * Tests for issue #50 — extended check-version-drift.js.
 *
 * Verifies:
 *  1. Original root ↔ workspace check still works.
 *  2. New backend ↔ frontend check catches shared-dep mismatches.
 *  3. Approved exceptions in version-exceptions.json suppress violations.
 *  4. Exception entries without a "reason" field cause a hard error.
 *  5. No false positives when no shared deps differ.
 *  6. Exit code 0 when all mismatches are excepted.
 */

const { execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Write a minimal package.json to `dir`.
 */
function writePackage(dir, name, { deps = {}, devDeps = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      dependencies: deps,
      devDependencies: devDeps,
    })
  );
}

/**
 * Run check-version-drift.js in an isolated temp directory.
 * Returns { stdout, stderr, status }.
 */
function runScript(rootDir) {
  const scriptPath = path.join(__dirname, '../scripts/check-version-drift.js');
  let stdout = '';
  let stderr = '';
  let status = 0;

  try {
    stdout = execFileSync(
      process.execPath,
      [scriptPath],
      { cwd: rootDir, env: { ...process.env } }
    ).toString();
  } catch (err) {
    stdout = (err.stdout || '').toString();
    stderr = (err.stderr || '').toString();
    status = err.status || 1;
  }

  return { stdout, stderr: stderr + stdout, status };
}

/**
 * Build a minimal repo structure in a temp directory and return its path.
 */
function buildTempRepo({
  rootDeps = {},
  rootDevDeps = {},
  backendDeps = {},
  backendDevDeps = {},
  frontendDeps = {},
  frontendDevDeps = {},
  exceptions = null,
} = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-test-'));

  writePackage(tmpDir, 'root', { deps: rootDeps, devDeps: rootDevDeps });
  writePackage(path.join(tmpDir, 'backend'), 'backend',
    { deps: backendDeps, devDeps: backendDevDeps });
  writePackage(path.join(tmpDir, 'frontend'), 'frontend',
    { deps: frontendDeps, devDeps: frontendDevDeps });

  if (exceptions !== null) {
    fs.writeFileSync(
      path.join(tmpDir, 'version-exceptions.json'),
      JSON.stringify({ exceptions })
    );
  }

  return tmpDir;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Issue #50 — check-version-drift.js (extended)', () => {

  // ── Root ↔ workspace (existing behaviour) ──────────────────────────────────

  test('passes when root and workspace versions match', () => {
    const dir = buildTempRepo({
      rootDeps: { axios: '^1.6.0' },
      backendDeps: { axios: '^1.14.0' },
    });
    const { status } = runScript(dir);
    expect(status).toBe(0);
  });

  test('fails when root and workspace major versions differ', () => {
    const dir = buildTempRepo({
      rootDeps: { axios: '^1.6.0' },
      backendDeps: { axios: '^2.0.0' },
    });
    const { status, stderr } = runScript(dir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/MISMATCH/i);
    expect(stderr).toMatch(/axios/);
  });

  // ── Backend ↔ frontend (new check) ─────────────────────────────────────────

  test('passes when backend and frontend share a dep at the same major', () => {
    const dir = buildTempRepo({
      backendDeps:  { axios: '^1.14.0' },
      frontendDeps: { axios: '^1.6.0'  },
    });
    const { status } = runScript(dir);
    expect(status).toBe(0);
  });

  test('fails when backend and frontend share a dep at different majors', () => {
    const dir = buildTempRepo({
      backendDeps:  { axios: '^1.14.0' },
      frontendDeps: { axios: '^2.0.0'  },
    });
    const { status, stderr } = runScript(dir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/backend.*frontend|frontend.*backend/i);
    expect(stderr).toMatch(/axios/);
  });

  test('only flags packages that are shared between backend and frontend', () => {
    const dir = buildTempRepo({
      backendDeps:  { mongoose: '^8.0.0' },  // backend-only
      frontendDeps: { next: '^14.0.0'    },  // frontend-only
    });
    const { status } = runScript(dir);
    // No shared packages → no violations.
    expect(status).toBe(0);
  });

  // ── Exceptions ──────────────────────────────────────────────────────────────

  test('an approved exception suppresses a backend ↔ frontend mismatch', () => {
    const dir = buildTempRepo({
      backendDevDeps:  { eslint: '^9.0.0' },
      frontendDevDeps: { eslint: '^8.0.0' },
      exceptions: [
        {
          package: 'eslint',
          aLabel: 'backend',
          bLabel: 'frontend',
          reason: 'Frontend must stay on ESLint 8 until eslint-config-next supports ESLint 9.',
        },
      ],
    });
    const { status } = runScript(dir);
    expect(status).toBe(0);
  });

  test('exception suppression is symmetric (aLabel/bLabel order does not matter)', () => {
    const dir = buildTempRepo({
      backendDevDeps:  { eslint: '^9.0.0' },
      frontendDevDeps: { eslint: '^8.0.0' },
      exceptions: [
        {
          package: 'eslint',
          aLabel: 'frontend', // reversed order
          bLabel: 'backend',
          reason: 'Same justification — order should not matter.',
        },
      ],
    });
    const { status } = runScript(dir);
    expect(status).toBe(0);
  });

  test('exception without a "reason" field causes a non-zero exit', () => {
    const dir = buildTempRepo({
      backendDevDeps:  { eslint: '^9.0.0' },
      frontendDevDeps: { eslint: '^8.0.0' },
      exceptions: [
        {
          package: 'eslint',
          aLabel: 'backend',
          bLabel: 'frontend',
          // reason is intentionally absent
        },
      ],
    });
    const { status, stderr } = runScript(dir);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/reason/i);
  });

  test('an exception for one package does not suppress violations for another', () => {
    const dir = buildTempRepo({
      backendDeps:     { axios: '^1.0.0' },
      frontendDeps:    { axios: '^2.0.0' },
      backendDevDeps:  { eslint: '^9.0.0' },
      frontendDevDeps: { eslint: '^8.0.0' },
      exceptions: [
        {
          package: 'eslint',
          aLabel: 'backend',
          bLabel: 'frontend',
          reason: 'Approved ESLint divergence.',
        },
      ],
    });
    const { status, stderr } = runScript(dir);
    // eslint is excepted but axios is not → still fails.
    expect(status).toBe(1);
    expect(stderr).toMatch(/axios/);
    expect(stderr).not.toMatch(/eslint.*MISMATCH/i);
  });

  // ── Real repo ───────────────────────────────────────────────────────────────

  test('passes against the actual repository with version-exceptions.json in place', () => {
    const repoRoot = path.join(__dirname, '..');
    const { status } = runScript(repoRoot);
    expect(status).toBe(0);
  });

  test('version-exceptions.json has at least one entry with a non-empty reason', () => {
    const exceptionsPath = path.join(__dirname, '../version-exceptions.json');
    expect(fs.existsSync(exceptionsPath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(exceptionsPath, 'utf8'));
    expect(Array.isArray(data.exceptions)).toBe(true);
    for (const exc of data.exceptions) {
      expect(typeof exc.reason).toBe('string');
      expect(exc.reason.trim().length).toBeGreaterThan(0);
    }
  });
});
