'use strict';

/**
 * CI Configuration Validation for the Soroban contract-tests job.
 *
 * This test verifies that the contract-tests job in .github/workflows/ci.yml
 * is correctly configured — it checks for:
 *   - Job existence
 *   - Docker-based Stellar node startup
 *   - Contract compilation step
 *   - Rust unit test step
 *   - Artifact upload step
 *   - Cargo caching step
 *   - Inclusion in the ci-gate needs list (PR gating)
 *
 * Following the pattern of tests/ciCaching.test.js.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ciPath = path.join(__dirname, '../.github/workflows/ci.yml');

function loadCiConfig() {
  const ciContent = fs.readFileSync(ciPath, 'utf8');
  return yaml.load(ciContent);
}

describe('Contract Tests CI Configuration', () => {
  let ciConfig;

  beforeAll(() => {
    ciConfig = loadCiConfig();
  });

  // ── Job existence ────────────────────────────────────────────────────────

  test('should have a contract-tests job defined', () => {
    expect(ciConfig.jobs).toBeDefined();
    expect(ciConfig.jobs['contract-tests']).toBeDefined();
  });

  test('contract-tests job should have a descriptive name', () => {
    const job = ciConfig.jobs['contract-tests'];
    expect(job.name).toBeDefined();
    expect(job.name.toLowerCase()).toContain('contract');
  });

  test('contract-tests job should run on ubuntu-latest', () => {
    const job = ciConfig.jobs['contract-tests'];
    expect(job['runs-on']).toBe('ubuntu-latest');
  });

  // ── Contract compilation ──────────────────────────────────────────────────

  test('should have a step that compiles the contract to Wasm', () => {
    const steps = ciConfig.jobs['contract-tests'].steps;
    const compileStep = steps.find(
      (step) =>
        step.name &&
        (step.name.toLowerCase().includes('compile') ||
          step.name.toLowerCase().includes('build')) &&
        step.run &&
        (step.run.includes('cargo build') || step.run.includes('cargo build'))
    );
    expect(compileStep).toBeDefined();
    expect(compileStep.run).toContain('wasm32-unknown-unknown');
  });

  // ── Rust unit tests ──────────────────────────────────────────────────────

  test('should have a step that runs Rust unit tests', () => {
    const steps = ciConfig.jobs['contract-tests'].steps;
    const testStep = steps.find(
      (step) =>
        step.name &&
        step.name.toLowerCase().includes('unit') &&
        step.run &&
        step.run.includes('cargo test')
    );
    expect(testStep).toBeDefined();
  });

  // ── Stellar node via Docker ──────────────────────────────────────────────

  test('should have a step that starts a local Stellar node via Docker', () => {
    const steps = ciConfig.jobs['contract-tests'].steps;
    const dockerStep = steps.find(
      (step) =>
        step.name &&
        step.name.toLowerCase().includes('stellar') &&
        step.name.toLowerCase().includes('node') &&
        step.run &&
        step.run.includes('docker')
    );
    expect(dockerStep).toBeDefined();
    expect(dockerStep.run).toContain('quickstart');
  });

  // ── Deployment + smoke tests ─────────────────────────────────────────────

  test('should have a step that deploys and runs smoke tests', () => {
    const steps = ciConfig.jobs['contract-tests'].steps;
    const deployStep = steps.find(
      (step) =>
        step.name &&
        (step.name.toLowerCase().includes('deploy') ||
          step.name.toLowerCase().includes('smoke')) &&
        step.run &&
        step.run.includes('contract-tests.sh')
    );
    expect(deployStep).toBeDefined();
  });

  // ── Artifact upload ──────────────────────────────────────────────────────

  test('should upload contract test results as a CI artifact', () => {
    const steps = ciConfig.jobs['contract-tests'].steps;
    const artifactStep = steps.find(
      (step) =>
        step.uses &&
        step.uses.includes('actions/upload-artifact') &&
        step.with &&
        step.with.name &&
        step.with.name.includes('contract')
    );
    expect(artifactStep).toBeDefined();
    expect(artifactStep.with.path).toContain('.wasm');
  });

  // ── Caching ──────────────────────────────────────────────────────────────

  test('should cache Cargo registry and build artifacts', () => {
    const steps = ciConfig.jobs['contract-tests'].steps;
    const cacheStep = steps.find(
      (step) =>
        step.uses &&
        step.uses.includes('actions/cache')
    );
    expect(cacheStep).toBeDefined();
    expect(cacheStep.with.path).toContain('.cargo/registry');
    expect(cacheStep.with.key).toContain('cargo');
  });

  test('should use Cargo.toml hash for cache key invalidation', () => {
    const steps = ciConfig.jobs['contract-tests'].steps;
    const cacheStep = steps.find(
      (step) =>
        step.uses &&
        step.uses.includes('actions/cache')
    );
    expect(cacheStep.with.key).toContain('Cargo.toml');
  });

  // ── PR gating (ci-gate) ──────────────────────────────────────────────────

  test('ci-gate job should exist', () => {
    expect(ciConfig.jobs['ci-gate']).toBeDefined();
  });

  test('ci-gate should include contract-tests in its needs list', () => {
    const gateNeeds = ciConfig.jobs['ci-gate'].needs;
    expect(Array.isArray(gateNeeds)).toBe(true);
    expect(gateNeeds).toContain('contract-tests');
  });

  // ── Cleanup ──────────────────────────────────────────────────────────────

  test('should have a cleanup step to stop the Stellar node', () => {
    const steps = ciConfig.jobs['contract-tests'].steps;
    const cleanupStep = steps.find(
      (step) =>
        step.name &&
        step.name.toLowerCase().includes('stop') &&
        step.run &&
        step.run.includes('docker')
    );
    expect(cleanupStep).toBeDefined();
  });
});
