'use strict';

/**
 * Test data factory for multi-school isolation — Issue #99
 *
 * Provides deterministic, isolated test fixtures for:
 *   - schools   (wallet addresses, currencies, slugs)
 *   - users     (admin accounts with hashed passwords)
 *   - wallets   (valid Stellar public keys per school)
 *   - payments  (with explicit school ownership)
 *   - audit log entries (with explicit school ownership)
 *   - roles     (admin, finance, viewer)
 *
 * Design principles:
 *   1. Factories generate isolated defaults — every entity is scoped to a
 *      specific schoolId so cross-school collisions cannot happen by accident.
 *   2. Tests can deliberately create cross-school collisions by passing
 *      overlapping studentIds to two different schools.
 *   3. Secrets (JWT signing values, wallet addresses) are safe, fake,
 *      deterministic values — never real credentials or real Stellar keys.
 *   4. All factories are pure (no side-effects) — they return plain objects;
 *      persistence is the caller's responsibility.
 *
 * Usage:
 *   const F = require('./factories/testDataFactory');
 *
 *   const school = F.buildSchool({ schoolId: 'SCHOOL-A' });
 *   const user   = F.buildUser({ schoolId: 'SCHOOL-A', role: 'admin' });
 *   const student = F.buildStudent({ schoolId: 'SCHOOL-A', studentId: 'STU-001' });
 *   const payment = F.buildPayment({ schoolId: 'SCHOOL-A', studentId: 'STU-001' });
 */

// ─── Deterministic fake Stellar public-key pool ────────────────────────────
// These are syntactically valid Stellar public-key format addresses generated
// offline for test use only.  They are NOT associated with any real account.
const FAKE_STELLAR_ADDRESSES = [
  'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3PEKFHXN7',
  'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4R',
  'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCSC4R',
  'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDSC4R',
  'GEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEESC4R',
];

let addressIndex = 0;
function nextFakeStellarAddress() {
  const addr = FAKE_STELLAR_ADDRESSES[addressIndex % FAKE_STELLAR_ADDRESSES.length];
  addressIndex += 1;
  return addr;
}

// ─── Sequence counters for unique-by-default values ──────────────────────────
let schoolSeq   = 1;
let userSeq     = 1;
let studentSeq  = 1;
let paymentSeq  = 1;
let auditSeq    = 1;

/** Reset all sequence counters — call in afterEach / afterAll for clean state. */
function resetSequences() {
  schoolSeq   = 1;
  userSeq     = 1;
  studentSeq  = 1;
  paymentSeq  = 1;
  auditSeq    = 1;
  addressIndex = 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// School factory
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build a school fixture.
 *
 * @param {Object} overrides
 * @returns {Object} plain school document suitable for School.create()
 */
function buildSchool(overrides = {}) {
  const seq = schoolSeq++;
  return {
    schoolId:       `SCHOOL-${String(seq).padStart(3, '0')}`,
    name:           `Test School ${seq}`,
    slug:           `test-school-${seq}`,
    stellarAddress: nextFakeStellarAddress(),
    currency:       'XLM',
    localCurrency:  'USD',
    timezone:       'UTC',
    active:         true,
    quotaStudents:  500,
    ...overrides,
  };
}

/**
 * Build a pair of independent schools (convenient for isolation tests).
 *
 * @returns {{ schoolA: Object, schoolB: Object }}
 */
function buildSchoolPair(overridesA = {}, overridesB = {}) {
  return {
    schoolA: buildSchool({ ...overridesA }),
    schoolB: buildSchool({ ...overridesB }),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// User (admin) factory
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build a user fixture.
 *
 * The `passwordHash` is a fixed bcrypt hash of the string "Password123!"
 * computed offline for test use only — never use this hash in production.
 *
 * @param {Object} overrides
 * @returns {Object}
 */
function buildUser(overrides = {}) {
  const seq = userSeq++;
  // bcrypt hash of "Password123!" — safe, fixed, offline-computed
  const SAFE_TEST_PASSWORD_HASH =
    '$2b$10$placeholder_hash_for_test_data_factory_only_not_real';
  return {
    email:        `admin-${seq}@school-test.local`,
    passwordHash: SAFE_TEST_PASSWORD_HASH,
    schoolId:     overrides.schoolId || `SCHOOL-${String(schoolSeq).padStart(3, '0')}`,
    role:         'admin',
    active:       true,
    mfaEnabled:   false,
    ...overrides,
  };
}

/**
 * Build a user with the 'finance' role.
 */
function buildFinanceUser(overrides = {}) {
  return buildUser({ role: 'finance', ...overrides });
}

/**
 * Build a user with the 'viewer' role (read-only).
 */
function buildViewerUser(overrides = {}) {
  return buildUser({ role: 'viewer', ...overrides });
}

// ══════════════════════════════════════════════════════════════════════════════
// Wallet factory
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build a wallet descriptor for a school.
 * Returns { schoolId, stellarAddress } — the public key only; never a secret.
 *
 * @param {string} schoolId
 * @param {Object} overrides
 * @returns {{ schoolId: string, stellarAddress: string }}
 */
function buildWallet(schoolId, overrides = {}) {
  return {
    schoolId,
    stellarAddress: nextFakeStellarAddress(),
    network:        'testnet',
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Student factory
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build a student fixture owned by a specific school.
 *
 * @param {Object} overrides  Must include schoolId for isolation guarantees.
 * @returns {Object}
 */
function buildStudent(overrides = {}) {
  const seq = studentSeq++;
  const schoolId = overrides.schoolId || 'SCHOOL-001';
  return {
    schoolId,
    studentId:   `STU-${schoolId}-${String(seq).padStart(4, '0')}`,
    firstName:   `Student${seq}`,
    lastName:    'Test',
    email:       `student${seq}@school-test.local`,
    className:   'Grade 1',
    feeAmount:   250,
    feePaid:     false,
    fees:        [],
    deletedAt:   null,
    ...overrides,
  };
}

/**
 * Build two students with the SAME studentId in different schools.
 * Useful for verifying that cross-school collisions on studentId are blocked.
 *
 * @returns {{ studentA: Object, studentB: Object }}
 */
function buildCollisionStudents(sharedStudentId, schoolIdA, schoolIdB) {
  return {
    studentA: buildStudent({ schoolId: schoolIdA, studentId: sharedStudentId }),
    studentB: buildStudent({ schoolId: schoolIdB, studentId: sharedStudentId }),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Payment factory
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build a payment fixture owned by a specific school.
 *
 * @param {Object} overrides  Must include schoolId for isolation guarantees.
 * @returns {Object}
 */
function buildPayment(overrides = {}) {
  const seq     = paymentSeq++;
  const schoolId = overrides.schoolId || 'SCHOOL-001';
  const studentId = overrides.studentId || `STU-${schoolId}-0001`;
  return {
    schoolId,
    studentId,
    txHash:        `txhash-${schoolId}-${seq}`.toLowerCase().replace(/[^a-z0-9-]/g, ''),
    amount:        250,
    asset:         'XLM',
    status:        'SUCCESS',
    confirmedAt:   new Date('2024-01-15T10:00:00.000Z'),
    stellarMemo:   studentId,
    source:        nextFakeStellarAddress(),
    deletedAt:     null,
    ...overrides,
  };
}

/**
 * Build a payment with status PENDING_VERIFICATION.
 */
function buildPendingPayment(overrides = {}) {
  return buildPayment({ status: 'PENDING_VERIFICATION', confirmedAt: null, ...overrides });
}

/**
 * Build a payment with status FAILED.
 */
function buildFailedPayment(overrides = {}) {
  return buildPayment({ status: 'FAILED', confirmedAt: null, ...overrides });
}

/**
 * Build a payment with status OVERPAID.
 */
function buildOverpaidPayment(overrides = {}) {
  return buildPayment({ status: 'OVERPAID', amount: 500, ...overrides });
}

// ══════════════════════════════════════════════════════════════════════════════
// Audit log factory
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build an audit log entry owned by a specific school.
 *
 * @param {Object} overrides  Must include schoolId for isolation guarantees.
 * @returns {Object}
 */
function buildAuditLog(overrides = {}) {
  const seq     = auditSeq++;
  const schoolId = overrides.schoolId || 'SCHOOL-001';
  return {
    schoolId,
    actor:     overrides.actor || `admin-${schoolId}@school-test.local`,
    action:    'PAYMENT_VERIFIED',
    target:    `STU-${schoolId}-0001`,
    details:   `Payment ${seq} verified`,
    createdAt: new Date('2024-01-15T10:00:00.000Z'),
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Role descriptors
// ══════════════════════════════════════════════════════════════════════════════

const ROLES = Object.freeze({
  ADMIN:   'admin',
  FINANCE: 'finance',
  VIEWER:  'viewer',
});

/**
 * Build a role assignment descriptor.
 *
 * @param {string} schoolId
 * @param {string} userId
 * @param {string} role
 * @returns {{ schoolId: string, userId: string, role: string }}
 */
function buildRoleAssignment(schoolId, userId, role = ROLES.ADMIN) {
  if (!Object.values(ROLES).includes(role)) {
    throw new Error(`Unknown role "${role}". Valid roles: ${Object.values(ROLES).join(', ')}`);
  }
  return { schoolId, userId, role };
}

// ══════════════════════════════════════════════════════════════════════════════
// Scenario helpers — pre-assembled fixtures for common test scenarios
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build a complete isolated school scenario with one admin user, one student,
 * and one payment — all scoped to the same schoolId.
 *
 * @param {string} schoolId
 * @returns {{ school, user, student, payment, auditLog }}
 */
function buildIsolatedSchoolScenario(schoolId) {
  const school   = buildSchool({ schoolId });
  const user     = buildUser({ schoolId, role: ROLES.ADMIN });
  const student  = buildStudent({ schoolId });
  const payment  = buildPayment({ schoolId, studentId: student.studentId });
  const auditLog = buildAuditLog({
    schoolId,
    actor:  user.email,
    target: student.studentId,
  });
  return { school, user, student, payment, auditLog };
}

/**
 * Build a two-school collision scenario where:
 *   - schoolA and schoolB each have a student with the SAME studentId
 *   - schoolA and schoolB each have a payment for that student
 *
 * Use this to test that cross-school queries cannot return the wrong tenant's data.
 *
 * @param {string} sharedStudentId
 * @returns {{ schoolA, schoolB, studentA, studentB, paymentA, paymentB }}
 */
function buildCrossSchoolCollisionScenario(sharedStudentId = 'SHARED-STU-001') {
  const schoolA  = buildSchool({ schoolId: 'COLLISION-SCHOOL-A' });
  const schoolB  = buildSchool({ schoolId: 'COLLISION-SCHOOL-B' });

  const { studentA, studentB } = buildCollisionStudents(
    sharedStudentId,
    schoolA.schoolId,
    schoolB.schoolId,
  );

  const paymentA = buildPayment({
    schoolId:  schoolA.schoolId,
    studentId: sharedStudentId,
    amount:    100,
  });
  const paymentB = buildPayment({
    schoolId:  schoolB.schoolId,
    studentId: sharedStudentId,
    amount:    200,
  });

  return { schoolA, schoolB, studentA, studentB, paymentA, paymentB };
}

// ══════════════════════════════════════════════════════════════════════════════
// Exports
// ══════════════════════════════════════════════════════════════════════════════
module.exports = {
  // Builders
  buildSchool,
  buildSchoolPair,
  buildUser,
  buildFinanceUser,
  buildViewerUser,
  buildWallet,
  buildStudent,
  buildCollisionStudents,
  buildPayment,
  buildPendingPayment,
  buildFailedPayment,
  buildOverpaidPayment,
  buildAuditLog,
  buildRoleAssignment,

  // Scenario helpers
  buildIsolatedSchoolScenario,
  buildCrossSchoolCollisionScenario,

  // Constants
  ROLES,

  // State management
  resetSequences,
};
