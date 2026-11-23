'use strict';

/**
 * Tests that k8s manifests define correct probe configuration:
 *  - startupProbe is present on all workloads
 *  - readinessProbe uses /health/ready for the backend
 *  - livenessProbe uses /health/live for the backend
 *  - terminationGracePeriodSeconds is set
 *
 * These are parsed as plain text checks rather than YAML parsing to avoid
 * adding a test-only dependency on a YAML library.
 */

const fs = require('fs');
const path = require('path');

const DEPLOY_DIR = path.resolve(__dirname, '../deploy/k8s');

function readManifest(filename) {
  return fs.readFileSync(path.join(DEPLOY_DIR, filename), 'utf8');
}

describe('Kubernetes probe configuration (#118)', () => {
  describe('backend-deployment.yaml', () => {
    let manifest;
    beforeAll(() => {
      manifest = readManifest('backend-deployment.yaml');
    });

    it('defines a startupProbe', () => {
      expect(manifest).toContain('startupProbe:');
    });

    it('uses /health/live for startupProbe', () => {
      // startupProbe must use the lightweight liveness endpoint, not the full
      // /health which includes dependency checks that may not be ready yet.
      const startupSection = manifest.slice(manifest.indexOf('startupProbe:'));
      const nextProbeIndex = Math.min(
        startupSection.indexOf('livenessProbe:'),
        startupSection.indexOf('readinessProbe:')
      );
      const startupBlock = startupSection.slice(0, nextProbeIndex);
      expect(startupBlock).toContain('/health/live');
    });

    it('uses /health/live for livenessProbe', () => {
      const livenessSection = manifest.slice(manifest.indexOf('livenessProbe:'));
      const nextProbeIndex = livenessSection.indexOf('readinessProbe:');
      const livenessBlock = livenessSection.slice(0, nextProbeIndex);
      expect(livenessBlock).toContain('/health/live');
    });

    it('uses /health/ready for readinessProbe', () => {
      const readinessSection = manifest.slice(manifest.indexOf('readinessProbe:'));
      expect(readinessSection).toContain('/health/ready');
    });

    it('sets terminationGracePeriodSeconds', () => {
      expect(manifest).toContain('terminationGracePeriodSeconds:');
    });

    it('livenessProbe does not use /health/ready (would restart pod on dependency outage)', () => {
      const livenessSection = manifest.slice(manifest.indexOf('livenessProbe:'));
      const nextProbeIndex = livenessSection.indexOf('readinessProbe:');
      const livenessBlock = livenessSection.slice(0, nextProbeIndex);
      // Strip comment lines before checking so inline comments don't create false positives.
      const livenessBlockNoComments = livenessBlock
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');
      expect(livenessBlockNoComments).not.toContain('/health/ready');
    });

    it('startupProbe failureThreshold provides at least 60 s startup budget', () => {
      // Extract startupProbe block
      const startupIdx = manifest.indexOf('startupProbe:');
      const afterStartup = manifest.slice(startupIdx);
      const nextProbe = Math.min(
        afterStartup.indexOf('livenessProbe:'),
        afterStartup.indexOf('readinessProbe:')
      );
      const startupBlock = afterStartup.slice(0, nextProbe);

      const periodMatch = startupBlock.match(/periodSeconds:\s*(\d+)/);
      const failureMatch = startupBlock.match(/failureThreshold:\s*(\d+)/);

      expect(periodMatch).not.toBeNull();
      expect(failureMatch).not.toBeNull();

      const budget = parseInt(periodMatch[1], 10) * parseInt(failureMatch[1], 10);
      expect(budget).toBeGreaterThanOrEqual(60);
    });
  });

  describe('frontend-deployment.yaml', () => {
    let manifest;
    beforeAll(() => {
      manifest = readManifest('frontend-deployment.yaml');
    });

    it('defines a startupProbe', () => {
      expect(manifest).toContain('startupProbe:');
    });

    it('defines a livenessProbe', () => {
      expect(manifest).toContain('livenessProbe:');
    });

    it('defines a readinessProbe', () => {
      expect(manifest).toContain('readinessProbe:');
    });

    it('sets terminationGracePeriodSeconds', () => {
      expect(manifest).toContain('terminationGracePeriodSeconds:');
    });
  });

  describe('redis.yaml', () => {
    let manifest;
    beforeAll(() => {
      manifest = readManifest('redis.yaml');
    });

    it('defines a startupProbe', () => {
      expect(manifest).toContain('startupProbe:');
    });

    it('defines a livenessProbe', () => {
      expect(manifest).toContain('livenessProbe:');
    });

    it('defines a readinessProbe', () => {
      expect(manifest).toContain('readinessProbe:');
    });

    it('sets terminationGracePeriodSeconds', () => {
      expect(manifest).toContain('terminationGracePeriodSeconds:');
    });
  });

  describe('canary backend-patch.yaml', () => {
    let manifest;
    beforeAll(() => {
      manifest = fs.readFileSync(
        path.join(DEPLOY_DIR, 'overlays/canary/backend-patch.yaml'),
        'utf8'
      );
    });

    it('canary readinessProbe uses /health/ready to validate post-migration state', () => {
      expect(manifest).toContain('/health/ready');
    });
  });

  describe('mongodb-statefulset.yaml', () => {
    let manifest;
    beforeAll(() => {
      manifest = readManifest('mongodb-statefulset.yaml');
    });

    it('defines a readinessProbe', () => {
      expect(manifest).toContain('readinessProbe:');
    });

    it('readinessProbe checks isWritablePrimary to prevent routing to non-primary nodes', () => {
      expect(manifest).toContain('isWritablePrimary');
    });

    it('defines a livenessProbe', () => {
      expect(manifest).toContain('livenessProbe:');
    });
  });
});
