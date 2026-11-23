'use strict';

/**
 * Issue #56: Add contract authorization property tests.
 *
 * Acceptance Criteria:
 *   1. Every privileged entry point has positive and negative authorization coverage.
 *   2. Generated cases are reproducible from a seed.
 */

const {
  ROLES,
  PRIVILEGED_ENTRY_POINTS,
  ROLE_PERMISSIONS,
  ERROR_CODES,
  evaluateAuthorization,
  createDeterministicPrng,
  generateAuthorizationTestCase,
} = require('../backend/src/services/contractAuthorizationPolicy');

describe('Issue #56 — Contract Authorization Property Tests', () => {
  describe('Acceptance Criterion 1: Table-Driven Coverage for Every Privileged Entry Point', () => {
    const allActions = Object.values(PRIVILEGED_ENTRY_POINTS);
    const allRoles = Object.values(ROLES);

    // Verify positive and negative coverage for each action
    test.each(allActions)('entry point "%s" has positive and negative authorization coverage', (action) => {
      const allowedRoles = ROLE_PERMISSIONS[action] || [];
      const disallowedRoles = allRoles.filter((r) => !allowedRoles.includes(r));

      // 1. Positive coverage: each allowed role must succeed when unpaused
      expect(allowedRoles.length).toBeGreaterThan(0);
      for (const role of allowedRoles) {
        const actor = `ACTOR_${role}`;
        const res = evaluateAuthorization({
          action,
          role,
          actor,
          isPaused: false,
          resourceOwner: actor,
        });
        expect(res.authorized).toBe(true);
      }

      // 2. Negative coverage: each disallowed role must be rejected
      expect(disallowedRoles.length).toBeGreaterThan(0);
      for (const role of disallowedRoles) {
        const actor = `ACTOR_${role}`;
        const res = evaluateAuthorization({
          action,
          role,
          actor,
          isPaused: false,
          resourceOwner: actor,
        });
        expect(res.authorized).toBe(false);
        expect(res.code).toBe(ERROR_CODES.UNAUTHORIZED_ROLE);
      }
    });

    test('emergency pause blocks every action except unpause by OWNER', () => {
      for (const action of allActions) {
        for (const role of allRoles) {
          const res = evaluateAuthorization({
            action,
            role,
            isPaused: true,
          });

          if (action === PRIVILEGED_ENTRY_POINTS.UNPAUSE && role === ROLES.OWNER) {
            expect(res.authorized).toBe(true);
          } else {
            expect(res.authorized).toBe(false);
            expect(res.code).toBe(ERROR_CODES.CONTRACT_PAUSED);
          }
        }
      }
    });

    test('payer cross-resource dispute is rejected', () => {
      const res = evaluateAuthorization({
        action: PRIVILEGED_ENTRY_POINTS.DISPUTE,
        role: ROLES.PAYER,
        actor: 'PAYER_ALICE',
        resourceOwner: 'PAYER_BOB',
      });

      expect(res.authorized).toBe(false);
      expect(res.code).toBe(ERROR_CODES.RESOURCE_ACCESS_DENIED);
    });
  });

  describe('Acceptance Criterion 2: Seed Reproducibility and Property-Based Sweep', () => {
    test('generator produces exact identical test cases given the same seed', () => {
      const seed = 0xCAFEBABE;
      const count = 100;

      const prng1 = createDeterministicPrng(seed);
      const prng2 = createDeterministicPrng(seed);

      const run1 = Array.from({ length: count }, () => generateAuthorizationTestCase(prng1));
      const run2 = Array.from({ length: count }, () => generateAuthorizationTestCase(prng2));

      expect(run1).toEqual(run2);
    });

    test('different seeds produce distinct test sequences', () => {
      const prngA = createDeterministicPrng(1111);
      const prngB = createDeterministicPrng(9999);

      const runA = Array.from({ length: 20 }, () => generateAuthorizationTestCase(prngA));
      const runB = Array.from({ length: 20 }, () => generateAuthorizationTestCase(prngB));

      expect(runA).not.toEqual(runB);
    });

    test('property sweep: 500 generated cases satisfy global security invariants', () => {
      const prng = createDeterministicPrng(987654321);
      const totalCases = 500;

      const testedActions = new Set();
      const positiveActions = new Set();
      const negativeActions = new Set();

      for (let i = 0; i < totalCases; i++) {
        const testCase = generateAuthorizationTestCase(prng);
        const { action, role, isPaused, matchingOwner, evaluation } = testCase;

        testedActions.add(action);
        if (evaluation.authorized) {
          positiveActions.add(action);
        } else {
          negativeActions.add(action);
        }

        // Global Invariant 1: UNAUTHORIZED role can NEVER perform ANY action
        if (role === ROLES.UNAUTHORIZED) {
          expect(evaluation.authorized).toBe(false);
        }

        // Global Invariant 2: BENEFICIARY can NEVER perform privileged administrative or money-moving operations
        if (role === ROLES.BENEFICIARY) {
          expect(evaluation.authorized).toBe(false);
        }

        // Global Invariant 3: When paused, only unpause by OWNER is ever authorized
        if (isPaused) {
          if (action === PRIVILEGED_ENTRY_POINTS.UNPAUSE && role === ROLES.OWNER) {
            expect(evaluation.authorized).toBe(true);
          } else {
            expect(evaluation.authorized).toBe(false);
          }
        }

        // Global Invariant 4: PAYER can never release, refund, resolve disputes, pause, unpause, update config, or rotate signers
        if (role === ROLES.PAYER) {
          if ([
            PRIVILEGED_ENTRY_POINTS.RELEASE,
            PRIVILEGED_ENTRY_POINTS.REFUND,
            PRIVILEGED_ENTRY_POINTS.RESOLVE_DISPUTE,
            PRIVILEGED_ENTRY_POINTS.PAUSE,
            PRIVILEGED_ENTRY_POINTS.UNPAUSE,
            PRIVILEGED_ENTRY_POINTS.UPDATE_CONFIG,
            PRIVILEGED_ENTRY_POINTS.ROTATE_SIGNER,
          ].includes(action)) {
            expect(evaluation.authorized).toBe(false);
          }
        }

        // Global Invariant 5: Cross-resource dispute by PAYER must always be blocked
        if (role === ROLES.PAYER && action === PRIVILEGED_ENTRY_POINTS.DISPUTE && !matchingOwner && !isPaused) {
          expect(evaluation.authorized).toBe(false);
          expect(evaluation.code).toBe(ERROR_CODES.RESOURCE_ACCESS_DENIED);
        }
      }

      // Verify full action coverage across the randomized sweep
      for (const action of Object.values(PRIVILEGED_ENTRY_POINTS)) {
        expect(testedActions.has(action)).toBe(true);
        expect(positiveActions.has(action)).toBe(true);
        expect(negativeActions.has(action)).toBe(true);
      }
    });
  });
});
