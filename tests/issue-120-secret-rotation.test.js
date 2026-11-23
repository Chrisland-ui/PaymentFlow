'use strict';

/**
 * tests/issue-120-secret-rotation.test.js
 *
 * Verifies that the secret rotation infrastructure added in issue #671 is
 * correctly in place:
 *   - gitleaks configuration exists and contains the Stellar secret key rule
 *   - husky pre-commit hook is installed and references gitleaks
 *   - secret rotation runbook exists and covers all required secret types
 *   - package.json has a `prepare` script that installs husky
 *   - CI workflow includes the gitleaks scan job
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

describe('issue-120: secret rotation and scanning infrastructure', () => {
  // ── gitleaks configuration ────────────────────────────────────────────────

  describe('.gitleaks.toml', () => {
    const configPath = path.join(ROOT, '.gitleaks.toml');

    test('file exists', () => {
      expect(fs.existsSync(configPath)).toBe(true);
    });

    test('contains a Stellar secret key rule', () => {
      const src = fs.readFileSync(configPath, 'utf8');
      expect(src).toContain('stellar-secret-key');
    });

    test('Stellar rule regex covers S + 55 Base32 chars', () => {
      const src = fs.readFileSync(configPath, 'utf8');
      // The regex must reference [A-Z2-7] (Base32 alphabet) and 55 repetitions
      expect(src).toMatch(/\[A-Z2-7\]/);
      expect(src).toContain('{55}');
    });

    test('extends default gitleaks ruleset', () => {
      const src = fs.readFileSync(configPath, 'utf8');
      expect(src).toContain('useDefault = true');
    });

    test('has a global allowlist excluding test fixtures', () => {
      const src = fs.readFileSync(configPath, 'utf8');
      expect(src).toContain('[allowlist]');
      expect(src).toContain('scanRepoSecrets');
    });
  });

  // ── husky pre-commit hook ─────────────────────────────────────────────────

  describe('.husky/pre-commit', () => {
    const hookPath = path.join(ROOT, '.husky', 'pre-commit');

    test('file exists', () => {
      expect(fs.existsSync(hookPath)).toBe(true);
    });

    test('references gitleaks', () => {
      const src = fs.readFileSync(hookPath, 'utf8');
      expect(src).toContain('gitleaks');
    });

    test('uses --staged flag to scan only staged changes', () => {
      const src = fs.readFileSync(hookPath, 'utf8');
      expect(src).toContain('--staged');
    });

    test('references .gitleaks.toml config', () => {
      const src = fs.readFileSync(hookPath, 'utf8');
      expect(src).toContain('.gitleaks.toml');
    });

    test('is executable', () => {
      const mode = fs.statSync(hookPath).mode;
      // owner execute bit (0o100)
      expect(mode & 0o100).toBeTruthy();
    });
  });

  // ── package.json prepare script ───────────────────────────────────────────

  describe('package.json', () => {
    const pkgPath = path.join(ROOT, 'package.json');
    let pkg;

    beforeAll(() => {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    });

    test('has a prepare script', () => {
      expect(pkg.scripts).toHaveProperty('prepare');
    });

    test('prepare script installs husky', () => {
      expect(pkg.scripts.prepare).toContain('husky');
    });

    test('husky is listed in devDependencies', () => {
      expect(pkg.devDependencies).toHaveProperty('husky');
    });
  });

  // ── CI workflow ───────────────────────────────────────────────────────────

  describe('CI workflow gitleaks job', () => {
    const workflowPath = path.join(ROOT, '.github', 'workflows', 'ci.yml');

    test('ci.yml exists', () => {
      expect(fs.existsSync(workflowPath)).toBe(true);
    });

    test('contains a gitleaks scan job', () => {
      const src = fs.readFileSync(workflowPath, 'utf8');
      expect(src).toContain('gitleaks-action');
    });

    test('gitleaks job is in the ci-gate needs list', () => {
      const src = fs.readFileSync(workflowPath, 'utf8');
      expect(src).toContain('secret-scan-gitleaks');
    });
  });

  // ── Secret rotation runbook ───────────────────────────────────────────────

  describe('docs/runbooks/secret-rotation.md', () => {
    const runbookPath = path.join(ROOT, 'docs', 'runbooks', 'secret-rotation.md');

    test('file exists', () => {
      expect(fs.existsSync(runbookPath)).toBe(true);
    });

    test('covers JWT secret rotation', () => {
      const src = fs.readFileSync(runbookPath, 'utf8');
      expect(src.toLowerCase()).toContain('jwt');
    });

    test('covers Stellar signer key rotation', () => {
      const src = fs.readFileSync(runbookPath, 'utf8');
      expect(src.toLowerCase()).toContain('stellar');
    });

    test('covers MongoDB credential rotation', () => {
      const src = fs.readFileSync(runbookPath, 'utf8');
      expect(src.toLowerCase()).toContain('mongodb');
    });

    test('covers webhook HMAC secret rotation', () => {
      const src = fs.readFileSync(runbookPath, 'utf8');
      expect(src.toLowerCase()).toContain('webhook');
    });

    test('references the scan-repo-secrets script', () => {
      const src = fs.readFileSync(runbookPath, 'utf8');
      expect(src).toContain('scan-repo-secrets');
    });
  });
});
