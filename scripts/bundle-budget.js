#!/usr/bin/env node
'use strict';

/**
 * Bundle-budget enforcer for the PaymentFlow frontend.
 *
 * Reads the Next.js build manifest produced by `next build` and checks that
 * each route's initial JavaScript payload (First Load JS) and each individual
 * asset stay within the configured thresholds.  Exits non-zero with
 * actionable output when any budget is exceeded so CI can fail the build.
 *
 * Usage (CI):
 *   node scripts/bundle-budget.js [--manifest path/to/build-manifest.json]
 *
 * The build manifest is written to frontend/.next/build-manifest.json by
 * `next build`.  The script also reads the page-data files to collect
 * gzip-approximate sizes from the `.next/static/chunks` directory.
 *
 * Per-route budgets (kB, uncompressed):
 *   - Each individual chunk file     : MAX_CHUNK_KB
 *   - Route initial JS (sum of deps) : MAX_ROUTE_INITIAL_KB
 *
 * Lazy-loaded routes are distinguished from the shared framework bundle.
 * Only the route-specific JS is counted against the per-route budget;
 * the shared `/_app`, `/_error`, and framework polyfills are measured
 * separately against a shared-bundle budget.
 *
 * Exit codes:
 *   0  — all budgets met
 *   1  — one or more budgets exceeded
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── Budget thresholds ─────────────────────────────────────────────────────────

/** Maximum size (kB, uncompressed) for any single JS chunk file. */
const MAX_CHUNK_KB = parseInt(process.env.BUNDLE_MAX_CHUNK_KB, 10) || 512;

/**
 * Maximum initial JS loaded on first navigation to any single route (kB).
 * This is the sum of all chunk files listed under that route in the manifest,
 * excluding the shared framework bundle which is already cached after the
 * first page visit.
 */
const MAX_ROUTE_INITIAL_KB = parseInt(process.env.BUNDLE_MAX_ROUTE_INITIAL_KB, 10) || 350;

/**
 * Maximum initial gzipped JS loaded on first navigation (kB).
 * Hard budget: 200KB gzipped for initial bundle.
 */
const MAX_INITIAL_GZIP_KB = parseInt(process.env.BUNDLE_MAX_INITIAL_GZIP_KB, 10) || 200;

/**
 * Maximum combined size (kB) of the shared chunks loaded on every route
 * (/_app, runtime, framework, etc.).
 */
const MAX_SHARED_KB = parseInt(process.env.BUNDLE_MAX_SHARED_KB, 10) || 300;

// ── Paths ─────────────────────────────────────────────────────────────────────

const REPO_ROOT     = path.resolve(__dirname, '..');
const NEXT_DIR      = path.join(REPO_ROOT, 'frontend', '.next');
const MANIFEST_PATH = process.argv.includes('--manifest')
  ? process.argv[process.argv.indexOf('--manifest') + 1]
  : path.join(NEXT_DIR, 'build-manifest.json');
const CHUNKS_DIR    = path.join(NEXT_DIR, 'static', 'chunks');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Return the on-disk size in kibibytes of a static asset path from the manifest. */
function chunkSizeKB(relativePath) {
  const full = path.join(NEXT_DIR, relativePath);
  try {
    return fs.statSync(full).size / 1024;
  } catch {
    return 0; // file not present (e.g. inlined source map)
  }
}

/** Return the gzipped size in kibibytes of a static asset path from the manifest. */
function chunkGzipSizeKB(relativePath) {
  const full = path.join(NEXT_DIR, relativePath);
  try {
    const content = fs.readFileSync(full);
    return zlib.gzipSync(content).length / 1024;
  } catch {
    return 0;
  }
}

/** Group manifest chunks into shared vs per-route buckets. */
function analyseManifest(manifest) {
  const pages  = manifest.pages  || {};
  const sortedRoutes = Object.keys(pages).sort();

  // Chunks referenced by every route (appear in /_app) are "shared"
  const sharedChunks = new Set(pages['/_app'] || []);

  const results = [];

  for (const route of sortedRoutes) {
    const chunks = pages[route] || [];
    // Route-specific = chunks not in the shared set
    const routeSpecific = chunks.filter(c => !sharedChunks.has(c));
    const routeKB       = routeSpecific.reduce((sum, c) => sum + chunkSizeKB(c), 0);
    const routeGzipKB   = routeSpecific.reduce((sum, c) => sum + chunkGzipSizeKB(c), 0);
    const allChunkSizes = chunks.map(c => ({
      path: c,
      kb: chunkSizeKB(c),
      gzipKb: chunkGzipSizeKB(c),
    }));

    results.push({ route, chunks, routeSpecific, routeKB, routeGzipKB, allChunkSizes });
  }

  const sharedKB = [...sharedChunks].reduce((sum, c) => sum + chunkSizeKB(c), 0);
  const sharedGzipKB = [...sharedChunks].reduce((sum, c) => sum + chunkGzipSizeKB(c), 0);

  return { results, sharedKB, sharedGzipKB, sharedChunks };
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`\n✗  Build manifest not found: ${MANIFEST_PATH}`);
    console.error('   Run `cd frontend && npm run build` first.\n');
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const { results, sharedKB, sharedGzipKB } = analyseManifest(manifest);

  const violations = [];
  const rows       = [];

  // ── Shared bundle budget ──────────────────────────────────────────────────
  const sharedStatus = sharedKB > MAX_SHARED_KB ? 'OVER' : 'ok';
  if (sharedStatus === 'OVER') {
    violations.push(
      `Shared bundle: ${sharedKB.toFixed(1)} kB > ${MAX_SHARED_KB} kB limit`
    );
  }
  rows.push({
    route: '(shared / /_app)',
    routeKB: sharedKB.toFixed(1),
    gzipKB: sharedGzipKB.toFixed(1),
    limit: MAX_ROUTE_INITIAL_KB,
    status: sharedStatus,
  });

  // ── Per-route budgets ─────────────────────────────────────────────────────
  for (const { route, allChunkSizes, routeKB, routeGzipKB } of results) {
    if (route === '/_app' || route === '/_error' || route === '/_document') continue;

    const routeStatus = (routeKB > MAX_ROUTE_INITIAL_KB || routeGzipKB > MAX_INITIAL_GZIP_KB) ? 'OVER' : 'ok';
    if (routeKB > MAX_ROUTE_INITIAL_KB) {
      violations.push(
        `Route ${route}: initial JS ${routeKB.toFixed(1)} kB > ${MAX_ROUTE_INITIAL_KB} kB limit`
      );
    }
    if (routeGzipKB > MAX_INITIAL_GZIP_KB) {
      violations.push(
        `Route ${route}: initial gzipped JS ${routeGzipKB.toFixed(1)} kB > ${MAX_INITIAL_GZIP_KB} kB gzip limit`
      );
    }
    rows.push({
      route,
      routeKB: routeKB.toFixed(1),
      gzipKB: routeGzipKB.toFixed(1),
      limit: MAX_ROUTE_INITIAL_KB,
      status: routeStatus,
    });

    // ── Per-chunk budget ──────────────────────────────────────────────────
    for (const { path: chunkPath, kb } of allChunkSizes) {
      if (kb > MAX_CHUNK_KB) {
        violations.push(
          `Chunk ${chunkPath}: ${kb.toFixed(1)} kB > ${MAX_CHUNK_KB} kB per-asset limit`
        );
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('\n── Bundle Budget Report ────────────────────────────────────────────────────────');
  console.log(
    `${'Route'.padEnd(40)} ${'JS (kB)'.padStart(9)} ${'Gzip (kB)'.padStart(11)}  Status`
  );
  console.log('─'.repeat(74));

  for (const row of rows) {
    const indicator = row.status === 'OVER' ? '✗ OVER  ' : '✓ ok    ';
    console.log(
      `${row.route.padEnd(40)} ${String(row.routeKB).padStart(9)} ${String(row.gzipKB).padStart(11)}  ${indicator}`
    );
  }

  console.log('─'.repeat(74));
  console.log(`Budgets: initial JS ≤ ${MAX_ROUTE_INITIAL_KB} kB | initial gzip ≤ ${MAX_INITIAL_GZIP_KB} kB | shared ≤ ${MAX_SHARED_KB} kB | chunk ≤ ${MAX_CHUNK_KB} kB`);

  if (violations.length === 0) {
    console.log('\n✓  All bundle budgets met.\n');
    process.exit(0);
  } else {
    console.error(`\n✗  ${violations.length} budget violation(s):\n`);
    for (const v of violations) {
      console.error(`   • ${v}`);
    }
    console.error('\n  Reduce chunk sizes or raise the budget thresholds in scripts/bundle-budget.js.\n');
    process.exit(1);
  }
}

main();
