// @ts-check
/**
 * Issue #337 — Playwright accessibility scan configuration
 *
 * Scans 5 key routes for WCAG 2.1 AA violations using @axe-core/playwright.
 * Runs on every CI build and uploads the report as an artifact.
 *
 * @type {import('@playwright/test').PlaywrightTestConfig}
 */

const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/a11y',
  timeout: 30_000,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'reports/a11y', open: 'never' }],
    ['json', { outputFile: 'reports/a11y/results.json' }],
  ],
  use: {
    baseURL: process.env.APP_URL || 'http://localhost:3000',
    trace:   'on-first-retry',
    headless: true,
  },
  projects: [
    {
      name: 'chromium-a11y',
      use:  { ...devices['Desktop Chrome'] },
    },
  ],
});
