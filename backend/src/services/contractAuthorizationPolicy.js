'use strict';

/**
 * Contract Authorization Policy & Property Generator (Issue #56).
 *
 * Role and signer access rules in smart contracts and escrow systems are
 * high-impact and require rigorous positive and negative authorization verification.
 *
 * This module defines:
 *   1. Canonical role hierarchy (OWNER, OPERATOR, PAYER, BENEFICIARY, UNAUTHORIZED).
 *   2. Access control matrix for all privileged entry points.
 *   3. Contextual and emergency pause restrictions.
 *   4. Deterministic PRNG and property-based test vector generators reproducible from a seed.
 */

const ROLES = {
  OWNER: 'OWNER',
  OPERATOR: 'OPERATOR',
  PAYER: 'PAYER',
  BENEFICIARY: 'BENEFICIARY',
  UNAUTHORIZED: 'UNAUTHORIZED',
};

const PRIVILEGED_ENTRY_POINTS = {
  INITIALIZE: 'initialize',
  DEPOSIT: 'deposit',
  RELEASE: 'release',
  REFUND: 'refund',
  DISPUTE: 'dispute',
  RESOLVE_DISPUTE: 'resolveDispute',
  PAUSE: 'pause',
  UNPAUSE: 'unpause',
  UPDATE_CONFIG: 'updateConfig',
  ROTATE_SIGNER: 'rotateSigner',
};

const ERROR_CODES = {
  UNAUTHORIZED_ROLE: 'UNAUTHORIZED_ROLE',
  CONTRACT_PAUSED: 'CONTRACT_PAUSED',
  RESOURCE_ACCESS_DENIED: 'RESOURCE_ACCESS_DENIED',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_ROLE: 'INVALID_ROLE',
};

/**
 * Authoritative Access Control Matrix for unpaused operations.
 */
const ROLE_PERMISSIONS = {
  [PRIVILEGED_ENTRY_POINTS.INITIALIZE]: [ROLES.OWNER],
  [PRIVILEGED_ENTRY_POINTS.DEPOSIT]: [ROLES.PAYER, ROLES.OWNER],
  [PRIVILEGED_ENTRY_POINTS.RELEASE]: [ROLES.OPERATOR, ROLES.OWNER],
  [PRIVILEGED_ENTRY_POINTS.REFUND]: [ROLES.OPERATOR, ROLES.OWNER],
  [PRIVILEGED_ENTRY_POINTS.DISPUTE]: [ROLES.PAYER, ROLES.OPERATOR, ROLES.OWNER],
  [PRIVILEGED_ENTRY_POINTS.RESOLVE_DISPUTE]: [ROLES.OPERATOR, ROLES.OWNER],
  [PRIVILEGED_ENTRY_POINTS.PAUSE]: [ROLES.OPERATOR, ROLES.OWNER],
  [PRIVILEGED_ENTRY_POINTS.UNPAUSE]: [ROLES.OWNER],
  [PRIVILEGED_ENTRY_POINTS.UPDATE_CONFIG]: [ROLES.OWNER],
  [PRIVILEGED_ENTRY_POINTS.ROTATE_SIGNER]: [ROLES.OWNER],
};

/**
 * Evaluates authorization for a contract call.
 *
 * @param {object} params
 * @param {string} params.action Privileged action to invoke
 * @param {string} params.role Role of the calling actor
 * @param {string} [params.actor] Identifier or public key of calling actor
 * @param {boolean} [params.isPaused=false] Emergency paused state of the contract
 * @param {string} [params.resourceOwner] Payer or owner of the resource (for cross-tenant checks)
 * @returns {{ authorized: boolean, code?: string, reason?: string }}
 */
function evaluateAuthorization({
  action,
  role,
  actor = 'ACTOR_UNKNOWN',
  isPaused = false,
  resourceOwner = null,
}) {
  if (!action || !Object.values(PRIVILEGED_ENTRY_POINTS).includes(action)) {
    return {
      authorized: false,
      code: ERROR_CODES.INVALID_ACTION,
      reason: `Unknown or unprivileged action: "${action}"`,
    };
  }

  if (!role || !Object.values(ROLES).includes(role)) {
    return {
      authorized: false,
      code: ERROR_CODES.INVALID_ROLE,
      reason: `Unknown role: "${role}"`,
    };
  }

  // Contract Emergency Paused Rule:
  // When paused, NO action except UNPAUSE by OWNER is allowed.
  if (isPaused) {
    if (action === PRIVILEGED_ENTRY_POINTS.UNPAUSE && role === ROLES.OWNER) {
      return { authorized: true };
    }
    return {
      authorized: false,
      code: ERROR_CODES.CONTRACT_PAUSED,
      reason: `Contract is paused. Action "${action}" is blocked.`,
    };
  }

  // Role permissions check
  const allowedRoles = ROLE_PERMISSIONS[action] || [];
  if (!allowedRoles.includes(role)) {
    return {
      authorized: false,
      code: ERROR_CODES.UNAUTHORIZED_ROLE,
      reason: `Role "${role}" is not permitted to execute "${action}". Allowed: ${allowedRoles.join(', ')}`,
    };
  }

  // Cross-tenant / Ownership Boundary:
  // PAYER can only dispute their own transaction
  if (role === ROLES.PAYER && action === PRIVILEGED_ENTRY_POINTS.DISPUTE) {
    if (resourceOwner && actor !== resourceOwner) {
      return {
        authorized: false,
        code: ERROR_CODES.RESOURCE_ACCESS_DENIED,
        reason: `Payer "${actor}" cannot dispute resource owned by "${resourceOwner}"`,
      };
    }
  }

  return { authorized: true };
}

/**
 * Creates a deterministic Linear Congruential Generator (PRNG) from an integer seed.
 *
 * @param {number|bigint} [seed=123456789]
 * @returns {object} PRNG object with next(), choice(), and boolean()
 */
function createDeterministicPrng(seed = 123456789) {
  let state = BigInt(seed) & 0xFFFFFFFFn;

  return {
    next() {
      state = (state * 1664525n + 1013904223n) & 0xFFFFFFFFn;
      return Number(state) / 4294967296;
    },
    choice(arr) {
      const idx = Math.floor(this.next() * arr.length);
      return arr[idx];
    },
    boolean() {
      return this.next() > 0.5;
    },
    int(min, max) {
      return Math.floor(this.next() * (max - min + 1)) + min;
    },
  };
}

/**
 * Generates a randomized authorization test case using a deterministic PRNG.
 *
 * @param {object} prng
 * @returns {object} Generated test case
 */
function generateAuthorizationTestCase(prng) {
  const action = prng.choice(Object.values(PRIVILEGED_ENTRY_POINTS));
  const role = prng.choice(Object.values(ROLES));
  const isPaused = prng.boolean();
  const matchingOwner = prng.boolean();
  const actor = `ACTOR_${role}_${prng.int(1, 100)}`;
  const resourceOwner = matchingOwner ? actor : `OTHER_OWNER_${prng.int(101, 200)}`;

  const evaluation = evaluateAuthorization({
    action,
    role,
    actor,
    isPaused,
    resourceOwner,
  });

  return {
    action,
    role,
    actor,
    isPaused,
    resourceOwner,
    matchingOwner,
    evaluation,
  };
}

module.exports = {
  ROLES,
  PRIVILEGED_ENTRY_POINTS,
  ROLE_PERMISSIONS,
  ERROR_CODES,
  evaluateAuthorization,
  createDeterministicPrng,
  generateAuthorizationTestCase,
};
