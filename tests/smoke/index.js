#!/usr/bin/env node
'use strict';

/**
 * tests/smoke/index.js
 *
 * Smoke test runner executed against a live staging environment after every
 * deploy. Run via: `node tests/smoke/index.js`
 *
 * Required environment variable:
 *   SMOKE_TEST_BASE_URL  — base URL of the deployment to test
 *                          (e.g. https://staging.paymentflow.app)
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 */

const https = require('https');
const http = require('http');

const BASE_URL = process.env.SMOKE_TEST_BASE_URL || 'http://localhost:5000';

/**
 * Perform an HTTP/HTTPS GET and return { statusCode, body }.
 */
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
      reject(new Error(`Request to ${url} timed out`));
    });
  });
}

const checks = [
  {
    name: 'Health liveness endpoint returns 200',
    async run() {
      const { statusCode } = await get(`${BASE_URL}/health/live`);
      if (statusCode !== 200) {
        throw new Error(`Expected 200, got ${statusCode}`);
      }
    },
  },
  {
    name: 'Health readiness endpoint returns 200',
    async run() {
      const { statusCode } = await get(`${BASE_URL}/health`);
      if (statusCode !== 200) {
        throw new Error(`Expected 200, got ${statusCode}`);
      }
    },
  },
  {
    name: 'Health response body contains status ok',
    async run() {
      const { statusCode, body } = await get(`${BASE_URL}/health`);
      if (statusCode !== 200) {
        throw new Error(`Expected 200, got ${statusCode}`);
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error(`Health response is not valid JSON: ${body.slice(0, 120)}`);
      }
      if (parsed.status !== 'ok') {
        throw new Error(`Expected status "ok", got "${parsed.status}"`);
      }
    },
  },
  {
    name: 'API root responds (not 5xx)',
    async run() {
      const { statusCode } = await get(`${BASE_URL}/api`);
      if (statusCode >= 500) {
        throw new Error(`API root returned server error: ${statusCode}`);
      }
    },
  },
];

async function main() {
  console.log(`\nSmoke tests → ${BASE_URL}\n`);
  let passed = 0;
  let failed = 0;

  for (const check of checks) {
    try {
      await check.run();
      console.log(`  ✓  ${check.name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗  ${check.name}`);
      console.error(`     ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Smoke test runner crashed:', err);
  process.exit(1);
});
