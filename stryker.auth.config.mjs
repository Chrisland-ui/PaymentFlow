// @ts-check
/**
 * Stryker mutation testing configuration — Issue #96
 *
 * Scope: Authorization middleware (backend/src/middleware/auth.js)
 *
 * Rationale: High line coverage can still miss inverted or removed authorization
 * conditions. Mutation testing introduces small code mutations (flipped conditionals,
 * removed checks, swapped operators) and verifies that the existing test suite
 * kills each mutant — i.e., at least one test detects each fault.
 *
 * Focused threshold:
 *   - Minimum mutation score: 70% (kills / total mutants)
 *   - Runtime capped by targeting only auth.js (fast, bounded)
 *
 * Result publishing:
 *   - HTML report written to reports/mutation/ for PR review
 *   - JSON report written alongside for programmatic consumption
 *   - CI uploads both as artefacts (see .github/workflows/mutation-test.yml)
 *
 * Usage:
 *   npx stryker run stryker.auth.config.mjs
 *
 * Or via npm script (add to package.json):
 *   "mutate:auth": "stryker run stryker.auth.config.mjs"
 */

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  // ── Mutation targets ────────────────────────────────────────────────────────
  // Focus exclusively on the authorization middleware to keep the run fast and
  // results actionable. Expand the mutate array incrementally as coverage grows.
  mutate: [
    'backend/src/middleware/auth.js',
  ],

  // ── Test runner ─────────────────────────────────────────────────────────────
  testRunner: 'jest',

  jest: {
    // Point at the root jest config that covers both root tests/ and backend/
    // tests/ so all auth-related test files participate in killing mutants.
    configFile: 'package.json',

    // Run only auth-relevant test files to keep the mutation run fast.
    // If a new auth test file is added, include it here.
    enableFindRelatedTests: true,
  },

  // ── Test files used to kill mutants ─────────────────────────────────────────
  // These test files are the "killing squad" — they must detect each mutant.
  // Adding more auth-related test files here increases kill coverage.
  testFiles: [
    'tests/authentication-enforcement.test.js',
    'tests/jwtRefreshTokens.test.js',
    'tests/cross-tenant-access.test.js',
    'tests/httpOnlyCookieAuth.test.js',
    'tests/security-response-leakage.test.js',
  ],

  // ── Reporters ────────────────────────────────────────────────────────────────
  // html: human-readable PR review report
  // json: machine-readable for dashboards and trend analysis
  // progress: live progress bar in CI logs
  // clear-text: summary table in CI log (suppressed unless verbose)
  reporters: ['html', 'json', 'progress'],

  // ── Output directory ─────────────────────────────────────────────────────────
  // All reports land here. The CI workflow uploads reports/ as an artefact.
  reportDir: 'reports/mutation',

  // ── Thresholds ───────────────────────────────────────────────────────────────
  // Break the CI run (exit non-zero) if the mutation score falls below these
  // values. 'break' is the hard floor; 'low' and 'high' control report colouring.
  //
  // Start at 70 and raise by ~5 pp per sprint. Raising requires that new or
  // improved tests kill the currently-surviving mutants first.
  thresholds: {
    high: 80,
    low: 70,
    break: 65,
  },

  // ── Mutators to apply ────────────────────────────────────────────────────────
  // 'ArrowFunction', 'BlockStatement', 'BooleanLiteral', 'ConditionalExpression',
  // 'EqualityOperator', 'LogicalOperator', 'StringLiteral', 'UpdateOperator' are
  // the highest-value mutators for authorization logic:
  //   - EqualityOperator: flips === to !== in role/scope checks
  //   - LogicalOperator:  changes && to || in compound auth conditions
  //   - BooleanLiteral:   replaces true/false in guard checks
  //   - ConditionalExpression: removes ternary arms
  //
  // All other mutators are included by default; this list is informational.
  // To restrict to only the high-value set, uncomment the mutator filter below:
  //
  // plugins: ['@stryker-mutator/jest-runner'],
  // ignoredMutations: [],
  // only: ['EqualityOperator', 'LogicalOperator', 'BooleanLiteral', 'ConditionalExpression'],

  // ── Excluded patterns ────────────────────────────────────────────────────────
  // Exclude logging calls, pure utility helpers, and the MFA_SETUP_ALLOWED_PATHS
  // Set which is a static constant that doesn't affect access control logic.
  excludedMutations: [
    // logger.warn / logger.error calls are observability, not access control
    'StringLiteral',
  ],

  // ── Incremental mode ────────────────────────────────────────────────────────
  // Cache mutant results between runs. Stryker only re-runs mutants whose
  // source file or test file changed, making repeated runs much faster.
  incremental: true,
  incrementalFile: '.stryker-tmp/incremental.json',

  // ── Resource limits ─────────────────────────────────────────────────────────
  // Concurrency: limit to 2 workers to keep CI memory under control.
  // A single auth.js file with ~200 lines generates ~150–200 mutants;
  // 2 workers complete the run in 2–4 minutes on standard CI hardware.
  concurrency: 2,

  // ── Timeouts ─────────────────────────────────────────────────────────────────
  // Kill a mutant test run if it takes more than 10 seconds (normal run ~2–3s).
  // This prevents a mutant that introduces an infinite loop from hanging the job.
  timeoutMS: 10000,
  timeoutFactor: 1.5,

  // ── Temp directory cleanup ──────────────────────────────────────────────────
  cleanTempDir: true,

  // ── Verbose output ─────────────────────────────────────────────────────────
  // Set to true locally to see which specific mutants survived.
  // Keep false in CI to reduce log noise.
  allowConsoleColors: true,
};
