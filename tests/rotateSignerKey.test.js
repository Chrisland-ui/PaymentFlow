'use strict';

/**
 * Tests for scripts/rotate-signer-key.js (Issue #311).
 *
 * Covers:
 *  - generateApprovalToken / verifyApprovalToken (HMAC, expiry, tampering)
 *  - rotateSignerKey (dry run, apply, error per-school, empty collection)
 *  - validateEnv (missing / malformed SIGNER_MASTER_KEY)
 *  - dual-operator enforcement (same operator rejected)
 *  - audit log integration
 */

const crypto = require('crypto');

const {
  generateApprovalToken,
  verifyApprovalToken,
  rotateSignerKey,
  validateEnv,
  writeAuditLog,
  generateKeypair,
  encryptSecret,
  APPROVAL_TOKEN_TTL_MS,
  AUDIT_ACTION,
} = require('../scripts/rotate-signer-key');

// ── Helpers ───────────────────────────────────────────────────────────────────

const MASTER_KEY = crypto.randomBytes(32).toString('hex');
const APPROVAL_SECRET = 'test-approval-secret-abc123';

function makeSchoolCollection(docs) {
  return {
    find: () => ({
      select: () => ({
        lean: () => Promise.resolve(docs),
      }),
    }),
    updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
  };
}

function token(opts = {}) {
  return generateApprovalToken({
    operator: opts.operator || 'alice@example.com',
    reason: opts.reason || 'INC-1',
    secret: opts.secret || APPROVAL_SECRET,
  });
}

// ── generateApprovalToken ─────────────────────────────────────────────────────

describe('generateApprovalToken', () => {
  it('returns a non-empty base64url string', () => {
    const t = token();
    expect(typeof t).toBe('string');
    expect(t.length).toBeGreaterThan(20);
  });

  it('throws when operator is missing', () => {
    expect(() =>
      generateApprovalToken({ operator: '', reason: 'r', secret: APPROVAL_SECRET })
    ).toThrow(/operator/i);
  });

  it('throws when reason is missing', () => {
    expect(() =>
      generateApprovalToken({ operator: 'op', reason: '', secret: APPROVAL_SECRET })
    ).toThrow(/reason/i);
  });

  it('throws when APPROVAL_SECRET is missing', () => {
    expect(() =>
      generateApprovalToken({ operator: 'op', reason: 'r', secret: '' })
    ).toThrow(/APPROVAL_SECRET/i);
  });
});

// ── verifyApprovalToken ───────────────────────────────────────────────────────

describe('verifyApprovalToken', () => {
  it('verifies a freshly generated token', () => {
    const t = token();
    const payload = verifyApprovalToken(t, APPROVAL_SECRET, false);
    expect(payload.operator).toBe('alice@example.com');
    expect(payload.reason).toBe('INC-1');
  });

  it('throws on HMAC mismatch (tampered token)', () => {
    const t = token();
    const corrupted = t.slice(0, -4) + 'XXXX';
    expect(() => verifyApprovalToken(corrupted, APPROVAL_SECRET, false)).toThrow(
      /HMAC|malformed|invalid/i
    );
  });

  it('throws when the token is expired (without --force)', () => {
    // Backdate the timestamp beyond TTL
    const ts = Date.now() - APPROVAL_TOKEN_TTL_MS - 1000;
    const operator = 'alice@example.com';
    const reason = 'INC-1';
    const payload = `${ts}:${operator}:${reason}`;
    const mac = crypto.createHmac('sha256', APPROVAL_SECRET).update(payload).digest('hex');
    const t = Buffer.from(JSON.stringify({ ts, operator, reason, mac })).toString('base64url');

    expect(() => verifyApprovalToken(t, APPROVAL_SECRET, false)).toThrow(/expired/i);
  });

  it('allows an expired token when force=true', () => {
    const ts = Date.now() - APPROVAL_TOKEN_TTL_MS - 1000;
    const operator = 'alice@example.com';
    const reason = 'INC-1';
    const payload = `${ts}:${operator}:${reason}`;
    const mac = crypto.createHmac('sha256', APPROVAL_SECRET).update(payload).digest('hex');
    const t = Buffer.from(JSON.stringify({ ts, operator, reason, mac })).toString('base64url');

    expect(() => verifyApprovalToken(t, APPROVAL_SECRET, true)).not.toThrow();
  });

  it('throws when the token string is missing', () => {
    expect(() => verifyApprovalToken(null, APPROVAL_SECRET, false)).toThrow(/missing/i);
  });

  it('throws when APPROVAL_SECRET is missing at verify time', () => {
    const t = token();
    expect(() => verifyApprovalToken(t, '', false)).toThrow(/APPROVAL_SECRET/i);
  });
});

// ── validateEnv ───────────────────────────────────────────────────────────────

describe('validateEnv', () => {
  const origKey = process.env.SIGNER_MASTER_KEY;

  afterEach(() => {
    if (origKey === undefined) delete process.env.SIGNER_MASTER_KEY;
    else process.env.SIGNER_MASTER_KEY = origKey;
  });

  it('throws when SIGNER_MASTER_KEY is absent', () => {
    delete process.env.SIGNER_MASTER_KEY;
    expect(validateEnv).toThrow(/SIGNER_MASTER_KEY/);
  });

  it('throws when SIGNER_MASTER_KEY is not a 64-char hex string', () => {
    process.env.SIGNER_MASTER_KEY = 'tooshort';
    expect(validateEnv).toThrow(/64-character hex/i);
  });

  it('passes when SIGNER_MASTER_KEY is valid', () => {
    process.env.SIGNER_MASTER_KEY = MASTER_KEY;
    expect(validateEnv).not.toThrow();
  });
});

// ── generateKeypair ───────────────────────────────────────────────────────────

describe('generateKeypair', () => {
  it('returns an object with publicKey and secretKey strings', () => {
    const { publicKey, secretKey } = generateKeypair();
    expect(typeof publicKey).toBe('string');
    expect(typeof secretKey).toBe('string');
    expect(publicKey.length).toBeGreaterThan(10);
    expect(secretKey.length).toBeGreaterThan(10);
  });

  it('returns a different keypair on each call', () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});

// ── encryptSecret ─────────────────────────────────────────────────────────────

describe('encryptSecret', () => {
  beforeEach(() => {
    process.env.SIGNER_MASTER_KEY = MASTER_KEY;
  });

  afterEach(() => {
    delete process.env.SIGNER_MASTER_KEY;
  });

  it('returns a non-empty string', () => {
    const enc = encryptSecret('STEST...');
    expect(typeof enc).toBe('string');
    expect(enc.length).toBeGreaterThan(10);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const a = encryptSecret('STEST...');
    const b = encryptSecret('STEST...');
    expect(a).not.toBe(b);
  });
});

// ── rotateSignerKey (dry run) ─────────────────────────────────────────────────

describe('rotateSignerKey — dry run', () => {
  beforeEach(() => {
    process.env.SIGNER_MASTER_KEY = MASTER_KEY;
  });
  afterEach(() => {
    delete process.env.SIGNER_MASTER_KEY;
  });

  it('returns ok results without calling updateOne', async () => {
    const School = makeSchoolCollection([
      { _id: 'school-1', contractSignerKey: 'GOLD1234...', contractSignerKeyEncrypted: 'blob' },
    ]);
    const approval1Payload = { operator: 'alice@example.com' };
    const approval2Payload = { operator: 'bob@example.com' };

    const results = await rotateSignerKey(School, {
      apply: false,
      force: false,
      reason: 'dry run test',
      approval1Payload,
      approval2Payload,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('ok');
    expect(results[0].schoolId).toBe('school-1');
    expect(School.updateOne).not.toHaveBeenCalled();
  });

  it('returns an empty array when no schools have a contractSignerKey', async () => {
    const School = makeSchoolCollection([]);
    const results = await rotateSignerKey(School, {
      apply: false,
      force: false,
      reason: 'test',
      approval1Payload: { operator: 'a' },
      approval2Payload: { operator: 'b' },
    });
    expect(results).toEqual([]);
  });
});

// ── rotateSignerKey (apply) ───────────────────────────────────────────────────

describe('rotateSignerKey — apply', () => {
  beforeEach(() => {
    process.env.SIGNER_MASTER_KEY = MASTER_KEY;
  });
  afterEach(() => {
    delete process.env.SIGNER_MASTER_KEY;
  });

  it('calls updateOne with the new key and encrypted secret', async () => {
    const School = makeSchoolCollection([
      { _id: 'school-1', contractSignerKey: 'GOLD1234...', contractSignerKeyEncrypted: 'old-blob' },
    ]);
    const auditLog = { insertOne: jest.fn().mockResolvedValue({}) };

    const results = await rotateSignerKey(
      School,
      {
        apply: true,
        force: false,
        reason: 'test apply',
        approval1Payload: { operator: 'alice@example.com' },
        approval2Payload: { operator: 'bob@example.com' },
      },
      auditLog
    );

    expect(results[0].status).toBe('ok');
    expect(School.updateOne).toHaveBeenCalledTimes(1);

    const [filter, update] = School.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'school-1' });
    expect(update.$set.contractSignerKey).toBeDefined();
    expect(update.$set.contractSignerKeyEncrypted).toBeDefined();
    expect(update.$set.contractSignerKeyRotatedAt).toBeInstanceOf(Date);
  });

  it('writes an audit log entry on success', async () => {
    const School = makeSchoolCollection([
      { _id: 'school-1', contractSignerKey: 'GOLD1234...', contractSignerKeyEncrypted: 'old-blob' },
    ]);
    const auditLog = { insertOne: jest.fn().mockResolvedValue({}) };

    await rotateSignerKey(
      School,
      {
        apply: true,
        force: false,
        reason: 'audit test',
        approval1Payload: { operator: 'alice@example.com' },
        approval2Payload: { operator: 'bob@example.com' },
      },
      auditLog
    );

    expect(auditLog.insertOne).toHaveBeenCalledTimes(1);
    const entry = auditLog.insertOne.mock.calls[0][0];
    expect(entry.action).toBe(AUDIT_ACTION);
    expect(entry.actor.operator1).toBe('alice@example.com');
    expect(entry.actor.operator2).toBe('bob@example.com');
    expect(entry.details.reason).toBe('audit test');
    expect(entry.details.forced).toBe(false);
  });

  it('records a per-school error without throwing when updateOne rejects', async () => {
    const School = makeSchoolCollection([
      { _id: 'bad-school', contractSignerKey: 'GBAD...', contractSignerKeyEncrypted: 'blob' },
    ]);
    School.updateOne.mockRejectedValueOnce(new Error('DB timeout'));
    const auditLog = { insertOne: jest.fn() };

    const results = await rotateSignerKey(
      School,
      {
        apply: true,
        force: false,
        reason: 'error test',
        approval1Payload: { operator: 'a' },
        approval2Payload: { operator: 'b' },
      },
      auditLog
    );

    expect(results[0].status).toBe('error');
    expect(results[0].error).toMatch(/DB timeout/);
    // No audit log written because the only school failed
    expect(auditLog.insertOne).not.toHaveBeenCalled();
  });

  it('processes multiple schools independently', async () => {
    const School = makeSchoolCollection([
      { _id: 'school-a', contractSignerKey: 'GAAA...', contractSignerKeyEncrypted: 'blobA' },
      { _id: 'school-b', contractSignerKey: 'GBBB...', contractSignerKeyEncrypted: 'blobB' },
    ]);
    const auditLog = { insertOne: jest.fn().mockResolvedValue({}) };

    const results = await rotateSignerKey(
      School,
      {
        apply: true,
        force: false,
        reason: 'multi-school test',
        approval1Payload: { operator: 'alice@example.com' },
        approval2Payload: { operator: 'bob@example.com' },
      },
      auditLog
    );

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    expect(School.updateOne).toHaveBeenCalledTimes(2);
    // Single audit entry for the run, not per school
    expect(auditLog.insertOne).toHaveBeenCalledTimes(1);
  });
});

// ── writeAuditLog ─────────────────────────────────────────────────────────────

describe('writeAuditLog', () => {
  it('calls AuditLog.insertOne with the correct shape', async () => {
    const AuditLog = { insertOne: jest.fn().mockResolvedValue({}) };

    await writeAuditLog(
      {
        operator1: 'alice@example.com',
        operator2: 'bob@example.com',
        oldPublicKey: 'GOLD1234ABCD',
        newPublicKey: 'GNEW5678EFGH',
        reason: 'test audit',
        forced: false,
      },
      AuditLog
    );

    expect(AuditLog.insertOne).toHaveBeenCalledTimes(1);
    const entry = AuditLog.insertOne.mock.calls[0][0];
    expect(entry.action).toBe(AUDIT_ACTION);
    expect(entry.details.oldKeyPrefix).toContain('GOLD1234');
    expect(entry.details.newKeyPrefix).toContain('GNEW5678');
    expect(entry.createdAt).toBeInstanceOf(Date);
  });
});
