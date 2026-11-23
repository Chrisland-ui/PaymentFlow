'use strict';

/**
 * Tests that k8s manifests define both resource requests AND limits for all
 * containers, and that limits are >= requests (i.e. not inverted).
 *
 * Acceptance criteria from issue #119:
 *  - Values are reviewed against load results (doc: docs/k8s-resource-sizing.md)
 *  - OOM and throttling behaviour is monitored (alert: monitoring/alerts/resource_limits.yml)
 *  - Deployment manifests remain schedulable
 */

const fs = require('fs');
const path = require('path');

const DEPLOY_DIR = path.resolve(__dirname, '../deploy/k8s');

function readManifest(filename) {
  return fs.readFileSync(path.join(DEPLOY_DIR, filename), 'utf8');
}

// Very lightweight YAML field extractor for resources blocks.
// Looks for the pattern:
//   resources:
//     requests:
//       cpu: "Xm"
//       memory: "XMi"
//     limits:
//       cpu: "Xm"
//       memory: "XMi"
function extractResourceBlocks(manifest) {
  const blocks = [];
  // Strip comment lines to simplify parsing (comments interleave in the mongodb manifest)
  const lines = manifest.split('\n').filter((l) => !l.trim().startsWith('#'));
  let i = 0;
  while (i < lines.length) {
    if (/^\s+resources:\s*$/.test(lines[i])) {
      const block = { requests: {}, limits: {} };
      let section = null;
      i++;
      while (i < lines.length && /^\s+(requests:|limits:|cpu:|memory:)/.test(lines[i])) {
        const trimmed = lines[i].trim();
        if (trimmed === 'requests:') { section = 'requests'; }
        else if (trimmed === 'limits:') { section = 'limits'; }
        else if (section) {
          const [key, val] = trimmed.split(':').map((s) => s.trim().replace(/^"|"$/g, ''));
          if (key === 'cpu' || key === 'memory') block[section][key] = val;
        }
        i++;
      }
      blocks.push(block);
    } else {
      i++;
    }
  }
  return blocks;
}

function parseMi(value) {
  if (!value) return 0;
  const m = value.match(/^(\d+)(Mi|Gi|m|)$/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  if (m[2] === 'Gi') return n * 1024;
  if (m[2] === 'Mi') return n;
  return n;
}

function parseCpu(value) {
  if (!value) return 0;
  const m = value.match(/^(\d+)(m|)$/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return m[2] === 'm' ? n : n * 1000;
}

describe('Kubernetes resource requests and limits (#119)', () => {
  const manifests = [
    'backend-deployment.yaml',
    'frontend-deployment.yaml',
    'redis.yaml',
    'mongodb-statefulset.yaml',
  ];

  manifests.forEach((filename) => {
    describe(filename, () => {
      let blocks;
      beforeAll(() => {
        const manifest = readManifest(filename);
        // Only test container resources blocks (which have cpu/memory), not
        // volumeClaimTemplates blocks which only have storage.
        blocks = extractResourceBlocks(manifest).filter(
          (b) => b.requests.cpu || b.requests.memory || b.limits.cpu || b.limits.memory
        );
      });

      it('has at least one resources block', () => {
        expect(blocks.length).toBeGreaterThan(0);
      });

      it('every resources block has requests.cpu', () => {
        blocks.forEach((b) => {
          expect(b.requests.cpu).toBeDefined();
        });
      });

      it('every resources block has requests.memory', () => {
        blocks.forEach((b) => {
          expect(b.requests.memory).toBeDefined();
        });
      });

      it('every resources block has limits.cpu', () => {
        blocks.forEach((b) => {
          expect(b.limits.cpu).toBeDefined();
        });
      });

      it('every resources block has limits.memory', () => {
        blocks.forEach((b) => {
          expect(b.limits.memory).toBeDefined();
        });
      });

      it('cpu limit >= cpu request in every block', () => {
        blocks.forEach((b) => {
          const req = parseCpu(b.requests.cpu);
          const lim = parseCpu(b.limits.cpu);
          expect(lim).toBeGreaterThanOrEqual(req);
        });
      });

      it('memory limit >= memory request in every block', () => {
        blocks.forEach((b) => {
          const req = parseMi(b.requests.memory);
          const lim = parseMi(b.limits.memory);
          expect(lim).toBeGreaterThanOrEqual(req);
        });
      });
    });
  });

  describe('sizing documentation', () => {
    it('docs/k8s-resource-sizing.md exists', () => {
      const docPath = path.resolve(__dirname, '../docs/k8s-resource-sizing.md');
      expect(fs.existsSync(docPath)).toBe(true);
    });

    it('alert rules file exists for resource limits', () => {
      const alertPath = path.resolve(__dirname, '../monitoring/alerts/resource_limits.yml');
      expect(fs.existsSync(alertPath)).toBe(true);
    });

    it('resource_limits.yml contains OOM memory alert', () => {
      const alertPath = path.resolve(__dirname, '../monitoring/alerts/resource_limits.yml');
      const content = fs.readFileSync(alertPath, 'utf8');
      expect(content).toMatch(/BackendMemoryCritical|OOM/);
    });

    it('resource_limits.yml contains CPU throttling alert', () => {
      const alertPath = path.resolve(__dirname, '../monitoring/alerts/resource_limits.yml');
      const content = fs.readFileSync(alertPath, 'utf8');
      expect(content).toMatch(/BackendCPUThrottled|throttled/i);
    });
  });
});
