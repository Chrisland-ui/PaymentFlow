'use strict';

/**
 * tests/smoke/health.test.js
 *
 * Jest smoke tests for the health endpoint.  These run as part of the
 * post-deploy staging smoke gate.
 *
 * When executed in CI against a live staging environment, set:
 *   SMOKE_TEST_BASE_URL=https://staging.paymentflow.app
 *
 * When run locally without a live server the tests are skipped automatically.
 */

const https = require('https');
const http = require('http');

const BASE_URL = process.env.SMOKE_TEST_BASE_URL;

function get(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 10000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

const describeSmoke = BASE_URL ? describe : describe.skip;

describeSmoke('Smoke — health endpoints', () => {
  test('GET /health/live returns 200', async () => {
    const { statusCode } = await get(`${BASE_URL}/health/live`);
    expect(statusCode).toBe(200);
  });

  test('GET /health returns 200', async () => {
    const { statusCode } = await get(`${BASE_URL}/health`);
    expect(statusCode).toBe(200);
  });

  test('GET /health body contains status ok', async () => {
    const { body } = await get(`${BASE_URL}/health`);
    const parsed = JSON.parse(body);
    expect(parsed.status).toBe('ok');
  });
});
