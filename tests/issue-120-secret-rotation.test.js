'use strict';

/**
 * Tests for the secret rotation automation (#120).
 *
 * Validates:
 *  - The rotation workflow file exists and is structurally correct
 *  - The verify-rotation script covers all three rotation types
 *  - Secrets never appear in workflow logs (no plaintext secret echoing)
 *  - Rollback runbook exists
 *  - Each rotation type requires confirmation / dry-run gate
 */

const fs = require('fs');
const path = require('path');

const WORKFLOWS_DIR = path.resolve(__dirname, '../.github/workflows');
const SCRIPTS_DIR = path.resolve(__dirname, '../scripts');
const RUNBOOKS_DIR = path.resolve(__dirname, '../docs/runbooks');

describe('Secret rotation automation (#120)', () => {
  describe('secret-rotation.yml workflow', () => {
    let workflow;
    beforeAll(() => {
      workflow = fs.readFileSync(
        path.join(WORKFLOWS_DIR, 'secret-rotation.yml'),
        'utf8'
      );
    });

    it('workflow file exists', () => {
      expect(fs.existsSync(path.join(WORKFLOWS_DIR, 'secret-rotation.yml'))).toBe(true);
    });

    it('is triggered only by workflow_dispatch (not push/PR)', () => {
      expect(workflow).toContain('workflow_dispatch:');
      expect(workflow).not.toMatch(/on:\s*\n\s*push:/);
    });

    it('requires dry_run input with default true', () => {
      expect(workflow).toContain('dry_run:');
      expect(workflow).toContain('default: true');
    });

    it('supports all three rotation types', () => {
      expect(workflow).toContain('jwt');
      expect(workflow).toContain('webhook-encryption');
      expect(workflow).toContain('signer-master');
    });

    it('uses GitHub Secrets for MONGO_URI (not hardcoded)', () => {
      expect(workflow).toContain('secrets.MONGO_URI');
    });

    it('does not echo any secret value in run blocks', () => {
      // The workflow must not use "echo $JWT_SECRET" or similar patterns
      // that would expose credential values in CI logs.
      expect(workflow).not.toMatch(/echo\s+\$\{?\s*(JWT_SECRET|SIGNER_MASTER_KEY|WEBHOOK_SECRET)/);
      expect(workflow).not.toMatch(/echo\s+\$\{?\s*MONGO_URI/);
    });

    it('pre-rotation health check aborts if deployment is not ready', () => {
      expect(workflow).toContain('Pre-rotation health check');
      expect(workflow).toContain('Aborting');
    });

    it('references the rotation scripts', () => {
      expect(workflow).toContain('rotate-jwt-secret.js');
      expect(workflow).toContain('rotate-webhook-encryption-key.js');
      expect(workflow).toContain('rotate-signer-master-key.js');
    });

    it('JWT rotation uses --confirm flag', () => {
      expect(workflow).toContain('--confirm');
    });

    it('post-rotation verification step exists', () => {
      expect(workflow).toContain('Post-rotation rollout verification');
    });

    it('records audit trail after JWT rotation', () => {
      expect(workflow).toContain('Rotation audit record');
    });
  });

  describe('verify-rotation.js script', () => {
    let script;
    beforeAll(() => {
      script = fs.readFileSync(
        path.join(SCRIPTS_DIR, 'verify-rotation.js'),
        'utf8'
      );
    });

    it('script exists', () => {
      expect(fs.existsSync(path.join(SCRIPTS_DIR, 'verify-rotation.js'))).toBe(true);
    });

    it('supports jwt type', () => {
      expect(script).toMatch(/jwt.*verifyJwt|verifyJwt.*jwt/);
    });

    it('supports webhook type', () => {
      expect(script).toMatch(/webhook.*verifyWebhook|verifyWebhook.*webhook/);
    });

    it('supports signer type', () => {
      expect(script).toMatch(/signer.*verifySigner|verifySigner.*signer/);
    });

    it('exports individual verify functions for unit testing', () => {
      expect(script).toContain('module.exports');
      expect(script).toContain('verifyJwt');
      expect(script).toContain('verifyWebhook');
      expect(script).toContain('verifySigner');
    });

    it('explicitly states it never logs secret values', () => {
      expect(script).toMatch(/never prints|never.*log|no.*secret.*value|SECURITY/i);
    });

    it('exits non-zero on verification failure', () => {
      expect(script).toContain('process.exit(1)');
    });

    it('references rollback runbook on failure', () => {
      expect(script).toContain('secret-rotation-rollback');
    });
  });

  describe('rollback runbook', () => {
    let runbook;
    beforeAll(() => {
      runbook = fs.readFileSync(
        path.join(RUNBOOKS_DIR, 'secret-rotation-rollback.md'),
        'utf8'
      );
    });

    it('rollback runbook exists', () => {
      expect(fs.existsSync(path.join(RUNBOOKS_DIR, 'secret-rotation-rollback.md'))).toBe(true);
    });

    it('covers JWT rollback', () => {
      expect(runbook).toContain('JWT secret rollback');
    });

    it('covers webhook encryption key rollback', () => {
      expect(runbook).toContain('Webhook encryption key rollback');
    });

    it('covers signer master key rollback', () => {
      expect(runbook).toContain('Signer master key rollback');
    });

    it('documents the apply vs dry-run distinction', () => {
      expect(runbook).toContain('--apply');
    });

    it('does not contain any real-format secret values', () => {
      // Must not contain 48+ character hex or base64 strings that look like real keys.
      // This regex catches anything that looks like a generated secret value.
      expect(runbook).not.toMatch(/[A-Fa-f0-9]{48,}/);
    });

    it('requires recording rollback in incident log', () => {
      expect(runbook).toMatch(/incident.*log|record.*rollback/i);
    });
  });

  describe('existing rotation scripts are unmodified (contract)', () => {
    const scripts = [
      'rotate-jwt-secret.js',
      'rotate-webhook-encryption-key.js',
      'rotate-signer-master-key.js',
      'provision-k8s-secrets.sh',
    ];

    scripts.forEach((script) => {
      it(`${script} exists`, () => {
        expect(fs.existsSync(path.join(SCRIPTS_DIR, script))).toBe(true);
      });
    });

    it('rotate-jwt-secret.js exports rotate() for unit testing', () => {
      const content = fs.readFileSync(path.join(SCRIPTS_DIR, 'rotate-jwt-secret.js'), 'utf8');
      expect(content).toContain('module.exports');
      expect(content).toContain('rotate');
    });

    it('rotate-webhook-encryption-key.js exports rotateAll() for unit testing', () => {
      const content = fs.readFileSync(path.join(SCRIPTS_DIR, 'rotate-webhook-encryption-key.js'), 'utf8');
      expect(content).toContain('module.exports');
      expect(content).toContain('rotateAll');
    });

    it('rotate-signer-master-key.js exports rotateAll() for unit testing', () => {
      const content = fs.readFileSync(path.join(SCRIPTS_DIR, 'rotate-signer-master-key.js'), 'utf8');
      expect(content).toContain('module.exports');
      expect(content).toContain('rotateAll');
    });
  });
});
