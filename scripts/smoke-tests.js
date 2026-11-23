#!/usr/bin/env node
'use strict';

/**
 * smoke-tests.js — post-deployment smoke test suite for PaymentFlow.
 *
 * Validates that the public payment path is functional after a rollout by
 * running a sequenced set of checks against the live backend and frontend.
 *
 * Checks (in order):
 *   1. /health/live           — process is alive
 *   2. /health/ready          — all dependencies reachable
 *   3. /health                — degraded/unhealthy detection
 *   4. POST /api/auth/login   — authentication produces a token
 *   5. GET  /api/payments/limits — authenticated read succeeds (payment path)
 *   6. GET  /api/admin/retry-queue — queue depth reported (worker health)
 *   7. Frontend /             — Next.js returns 200 (basic availability)
 *
 * Security:
 *   - Test credentials come exclusively from environment variables, never
 *     from command-line arguments or hardcoded values.
 *   - No secret values are echoed, logged, or written to files.
 *   - Tokens are held in memory only for the duration of the run.
 *   - The test account MUST be a dedicated smoke-test account with no access
 *     to real payment records (see SMOKE_TEST_ADMIN_EMAIL / _PASSWORD).
 *
 * Environment variables (required):
 *   SMOKE_BACKEND_URL   — base URL of the backend  e.g. https://api.example.com
 *   SMOKE_FRONTEND_URL  — base URL of the frontend e.g. https://app.example.com
 *   SMOKE_ADMIN_EMAIL   — email of the smoke-test admin account
 *   SMOKE_ADMIN_PASSWORD — password of the smoke-test admin account
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed (deployment should be blocked / paged)
 *
 * Usage:
 *   node scripts/smoke-tests.js
 *   # Or via npm script: npm run smoke
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

// ── Config ──────────────────────────────────────────────────────────────────

const BACKEND_URL = (process.env.SMOKE_BACKEND_URL || '').replace(/\/$/, '');
const FRONTEND_URL = (process.env.SMOKE_FRONTEND_URL || '').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD || '';

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function validateConfig() {
  const missing = [];
  if (!BACKEND_URL) missing.push('SMOKE_BACKEND_URL');
  if (!FRONTEND_URL) missing.push('SMOKE_FRONTEND_URL');
  if (!ADMIN_EMAIL) missing.push('SMOKE_ADMIN_EMAIL');
  if (!ADMIN_PASSWORD) missing.push('SMOKE_ADMIN_PASSWORD');

  if (missing.length > 0) {
    console.error('Missing required environment variables:');
    missing.forEach((v) => console.error(`  ${v}`));
    console.error('\nSet these in CI secrets — never in committed files.');
    process.exit(1);
  }
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'PaymentFlow-SmokeTest/1.0',
        ...options.headers,
      },
      timeout: TIMEOUT_MS,
    };

    const req = lib.request(reqOptions, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null, rawBody: body });
        } catch {
          resolve({ status: res.statusCode, body: null, rawBody: body });
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Request timed out after ${TIMEOUT_MS}ms`)); });
    req.on('error', reject);

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

async function withRetry(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        console.warn(`  [${label}] attempt ${attempt} failed: ${err.message} — retrying in ${RETRY_DELAY_MS}ms`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
  throw lastErr;
}

// ── Check definitions ─────────────────────────────────────────────────────────

const results = [];

async function check(name, fn) {
  try {
    await withRetry(name, fn);
    results.push({ name, passed: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, passed: false, error: err.message });
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

async function runChecks() {
  // State shared across checks (tokens are never logged)
  let token = null;

  console.log('\n═══ PaymentFlow Post-Deployment Smoke Tests ═══\n');
  console.log(`Backend:  ${BACKEND_URL}`);
  console.log(`Frontend: ${FRONTEND_URL}`);
  console.log('');

  // 1. Liveness — is the process alive?
  await check('GET /health/live returns 200', async () => {
    const res = await request(`${BACKEND_URL}/health/live`);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  // 2. Readiness — are all dependencies reachable?
  await check('GET /health/ready returns 200 (dependencies up)', async () => {
    const res = await request(`${BACKEND_URL}/health/ready`);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}. Body: ${res.rawBody}`);
  });

  // 3. Full health check — not in unhealthy state
  await check('GET /health is not unhealthy (status != 503)', async () => {
    const res = await request(`${BACKEND_URL}/health`);
    if (res.status === 503) {
      const detail = res.body ? JSON.stringify(res.body) : res.rawBody;
      throw new Error(`Service is unhealthy: ${detail}`);
    }
    // Degraded (200 with status=degraded) is acceptable — payment path works
    // but a non-critical dependency is down.  503 blocks promotion.
  });

  // 4. Authentication — can we get a token?
  await check('POST /api/auth/login succeeds with smoke-test credentials', async () => {
    const res = await request(`${BACKEND_URL}/api/auth/login`, {
      method: 'POST',
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    if (res.status !== 200) throw new Error(`Login failed with status ${res.status}`);
    const tok = res.body?.token || res.body?.accessToken;
    if (!tok) throw new Error('Login succeeded but no token in response');
    // Store in memory only — never logged
    token = tok;
  });

  // 5. Authenticated payment read — payment path is functional
  await check('GET /api/payments/limits returns 200 (authenticated)', async () => {
    if (!token) throw new Error('Skipped: no token from login check');
    const res = await request(`${BACKEND_URL}/api/payments/limits`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!res.body?.min && !res.body?.minAmount) {
      throw new Error('Response missing expected payment limits fields');
    }
  });

  // 6. Queue health — background workers are running
  await check('GET /api/admin/retry-queue returns queue status', async () => {
    if (!token) throw new Error('Skipped: no token from login check');
    const res = await request(`${BACKEND_URL}/api/admin/retry-queue`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    // Do not assert on exact queue depth — just that the endpoint is responsive.
  });

  // 7. Frontend availability
  await check('GET frontend / returns 200 (Next.js serving)', async () => {
    const res = await request(`${FRONTEND_URL}/`);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  // 8. Cleanup — null the token (belt-and-suspenders; it expires on its own)
  token = null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  validateConfig();
  await runChecks();

  console.log('\n═══ Results ═══\n');

  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  results.forEach((r) => {
    console.log(`  ${r.passed ? '✓' : '✗'} ${r.name}${r.error ? ': ' + r.error : ''}`);
  });

  console.log(`\n${passed.length}/${results.length} checks passed.`);

  if (failed.length > 0) {
    console.error(`\n✗ ${failed.length} smoke test(s) FAILED.`);
    console.error('Deployment should be blocked or rolled back.');
    process.exit(1);
  }

  console.log('\n✓ All smoke tests passed. Deployment is healthy.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nUnexpected smoke test runner error:', err.message);
  process.exit(1);
});
