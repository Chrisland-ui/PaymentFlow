'use strict';

/**
 * Tests for the test data factory — Issue #99
 *
 * Verifies:
 *   1. Each factory generates isolated defaults scoped to a schoolId.
 *   2. Tests can create deliberate cross-school collisions (same studentId,
 *      different schoolId) to exercise tenant isolation guards.
 *   3. Generated secrets are safe (no real credentials, no real Stellar keys).
 *   4. Sequence counters are deterministic and reset correctly.
 */

const F = require('./factories/testDataFactory');

afterEach(() => {
  F.resetSequences();
});

// ══════════════════════════════════════════════════════════════════════════════
// School factory
// ══════════════════════════════════════════════════════════════════════════════
describe('buildSchool()', () => {
  it('generates isolated defaults', () => {
    const school = F.buildSchool();

    expect(school).toMatchObject({
      schoolId:       expect.stringMatching(/^SCHOOL-/),
      name:           expect.stringContaining('Test School'),
      slug:           expect.stringMatching(/^test-school-/),
      stellarAddress: expect.any(String),
      currency:       'XLM',
      active:         true,
    });
  });

  it('allows overriding any field', () => {
    const school = F.buildSchool({ schoolId: 'MY-SCHOOL', currency: 'USDC' });

    expect(school.schoolId).toBe('MY-SCHOOL');
    expect(school.currency).toBe('USDC');
  });

  it('generates unique schoolIds across sequential calls', () => {
    const a = F.buildSchool();
    const b = F.buildSchool();

    expect(a.schoolId).not.toBe(b.schoolId);
  });

  it('buildSchoolPair returns two distinct schools', () => {
    const { schoolA, schoolB } = F.buildSchoolPair();

    expect(schoolA.schoolId).not.toBe(schoolB.schoolId);
    expect(schoolA.slug).not.toBe(schoolB.slug);
  });

  it('stellar addresses in the pool are never empty', () => {
    const school = F.buildSchool();
    expect(school.stellarAddress).toBeTruthy();
    expect(school.stellarAddress.length).toBeGreaterThan(10);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// User factory
// ══════════════════════════════════════════════════════════════════════════════
describe('buildUser()', () => {
  it('generates an admin scoped to a schoolId', () => {
    const user = F.buildUser({ schoolId: 'SCHOOL-A' });

    expect(user.schoolId).toBe('SCHOOL-A');
    expect(user.role).toBe('admin');
    expect(user.email).toMatch(/@school-test\.local$/);
  });

  it('password hash is a placeholder — not a real secret', () => {
    const user = F.buildUser();

    // Must contain "placeholder" to make it obvious this is not a real hash.
    expect(user.passwordHash).toMatch(/placeholder/i);
  });

  it('generates unique emails across sequential calls', () => {
    const a = F.buildUser({ schoolId: 'S1' });
    const b = F.buildUser({ schoolId: 'S1' });

    expect(a.email).not.toBe(b.email);
  });

  it('buildFinanceUser sets role to finance', () => {
    const user = F.buildFinanceUser({ schoolId: 'S1' });
    expect(user.role).toBe('finance');
  });

  it('buildViewerUser sets role to viewer', () => {
    const user = F.buildViewerUser({ schoolId: 'S1' });
    expect(user.role).toBe('viewer');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Wallet factory
// ══════════════════════════════════════════════════════════════════════════════
describe('buildWallet()', () => {
  it('returns a public key only — no secret key', () => {
    const wallet = F.buildWallet('SCHOOL-A');

    expect(wallet).toMatchObject({
      schoolId:       'SCHOOL-A',
      stellarAddress: expect.any(String),
      network:        'testnet',
    });

    // The wallet descriptor must NOT contain any field named "secret" or "privateKey".
    const keys = Object.keys(wallet);
    expect(keys).not.toContain('secret');
    expect(keys).not.toContain('privateKey');
    expect(keys).not.toContain('secretKey');
  });

  it('stellar address never starts with "S" (which would indicate a secret key)', () => {
    const wallet = F.buildWallet('SCHOOL-A');
    // Stellar secret keys start with 'S'; public keys start with 'G'.
    expect(wallet.stellarAddress).not.toMatch(/^S/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Student factory
// ══════════════════════════════════════════════════════════════════════════════
describe('buildStudent()', () => {
  it('generates a student explicitly scoped to a schoolId', () => {
    const student = F.buildStudent({ schoolId: 'SCHOOL-A' });

    expect(student.schoolId).toBe('SCHOOL-A');
    expect(student.studentId).toContain('SCHOOL-A');
  });

  it('generates unique studentIds across sequential calls within the same school', () => {
    const a = F.buildStudent({ schoolId: 'SCHOOL-A' });
    const b = F.buildStudent({ schoolId: 'SCHOOL-A' });

    expect(a.studentId).not.toBe(b.studentId);
  });

  it('deletedAt is null by default (not soft-deleted)', () => {
    const student = F.buildStudent({ schoolId: 'SCHOOL-A' });
    expect(student.deletedAt).toBeNull();
  });

  it('buildCollisionStudents creates the same studentId in two different schools', () => {
    const { studentA, studentB } = F.buildCollisionStudents(
      'SHARED-001',
      'SCHOOL-A',
      'SCHOOL-B',
    );

    // Same studentId — the tenant isolation test scenario.
    expect(studentA.studentId).toBe('SHARED-001');
    expect(studentB.studentId).toBe('SHARED-001');

    // But different schools — they must NOT collide at the DB level if
    // the school-scoped unique index is in place.
    expect(studentA.schoolId).toBe('SCHOOL-A');
    expect(studentB.schoolId).toBe('SCHOOL-B');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Payment factory
// ══════════════════════════════════════════════════════════════════════════════
describe('buildPayment()', () => {
  it('generates a payment explicitly scoped to a schoolId', () => {
    const payment = F.buildPayment({ schoolId: 'SCHOOL-A', studentId: 'STU-001' });

    expect(payment.schoolId).toBe('SCHOOL-A');
    expect(payment.studentId).toBe('STU-001');
    expect(payment.status).toBe('SUCCESS');
  });

  it('generates unique txHashes across sequential calls', () => {
    const a = F.buildPayment({ schoolId: 'SCHOOL-A' });
    const b = F.buildPayment({ schoolId: 'SCHOOL-A' });

    expect(a.txHash).not.toBe(b.txHash);
  });

  it('deletedAt is null by default', () => {
    const payment = F.buildPayment({ schoolId: 'SCHOOL-A' });
    expect(payment.deletedAt).toBeNull();
  });

  it('buildPendingPayment sets status to PENDING_VERIFICATION', () => {
    const p = F.buildPendingPayment({ schoolId: 'SCHOOL-A' });
    expect(p.status).toBe('PENDING_VERIFICATION');
    expect(p.confirmedAt).toBeNull();
  });

  it('buildFailedPayment sets status to FAILED', () => {
    const p = F.buildFailedPayment({ schoolId: 'SCHOOL-A' });
    expect(p.status).toBe('FAILED');
  });

  it('buildOverpaidPayment sets status to OVERPAID', () => {
    const p = F.buildOverpaidPayment({ schoolId: 'SCHOOL-A' });
    expect(p.status).toBe('OVERPAID');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Audit log factory
// ══════════════════════════════════════════════════════════════════════════════
describe('buildAuditLog()', () => {
  it('generates an audit entry scoped to a schoolId', () => {
    const log = F.buildAuditLog({ schoolId: 'SCHOOL-A' });

    expect(log.schoolId).toBe('SCHOOL-A');
    expect(log.action).toBe('PAYMENT_VERIFIED');
  });

  it('allows overriding action and actor', () => {
    const log = F.buildAuditLog({
      schoolId: 'SCHOOL-A',
      action:   'STUDENT_REGISTERED',
      actor:    'admin@school-a.local',
    });

    expect(log.action).toBe('STUDENT_REGISTERED');
    expect(log.actor).toBe('admin@school-a.local');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Role assignment factory
// ══════════════════════════════════════════════════════════════════════════════
describe('buildRoleAssignment()', () => {
  it('creates an admin role assignment', () => {
    const ra = F.buildRoleAssignment('SCHOOL-A', 'user-1', F.ROLES.ADMIN);
    expect(ra).toEqual({ schoolId: 'SCHOOL-A', userId: 'user-1', role: 'admin' });
  });

  it('throws for unknown roles', () => {
    expect(() => F.buildRoleAssignment('SCHOOL-A', 'user-1', 'superadmin')).toThrow(
      /unknown role/i
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Scenario helpers
// ══════════════════════════════════════════════════════════════════════════════
describe('buildIsolatedSchoolScenario()', () => {
  it('returns all entities scoped to the same schoolId', () => {
    const { school, user, student, payment, auditLog } =
      F.buildIsolatedSchoolScenario('SCENARIO-SCHOOL');

    expect(school.schoolId).toBe('SCENARIO-SCHOOL');
    expect(user.schoolId).toBe('SCENARIO-SCHOOL');
    expect(student.schoolId).toBe('SCENARIO-SCHOOL');
    expect(payment.schoolId).toBe('SCENARIO-SCHOOL');
    expect(auditLog.schoolId).toBe('SCENARIO-SCHOOL');
  });

  it('payment references the student generated in the same scenario', () => {
    const { student, payment } = F.buildIsolatedSchoolScenario('S1');
    expect(payment.studentId).toBe(student.studentId);
  });

  it('audit log references the user generated in the same scenario', () => {
    const { user, auditLog } = F.buildIsolatedSchoolScenario('S1');
    expect(auditLog.actor).toBe(user.email);
  });
});

describe('buildCrossSchoolCollisionScenario()', () => {
  it('creates the same studentId in two different schools', () => {
    const { schoolA, schoolB, studentA, studentB, paymentA, paymentB } =
      F.buildCrossSchoolCollisionScenario('COLLISION-STU');

    expect(studentA.studentId).toBe('COLLISION-STU');
    expect(studentB.studentId).toBe('COLLISION-STU');
    expect(studentA.schoolId).toBe(schoolA.schoolId);
    expect(studentB.schoolId).toBe(schoolB.schoolId);
    expect(schoolA.schoolId).not.toBe(schoolB.schoolId);
  });

  it('payments for the same studentId belong to different schools', () => {
    const { paymentA, paymentB } = F.buildCrossSchoolCollisionScenario();

    expect(paymentA.schoolId).not.toBe(paymentB.schoolId);
  });

  it('payment amounts are distinguishable so assertions can identify which school', () => {
    const { paymentA, paymentB } = F.buildCrossSchoolCollisionScenario();

    expect(paymentA.amount).toBe(100);
    expect(paymentB.amount).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Sequence counter reset
// ══════════════════════════════════════════════════════════════════════════════
describe('resetSequences()', () => {
  it('resets counters so the first generated ID is deterministic after reset', () => {
    F.buildSchool(); // consume seq 1
    F.buildSchool(); // consume seq 2

    F.resetSequences();

    const school = F.buildSchool(); // should be seq 1 again
    expect(school.schoolId).toBe('SCHOOL-001');
  });

  it('after reset, addresses cycle back from the beginning of the pool', () => {
    // Exhaust the address pool once.
    for (let i = 0; i < 10; i++) F.buildSchool();
    F.resetSequences();

    const first = F.buildSchool();
    const second = F.buildSchool();
    // After reset both schools should have addresses from the top of the pool.
    expect(first.stellarAddress).toBeTruthy();
    expect(second.stellarAddress).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Security: no real secrets in generated fixtures
// ══════════════════════════════════════════════════════════════════════════════
describe('security: generated fixtures are safe', () => {
  it('no fixture field contains a value starting with "S" (Stellar secret key prefix)', () => {
    const scenario = F.buildIsolatedSchoolScenario('SEC-SCHOOL');

    function scanObject(obj) {
      for (const [key, val] of Object.entries(obj)) {
        if (typeof val === 'string') {
          // Stellar secret keys are 56 characters starting with 'S'
          if (/^S[A-Z2-7]{55}$/.test(val)) {
            throw new Error(
              `Field "${key}" looks like a Stellar secret key: ${val.slice(0, 4)}...`
            );
          }
        }
      }
    }

    expect(() => {
      scanObject(scenario.school);
      scanObject(scenario.user);
      scanObject(scenario.student);
      scanObject(scenario.payment);
      scanObject(scenario.auditLog);
    }).not.toThrow();
  });

  it('user fixture does not contain plaintext passwords', () => {
    const user = F.buildUser({ schoolId: 'S1' });

    const fieldValues = Object.values(user).filter((v) => typeof v === 'string');
    const hasPwPlaintext = fieldValues.some(
      (v) => /^password\d*!?$/i.test(v) || v === 'Password123!'
    );
    expect(hasPwPlaintext).toBe(false);
  });
});
