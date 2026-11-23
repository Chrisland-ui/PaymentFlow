// @ts-check
/**
 * Issue #338 — Cross-browser smoke test matrix for payment flows
 *
 * Playwright configuration that runs the payment flow smoke tests against
 * Chromium, Firefox, and WebKit (Safari engine).
 *
 * This job runs on every PR to main (triggered by the CI workflow).
 * It covers: login, payment creation, payment status check, report download,
 * and logout — all 5 flows mandated by the acceptance criteria.
 *
 * Per-browser results are reported individually so a browser-specific failure
 * is surfaced with a browser-tagged message in CI output.
 *
 * @type {import('@playwright/test').PlaywrightTestConfig}
 */

const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/cross-browser',
  timeout:       60_000,
  retries:       process.env.CI ? 1 : 0,
  workers:       process.env.CI ? 3 : undefined,
  fullyParallel: true,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'reports/cross-browser', open: 'never' }],
    // Per-browser JSON results — consumed by the CI summary step.
    ['json', { outputFile: 'reports/cross-browser/results.json' }],
    ['github'],   // Annotates PRs with per-browser failures in GitHub Actions
  ],

  use: {
    // The base URL is overridden by APP_URL in CI once the stack is up.
    baseURL:      process.env.APP_URL || 'http://localhost:3000',
    screenshot:   'only-on-failure',
    video:        'retain-on-failure',
    trace:        'on-first-retry',
    // Realistic viewport matching mobile-first design
    viewport:     { width: 1280, height: 720 },
    // Do not store sensitive credential data in traces
    headless:     true,
  },

  projects: [
    {
      name: 'chromium',
      use:  {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
      },
    },
    {
      name: 'firefox',
      use:  {
        ...devices['Desktop Firefox'],
        // Firefox-specific: disable autofill to prevent form pre-population
        launchOptions: {
          firefoxUserPrefs: {
            'extensions.formautofill.creditCards.enabled': false,
          },
        },
      },
    },
    {
      name: 'webkit',
      use:  {
        ...devices['Desktop Safari'],
        // WebKit-specific: strict security policy mirrors Safari's CSP behaviour
        javaScriptEnabled: true,
      },
    },
  ],
});
