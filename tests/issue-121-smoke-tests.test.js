'use strict';

/**
 * Tests for the post-deployment smoke test suite (#121).
 *
 * Validates the smoke-tests workflow and script structure. Actual HTTP checks
 * are exercised by the script itself at deploy time; here we verify:
 *   - Script structure, security properties, and acceptance criteria
 *   - Workflow structure and required secrets
 *   - Non-production fixture requirement (no hardcoded credentials)
 *   - Cleanup guarantee (token nulled after run)
 */

const fs = require('fs');
const path = require('path');

const SCRIPTS_DIR = path.resolve(__dirname, '../scripts');
const WORKFLOWS_DIR = path.resolve(__dirname, '../.github/workflows');

describe('Post-deployment smoke tests (#121)', () => {
  describe('smoke-tests.js script', () => {
    let script;
    beforeAll(() => {
      script = fs.readFileSync(path.join(SCRIPTS_DIR, 'smoke-tests.js'), 'utf8');
    });

    it('script file exists', () => {
      expect(fs.existsSync(path.join(SCRIPTS_DIR, 'smoke-tests.js'))).toBe(true);
    });

    it('uses only Node.js built-in modules (no npm install required)', () => {
      // Should only require https, http, url — no third-party packages.
      const requireStatements = script.match(/require\(['"]([^'"]+)['"]\)/g) || [];
      const externalDeps = requireStatements.filter((r) => {
        const mod = r.match(/require\(['"]([^'"]+)['"]\)/)[1];
        return !mod.startsWith('.') && !['https', 'http', 'url', 'path', 'fs', 'crypto'].includes(mod);
      });
      expect(externalDeps).toHaveLength(0);
    });

    it('reads credentials exclusively from environment variables', () => {
      expect(script).toContain('process.env.SMOKE_BACKEND_URL');
      expect(script).toContain('process.env.SMOKE_FRONTEND_URL');
      expect(script).toContain('process.env.SMOKE_ADMIN_EMAIL');
      expect(script).toContain('process.env.SMOKE_ADMIN_PASSWORD');
    });

    it('does not contain hardcoded credential values', () => {
      // No email-looking hardcoded values
      expect(script).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      // No base64 or hex that looks like a real secret
      expect(script).not.toMatch(/(?<!['"=])[A-Za-z0-9+/]{32,}={0,2}(?!['".])/);
    });

    it('validates config and exits if required env vars are missing', () => {
      expect(script).toContain('validateConfig');
      expect(script).toContain('process.exit(1)');
    });

    it('exits non-zero when any check fails', () => {
      const exitCalls = (script.match(/process\.exit\(1\)/g) || []).length;
      expect(exitCalls).toBeGreaterThan(0);
    });

    it('exits zero when all checks pass', () => {
      expect(script).toContain('process.exit(0)');
    });

    it('covers all required smoke checks from acceptance criteria', () => {
      // health liveness
      expect(script).toContain('/health/live');
      // health readiness
      expect(script).toContain('/health/ready');
      // authentication
      expect(script).toContain('/api/auth/login');
      // payment read
      expect(script).toContain('/api/payments');
      // queue
      expect(script).toContain('/api/admin/retry-queue');
      // frontend
      expect(script).toContain('FRONTEND_URL');
    });

    it('token is nulled after the run (cleanup guaranteed)', () => {
      // The script must set token = null at the end of checks.
      expect(script).toContain('token = null');
    });

    it('never echoes or logs the token or password', () => {
      // No console.log/console.error calls that include the token variable
      // directly as a string interpolation.
      expect(script).not.toMatch(/console\.(log|error)\([^)]*token[^)]*\)/);
      expect(script).not.toMatch(/console\.(log|error)\([^)]*password[^)]*\)/i);
    });

    it('smoke-test account note references non-production-safe fixtures', () => {
      expect(script).toMatch(/smoke.test|non.production/i);
    });

    it('implements retry logic for transient failures', () => {
      expect(script).toContain('withRetry');
      expect(script).toContain('MAX_RETRIES');
    });
  });

  describe('smoke-tests.yml workflow', () => {
    let workflow;
    beforeAll(() => {
      workflow = fs.readFileSync(
        path.join(WORKFLOWS_DIR, 'smoke-tests.yml'),
        'utf8'
      );
    });

    it('workflow file exists', () => {
      expect(fs.existsSync(path.join(WORKFLOWS_DIR, 'smoke-tests.yml'))).toBe(true);
    });

    it('supports manual trigger via workflow_dispatch', () => {
      expect(workflow).toContain('workflow_dispatch:');
    });

    it('supports being called from other workflows via workflow_call', () => {
      expect(workflow).toContain('workflow_call:');
    });

    it('uses GitHub Secrets for all credentials', () => {
      expect(workflow).toContain('secrets.SMOKE_BACKEND_URL');
      expect(workflow).toContain('secrets.SMOKE_ADMIN_EMAIL');
      expect(workflow).toContain('secrets.SMOKE_ADMIN_PASSWORD');
    });

    it('blocks promotion on failure (creates incident issue)', () => {
      expect(workflow).toContain('if: failure()');
      expect(workflow).toContain('Create failure issue');
    });

    it('pages the owner via issue creation on failure', () => {
      // The workflow creates a GitHub issue on failure as the paging mechanism.
      expect(workflow).toContain('github.rest.issues.create');
    });

    it('labels the failure issue as incident', () => {
      expect(workflow).toContain("'incident'");
    });

    it('references rollback instructions in failure issue body', () => {
      expect(workflow).toContain('rollout undo');
    });

    it('uses environment-scoped execution (environment protection rules)', () => {
      expect(workflow).toContain('environment: ${{ inputs.environment }}');
    });

    it('does not hardcode environment-specific URLs', () => {
      // URLs must come from secrets, not from hardcoded values in the workflow.
      expect(workflow).not.toMatch(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
    });
  });
});
