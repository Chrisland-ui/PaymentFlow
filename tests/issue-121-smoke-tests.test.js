'use strict';

/**
 * tests/issue-121-smoke-tests.test.js
 *
 * Verifies that the smoke test suite (tests/smoke/) is well-formed and that
 * the runner script exports the expected structure.  These checks run in
 * normal CI without a live server so they gate on suite shape, not live
 * HTTP responses.
 */

const fs = require('fs');
const path = require('path');

const SMOKE_DIR = path.resolve(__dirname, 'smoke');
const RUNNER = path.join(SMOKE_DIR, 'index.js');
const HEALTH_TEST = path.join(SMOKE_DIR, 'health.test.js');

describe('issue-121: smoke test suite structure', () => {
  test('tests/smoke/ directory exists', () => {
    expect(fs.existsSync(SMOKE_DIR)).toBe(true);
    expect(fs.statSync(SMOKE_DIR).isDirectory()).toBe(true);
  });

  test('tests/smoke/index.js exists', () => {
    expect(fs.existsSync(RUNNER)).toBe(true);
  });

  test('tests/smoke/health.test.js exists', () => {
    expect(fs.existsSync(HEALTH_TEST)).toBe(true);
  });

  test('smoke runner references SMOKE_TEST_BASE_URL', () => {
    const src = fs.readFileSync(RUNNER, 'utf8');
    expect(src).toContain('SMOKE_TEST_BASE_URL');
  });

  test('smoke runner defines at least one health check', () => {
    const src = fs.readFileSync(RUNNER, 'utf8');
    expect(src).toContain('/health');
  });

  test('smoke runner exits non-zero on failure', () => {
    const src = fs.readFileSync(RUNNER, 'utf8');
    expect(src).toContain('process.exit(1)');
  });

  test('health test file uses SMOKE_TEST_BASE_URL guard to skip without server', () => {
    const src = fs.readFileSync(HEALTH_TEST, 'utf8');
    expect(src).toContain('SMOKE_TEST_BASE_URL');
    expect(src).toContain('describe.skip');
  });

  test('deploy-staging workflow exists', () => {
    const wf = path.resolve(__dirname, '../.github/workflows/deploy-staging.yml');
    expect(fs.existsSync(wf)).toBe(true);
  });

  test('deploy-production workflow exists', () => {
    const wf = path.resolve(__dirname, '../.github/workflows/deploy-production.yml');
    expect(fs.existsSync(wf)).toBe(true);
  });

  test('rollback workflow exists', () => {
    const wf = path.resolve(__dirname, '../.github/workflows/rollback.yml');
    expect(fs.existsSync(wf)).toBe(true);
  });

  test('deploy-staging workflow uses staging environment', () => {
    const wf = path.resolve(__dirname, '../.github/workflows/deploy-staging.yml');
    const src = fs.readFileSync(wf, 'utf8');
    expect(src).toContain('environment:');
    expect(src).toContain('staging');
  });

  test('deploy-production workflow uses production environment', () => {
    const wf = path.resolve(__dirname, '../.github/workflows/deploy-production.yml');
    const src = fs.readFileSync(wf, 'utf8');
    expect(src).toContain('environment:');
    expect(src).toContain('production');
  });

  test('rollback workflow uses workflow_dispatch trigger', () => {
    const wf = path.resolve(__dirname, '../.github/workflows/rollback.yml');
    const src = fs.readFileSync(wf, 'utf8');
    expect(src).toContain('workflow_dispatch');
    expect(src).toContain('image_tag');
  });
});
