'use strict';

/**
 * Browser matrix for cross-browser smoke tests (#90).
 *
 * Defines the supported desktop and mobile browser targets.
 * Each entry maps to a Playwright browser project when running against a live
 * server, and drives the mock-based simulation in CI.
 *
 * Keep security-sensitive values out of this file — use environment variables
 * for any credentials required by live-server runs.
 */

const BROWSER_MATRIX = [
  {
    id: 'chromium',
    engine: 'chromium',
    type: 'desktop',
    viewport: { width: 1280, height: 720 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  },
  {
    id: 'firefox',
    engine: 'firefox',
    type: 'desktop',
    viewport: { width: 1280, height: 720 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0',
  },
  {
    id: 'webkit',
    engine: 'webkit',
    type: 'desktop',
    viewport: { width: 1280, height: 720 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  },
  {
    id: 'mobile_chrome',
    engine: 'chromium',
    type: 'mobile',
    viewport: { width: 390, height: 844 },
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
  },
  {
    id: 'mobile_safari',
    engine: 'webkit',
    type: 'mobile',
    viewport: { width: 390, height: 844 },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
];

const DESKTOP_BROWSERS = BROWSER_MATRIX.filter((b) => b.type === 'desktop');
const MOBILE_BROWSERS = BROWSER_MATRIX.filter((b) => b.type === 'mobile');

module.exports = { BROWSER_MATRIX, DESKTOP_BROWSERS, MOBILE_BROWSERS };
