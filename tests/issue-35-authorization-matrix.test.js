'use strict';

/**
 * Tests for Issue #35 — Authorization Matrix for Administrative Endpoints
 *
 * Verifies all acceptance criteria:
 *   AC1: Unauthorized requests return consistent 401/403 responses
 *   AC2: Every protected route has tests for allowed and denied roles
 *   AC3: Ownership / tenant isolation checks happen before data mutation
 *
 * Coverage:
 *   - No token → 401 MISSING_AUTH_TOKEN (consistent shape)
 *   - Expired token → 401 TOKEN_EXPIRED
 *   - Invalid token → 401 INVALID_AUTH_TOKEN
 *   - School-scoped token on super-admin endpoint → 403 INSUFFICIENT_ROLE
 *   - Cross-school token mismatch → 403 TENANT_MISMATCH
 *   - Super-admin bypass grants cross-school access
 *   - Role check enforced for finance-gated endpoints
 *   - All /api/admin/* routes require authentication
 *   - Authorization matrix structure is consistent and complete
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';

const jwt = require('jsonwebtoken');
const { requireAdminAuth, requireSchoolAuth } = require('../backend/src/middleware/auth');
const { MATRIX, flattenMatrix, endpointsForGroup } = require('../backend/src/middleware/authorizationMatrix');

// ── Shared mocks ──────────────────────────────────────────────────────────────

jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/cache', () => ({
  get: jest.fn().mockReturnValue(null),
  set: jest.fn(),
  del: jest.fn(),
  KEYS: { studentsAll: () => 'students:all' },
  TTL: { short: 60 },
}));

jest.mock('../backend/src/services/alertService', () => ({
  sendAdminAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/config/redisClient', () => ({
  getRedisClient: jest.fn().mockReturnValue(null),
  isRedisReady: jest.fn().mockReturnValue(false),
}));

// ── Token factories ───────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET;

function makeSuperAdminToken() {
  return jwt.sign({ role: 'admin', userId: 'admin-1' }, JWT_SECRET, { expiresIn: '1h' });
}

function makeSchoolToken(schoolId, roles = ['owner']) {
  return jwt.sign({ schoolId, roles, userId: 'user-1' }, JWT_SECRET, { expiresIn: '1h' });
}

function makeExpiredToken() {
  return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '-1s' });
}

function makeTokenWithWrongSecret() {
  return jwt.sign({ role: 'admin' }, 'wrong-secret', { expiresIn: '1h' });
}

// ── Middleware test harness ───────────────────────────────────────────────────

function makeReq(overrides = {}) {
  return {
    headers: {},
    cookies: {},
    ip: '127.0.0.1',
    connection: { remoteAddress: '127.0.0.1' },
    originalUrl: '/api/admin/log-level',
    params: {},
    query: {},
    ...overrides,
  };
}

function makeRes() {
  const res = {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// requireAdminAuth — consistent 401 / 403 responses
// ─────────────────────────────────────────────────────────────────────────────

describe('requireAdminAuth: consistent error responses', () => {
  test('returns 401 MISSING_AUTH_TOKEN when no token is provided', async () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await requireAdminAuth(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body).toMatchObject({ error: expect.any(String), code: 'MISSING_AUTH_TOKEN' });
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 TOKEN_EXPIRED for expired tokens', async () => {
    const req = makeReq({ headers: { authorization: `Bearer ${makeExpiredToken()}` } });
    const res = makeRes();
    const next = jest.fn();

    await requireAdminAuth(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body.code).toBe('TOKEN_EXPIRED');
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 INVALID_AUTH_TOKEN for a tampered token', async () => {
    const req = makeReq({ headers: { authorization: `Bearer ${makeTokenWithWrongSecret()}` } });
    const res = makeRes();
    const next = jest.fn();

    await requireAdminAuth(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body.code).toBe('INVALID_AUTH_TOKEN');
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 403 INSUFFICIENT_ROLE for a school-scoped token (no admin role)', async () => {
    const token = makeSchoolToken('school-a');
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await requireAdminAuth(req, res, next);

    expect(res._status).toBe(403);
    expect(res._body.code).toBe('INSUFFICIENT_ROLE');
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next() for a valid super-admin token (role:admin)', async () => {
    const token = makeSuperAdminToken();
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await requireAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res._status).toBeNull();
  });

  test('calls next() for a valid super-admin token (roles:[super_admin])', async () => {
    const token = jwt.sign({ roles: ['super_admin'], userId: 'sa-2' }, JWT_SECRET, { expiresIn: '1h' });
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await requireAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('error response always includes both error and code fields', async () => {
    const req = makeReq(); // no token
    const res = makeRes();

    await requireAdminAuth(req, res, jest.fn());

    expect(res._body).toHaveProperty('error');
    expect(res._body).toHaveProperty('code');
    expect(typeof res._body.error).toBe('string');
    expect(typeof res._body.code).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requireSchoolAuth — tenant isolation and role enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe('requireSchoolAuth: tenant isolation', () => {
  test('returns 401 MISSING_AUTH_TOKEN when no token provided', async () => {
    const req = makeReq({ headers: { 'x-school-id': 'school-a' } });
    const res = makeRes();

    await requireSchoolAuth()(req, res, jest.fn());

    expect(res._status).toBe(401);
    expect(res._body.code).toBe('MISSING_AUTH_TOKEN');
  });

  test('returns 403 TENANT_MISMATCH when token schoolId !== X-School-ID header', async () => {
    const token = makeSchoolToken('school-a');
    const req = makeReq({
      headers: {
        authorization: `Bearer ${token}`,
        'x-school-id': 'school-b', // different school
      },
    });
    const res = makeRes();
    const next = jest.fn();

    await requireSchoolAuth()(req, res, next);

    expect(res._status).toBe(403);
    expect(res._body.code).toBe('TENANT_MISMATCH');
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next() when token schoolId matches X-School-ID header', async () => {
    const token = makeSchoolToken('school-a');
    const req = makeReq({
      headers: {
        authorization: `Bearer ${token}`,
        'x-school-id': 'school-a',
      },
    });
    const res = makeRes();
    const next = jest.fn();

    await requireSchoolAuth()(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('super-admin token bypasses tenant check (cross-school access)', async () => {
    const token = makeSuperAdminToken();
    const req = makeReq({
      headers: {
        authorization: `Bearer ${token}`,
        'x-school-id': 'some-other-school',
      },
    });
    const res = makeRes();
    const next = jest.fn();

    await requireSchoolAuth()(req, res, next);

    // Super-admin must pass without TENANT_MISMATCH
    expect(next).toHaveBeenCalledTimes(1);
    expect(res._status).toBeNull();
  });

  test('returns 403 MISSING_TENANT_CLAIM for token without schoolId (non-super-admin)', async () => {
    const token = jwt.sign({ userId: 'u1', roles: ['staff'] }, JWT_SECRET, { expiresIn: '1h' });
    const req = makeReq({
      headers: {
        authorization: `Bearer ${token}`,
        'x-school-id': 'school-a',
      },
    });
    const res = makeRes();
    const next = jest.fn();

    await requireSchoolAuth()(req, res, next);

    expect(res._status).toBe(403);
    expect(res._body.code).toBe('MISSING_TENANT_CLAIM');
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 403 INSUFFICIENT_ROLE when token lacks the required role', async () => {
    const token = makeSchoolToken('school-a', ['staff']); // no 'owner' or 'finance' role
    const req = makeReq({
      headers: {
        authorization: `Bearer ${token}`,
        'x-school-id': 'school-a',
      },
    });
    const res = makeRes();
    const next = jest.fn();

    await requireSchoolAuth(['owner', 'finance'])(req, res, next);

    expect(res._status).toBe(403);
    expect(res._body.code).toBe('INSUFFICIENT_ROLE');
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next() when token has at least one of the required roles', async () => {
    const token = makeSchoolToken('school-a', ['finance', 'staff']);
    const req = makeReq({
      headers: {
        authorization: `Bearer ${token}`,
        'x-school-id': 'school-a',
      },
    });
    const res = makeRes();
    const next = jest.fn();

    await requireSchoolAuth(['owner', 'finance'])(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('sets req.schoolId from token (not from header)', async () => {
    const token = makeSchoolToken('school-a');
    const req = makeReq({
      headers: {
        authorization: `Bearer ${token}`,
        'x-school-id': 'school-a',
      },
    });
    const res = makeRes();
    const next = jest.fn();

    await requireSchoolAuth()(req, res, next);

    // schoolId on req comes from the token, not the header
    expect(req.schoolId).toBe('school-a');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: Ownership checks happen before data mutation
// ─────────────────────────────────────────────────────────────────────────────

describe('AC3: Ownership / tenant isolation before mutation', () => {
  test('cross-school token mismatch is rejected before any mutation code runs', async () => {
    const mutationSpy = jest.fn();

    const token = makeSchoolToken('school-a');
    const req = makeReq({
      headers: {
        authorization: `Bearer ${token}`,
        'x-school-id': 'school-b', // mismatched school
      },
    });
    const res = makeRes();

    const middleware = requireSchoolAuth();
    await middleware(req, res, mutationSpy);

    // mutationSpy (next) must NOT be called — tenant mismatch was caught first
    expect(mutationSpy).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(res._body.code).toBe('TENANT_MISMATCH');
  });

  test('role check is enforced before any mutation code runs', async () => {
    const mutationSpy = jest.fn();

    const token = makeSchoolToken('school-a', ['viewer']); // no write role
    const req = makeReq({
      headers: {
        authorization: `Bearer ${token}`,
        'x-school-id': 'school-a',
      },
    });
    const res = makeRes();

    const middleware = requireSchoolAuth(['owner', 'admin']);
    await middleware(req, res, mutationSpy);

    expect(mutationSpy).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(res._body.code).toBe('INSUFFICIENT_ROLE');
  });

  test('super-admin token reaches mutation code with cross-school context', async () => {
    const mutationSpy = jest.fn();

    const token = makeSuperAdminToken();
    const req = makeReq({
      headers: {
        authorization: `Bearer ${token}`,
        'x-school-id': 'school-other',
      },
    });
    const res = makeRes();

    await requireSchoolAuth(['owner'])(req, res, mutationSpy);

    // Super-admin bypasses tenant + role check
    expect(mutationSpy).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin route structure — every /api/admin route uses requireAdminAuth
// ─────────────────────────────────────────────────────────────────────────────

describe('Admin routes: all routes have requireAdminAuth', () => {
  const adminRoutes = require('../backend/src/routes/adminRoutes');

  function collectRouteMiddlewareNames(router) {
    const routes = [];
    for (const layer of router.stack) {
      if (!layer.route) continue;
      const middlewareNames = layer.route.stack.map((l) => l.handle.name || '<anon>');
      const methods = Object.keys(layer.route.methods)
        .filter((m) => layer.route.methods[m])
        .map((m) => m.toUpperCase());
      routes.push({ path: layer.route.path, methods, middlewareNames });
    }
    return routes;
  }

  test('every route in adminRoutes has requireAdminAuth in its middleware chain', () => {
    const routes = collectRouteMiddlewareNames(adminRoutes);
    expect(routes.length).toBeGreaterThan(0);

    const unprotected = routes.filter((r) => !r.middlewareNames.includes('requireAdminAuth'));
    if (unprotected.length > 0) {
      const msg = unprotected
        .map((r) => `${r.methods.join('|')} ${r.path}: [${r.middlewareNames.join(', ')}]`)
        .join('\n');
      throw new Error(`Admin routes missing requireAdminAuth:\n${msg}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Authorization matrix integrity
// ─────────────────────────────────────────────────────────────────────────────

describe('Authorization matrix structure and completeness', () => {
  test('MATRIX has expected top-level groups', () => {
    const groups = Object.keys(MATRIX);
    expect(groups).toContain('ADMIN_RUNTIME');
    expect(groups).toContain('AUDIT_LOG');
    expect(groups).toContain('STUDENT_WRITE');
    expect(groups).toContain('FEE_WRITE');
    expect(groups).toContain('PAYMENT_ADMIN');
    expect(groups).toContain('REPORT');
    expect(groups).toContain('PUBLIC');
  });

  test('every group has required fields', () => {
    for (const [name, group] of Object.entries(MATRIX)) {
      expect(group).toHaveProperty('authLevel');
      expect(group).toHaveProperty('roles');
      expect(group).toHaveProperty('endpoints');
      expect(Array.isArray(group.endpoints)).toBe(true);
      expect(group.endpoints.length).toBeGreaterThan(0);
      // Each endpoint entry must have method and path
      for (const ep of group.endpoints) {
        expect(ep).toHaveProperty('method');
        expect(ep).toHaveProperty('path');
        expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).toContain(ep.method);
        expect(ep.path.startsWith('/')).toBe(true);
      }
    }
  });

  test('authLevel values are one of the known levels', () => {
    const validLevels = new Set(['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PUBLIC']);
    for (const [name, group] of Object.entries(MATRIX)) {
      expect(validLevels.has(group.authLevel)).toBe(true);
    }
  });

  test('SUPER_ADMIN groups have admin/super_admin in roles array', () => {
    for (const [name, group] of Object.entries(MATRIX)) {
      if (group.authLevel === 'SUPER_ADMIN') {
        // Either uses legacy role:'admin' pattern OR explicit roles list
        const hasAdminRole = group.roles.includes('admin') || group.roles.includes('super_admin');
        expect(hasAdminRole).toBe(true);
      }
    }
  });

  test('flattenMatrix() returns a flat array with all endpoints', () => {
    const flat = flattenMatrix();
    expect(Array.isArray(flat)).toBe(true);
    expect(flat.length).toBeGreaterThan(0);
    for (const entry of flat) {
      expect(entry).toHaveProperty('method');
      expect(entry).toHaveProperty('path');
      expect(entry).toHaveProperty('group');
      expect(entry).toHaveProperty('authLevel');
    }
  });

  test('flattenMatrix() total count matches sum of all group endpoint counts', () => {
    const flat = flattenMatrix();
    const total = Object.values(MATRIX).reduce((sum, g) => sum + g.endpoints.length, 0);
    expect(flat.length).toBe(total);
  });

  test('endpointsForGroup() returns endpoints for a known group', () => {
    const eps = endpointsForGroup('ADMIN_RUNTIME');
    expect(Array.isArray(eps)).toBe(true);
    expect(eps.length).toBeGreaterThan(0);
  });

  test('endpointsForGroup() throws for an unknown group', () => {
    expect(() => endpointsForGroup('DOES_NOT_EXIST')).toThrow('Unknown authorization group');
  });

  test('no endpoint path appears more than once across the entire matrix', () => {
    const flat = flattenMatrix();
    const seen = new Map();
    const duplicates = [];
    for (const ep of flat) {
      const key = `${ep.method} ${ep.path}`;
      if (seen.has(key)) {
        duplicates.push(key);
      } else {
        seen.set(key, ep.group);
      }
    }
    if (duplicates.length > 0) {
      throw new Error(`Duplicate endpoints in matrix:\n${duplicates.join('\n')}`);
    }
  });

  test('PAYMENT_ADMIN group endpoints all belong to /api/payments path', () => {
    const eps = endpointsForGroup('PAYMENT_ADMIN');
    for (const ep of eps) {
      expect(ep.path.startsWith('/api/payments')).toBe(true);
    }
  });

  test('PUBLIC group endpoints do not require authentication', () => {
    const group = MATRIX.PUBLIC;
    expect(group.authLevel).toBe('PUBLIC');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cookie-based token accepted alongside Bearer token
// ─────────────────────────────────────────────────────────────────────────────

describe('Token sources: Bearer header and HttpOnly cookie', () => {
  test('requireAdminAuth accepts token from admin_token cookie', async () => {
    const token = makeSuperAdminToken();
    const req = makeReq({ cookies: { admin_token: token } });
    const res = makeRes();
    const next = jest.fn();

    await requireAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('requireAdminAuth prefers cookie over Bearer when both present', async () => {
    const validToken = makeSuperAdminToken();
    const invalidToken = makeTokenWithWrongSecret();
    const req = makeReq({
      cookies: { admin_token: validToken },
      headers: { authorization: `Bearer ${invalidToken}` },
    });
    const res = makeRes();
    const next = jest.fn();

    await requireAdminAuth(req, res, next);

    // Cookie takes precedence, so valid token → next() called
    expect(next).toHaveBeenCalledTimes(1);
  });
});
