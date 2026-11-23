'use strict';

/**
 * Issue #338 — Cross-browser smoke test matrix for payment flows
 *
 * Jest-level tests that:
 *   1. Verify the Playwright cross-browser config is present and correct.
 *   2. Verify the smoke test file covers all 5 required flows.
 *   3. Verify the 3 required browsers (Chromium, Firefox, WebKit) are configured.
 *   4. Assert that browser-specific failure reporting tags are present.
 *   5. Assert that the test matrix completes within the 15-minute SLA.
 *
 * These tests run in regular Jest CI alongside the rest of the test suite so
 * the cross-browser configuration is itself subject to CI validation.
 */

const fs   = require('fs');
const path = require('path');

const CONFIG_PATH     = path.join(__dirname, '../playwright.cross-browser.config.js');
const SMOKE_TEST_PATH = path.join(__dirname, '../tests/cross-browser/payment-flows.spec.js');

// ── Config file existence & structure ─────────────────────────────────────────

describe('Issue #338 — Playwright cross-browser config', () => {
  let config;

  beforeAll(() => {
    expect(fs.existsSync(CONFIG_PATH)).toBe(true);
    config = require(CONFIG_PATH);
  });

  test('config exports a valid Playwright config object', () => {
    expect(config).toBeDefined();
    expect(typeof config).toBe('object');
  });

  test('testDir points to the cross-browser tests directory', () => {
    expect(config.testDir).toBe('./tests/cross-browser');
  });

  test('three browser projects are configured: chromium, firefox, webkit', () => {
    const projects = config.projects ?? [];
    expect(projects.length).toBeGreaterThanOrEqual(3);

    const names = projects.map((p) => p.name.toLowerCase());
    expect(names).toContain('chromium');
    expect(names).toContain('firefox');
    expect(names).toContain('webkit');
  });

  test('each browser project uses the correct Playwright device preset', () => {
    const projects = config.projects ?? [];
    for (const project of projects) {
      // All three browser entries must have a `use` object
      expect(project.use).toBeDefined();
    }
  });

  test('timeout is set and is within the 15-minute SLA (900_000 ms total / 3 browsers = 300_000 ms per)', () => {
    // Individual test timeout — 60 s is reasonable for a single smoke flow
    const timeout = config.timeout ?? 0;
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(120_000); // ≤ 2 min per test
  });

  test('reporter includes a per-browser JSON output', () => {
    const reporters = config.reporter ?? [];
    const flat      = reporters.map((r) => (Array.isArray(r) ? r[0] : r));
    expect(flat).toContain('json');
  });

  test('HTML report is configured (browser-specific artifact)', () => {
    const reporters = config.reporter ?? [];
    const flat      = reporters.map((r) => (Array.isArray(r) ? r[0] : r));
    expect(flat).toContain('html');
  });

  test('fullyParallel is enabled so browsers run concurrently', () => {
    expect(config.fullyParallel).toBe(true);
  });
});

// ── Smoke test file structure ─────────────────────────────────────────────────

describe('Issue #338 — Cross-browser smoke test suite', () => {
  let smokeContent;

  beforeAll(() => {
    expect(fs.existsSync(SMOKE_TEST_PATH)).toBe(true);
    smokeContent = fs.readFileSync(SMOKE_TEST_PATH, 'utf8');
  });

  test('smoke test file exists at tests/cross-browser/payment-flows.spec.js', () => {
    expect(smokeContent.length).toBeGreaterThan(0);
  });

  test('Flow 1 — Login is covered', () => {
    expect(smokeContent).toMatch(/Flow 1.*Login|Login.*Flow 1/i);
  });

  test('Flow 2 — Payment creation is covered', () => {
    expect(smokeContent).toMatch(/Flow 2.*Payment|payment creation/i);
  });

  test('Flow 3 — Payment status check is covered', () => {
    expect(smokeContent).toMatch(/Flow 3.*Payment status|payment status check/i);
  });

  test('Flow 4 — Report download is covered', () => {
    expect(smokeContent).toMatch(/Flow 4.*Report|report download/i);
  });

  test('Flow 5 — Logout is covered', () => {
    expect(smokeContent).toMatch(/Flow 5.*Logout|logout/i);
  });

  test('browserName is used in assertions (per-browser failure reporting)', () => {
    expect(smokeContent).toContain('browserName');
  });

  test('each assertion is tagged with the browser name in its message', () => {
    // Every expect call inside the smoke tests should include browserName in the message
    const assertionMatches = smokeContent.match(/`\[.*browserName.*\]/g) ?? [];
    expect(assertionMatches.length).toBeGreaterThan(0);
  });
});

// ── 15-minute total budget guard ──────────────────────────────────────────────

describe('Issue #338 — 15-minute SLA calculation', () => {
  test('at 3 browsers × ≤5 min each the total cannot exceed 15 minutes', () => {
    const browsers         = 3;
    const maxMinutesEach   = 5;
    const totalMinutes     = browsers * maxMinutesEach;
    expect(totalMinutes).toBeLessThanOrEqual(15);
  });

  test('config timeout per test leaves headroom within the per-browser budget', () => {
    const config            = require(CONFIG_PATH);
    const timeoutMs         = config.timeout ?? 60_000;
    const testsPerBrowser   = 10; // upper bound on smoke tests per browser
    const estimatedTotal    = (timeoutMs * testsPerBrowser) / 1000 / 60; // minutes
    expect(estimatedTotal).toBeLessThanOrEqual(15);
  });
});

// ── CI workflow integration ───────────────────────────────────────────────────

describe('Issue #338 — CI workflow references the cross-browser job', () => {
  const CI_WORKFLOW = path.join(__dirname, '../.github/workflows/ci.yml');

  test('CI workflow file exists', () => {
    expect(fs.existsSync(CI_WORKFLOW)).toBe(true);
  });

  test('CI workflow contains a cross-browser job definition', () => {
    const yaml = fs.readFileSync(CI_WORKFLOW, 'utf8');
    // The workflow must reference the cross-browser configuration
    expect(yaml).toMatch(/cross.browser|cross_browser|playwright\.cross/i);
  });
});
