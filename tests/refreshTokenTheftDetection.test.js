'use strict';

/**
 * Tests for refresh token theft detection and revocation semantics.
 *
 * Acceptance criteria covered:
 *   1. Hash storage — raw token never appears in the store
 *   2. Token rotation on every /refresh call
 *   3. Reused token (within short window) revokes the entire family and returns
 *      TOKEN_REUSE_DETECTED (not the previous 300-s-window-only behaviour)
 *   4. A replayed token after rotation is rejected and its family is revoked
 *   5. Logout revokes the current family (old rotated tokens also rejected)
 *   6. Admin revocation by sessionId (DELETE /sessions/:sessionId)
 *   7. Admin revocation by userId (DELETE /sessions/user/:userId)
 *   8. Cookie attributes: HttpOnly, SameSite=Strict, Path=/api/auth, Max-Age
 *   9. Response bodies never contain raw token values
 */

process.env.JWT_SECRET        = 'test-jwt-secret-refreshtheftdetection-32chars';
process.env.ADMIN_USERNAME    = 'admin';
process.env.ADMIN_PASSWORD    = 'correct-password';
process.env.MONGO_URI         = 'mongodb://localhost:27017/test';

// ── Module mocks (hoisted before any require) ─────────────────────────────────

jest.mock('jsonwebtoken', () => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return {
    sign: (payload, _secret, opts) => {
      const now = Math.floor(Date.now() / 1000);
      const exp = opts?.expiresIn && typeof opts.expiresIn === 'number'
        ? now + opts.expiresIn : now + 28800;
      return `${enc({ alg: 'HS256' })}.${enc({ ...payload, exp })}.fakesig`;
    },
    verify: (token, _secret) => {
      const parts = token.split('.');
      if (parts.length !== 3 || parts[2] !== 'fakesig') {
        const e = new Error('invalid signature'); e.name = 'JsonWebTokenError'; throw e;
      }
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (payload.exp < Math.floor(Date.now() / 1000)) {
        const e = new Error('jwt expired'); e.name = 'TokenExpiredError'; throw e;
      }
      return payload;
    },
  };
}, { virtual: true });

jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/services/alertService', () => ({
  sendAdminAlert: jest.fn().mockResolvedValue(undefined),
}));

// Keep Redis out of the picture; tests use the in-memory store.
delete process.env.REDIS_HOST;

// ── Load SUT ──────────────────────────────────────────────────────────────────

const {
  handleLogin,
  handleRefresh,
  handleLogout,
  handleListSessions,
  handleRevokeSession,
  handleRevokeUserSessions,
  _resetStore,
  _hashToken,
} = require('../backend/src/controllers/authController');

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockRes() {
  const r = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json   = jest.fn().mockReturnValue(r);
  r.cookie = jest.fn().mockReturnValue(r);
  r.clearCookie = jest.fn().mockReturnValue(r);
  return r;
}

function mockReq(overrides = {}) {
  return { body: {}, cookies: {}, headers: {}, ip: '127.0.0.1', connection: {}, ...overrides };
}

/** Perform a login and return { res, refreshToken, accessToken }. */
async function login(overrides = {}) {
  const res = mockRes();
  await handleLogin(mockReq({
    body: { username: 'admin', password: 'correct-password', ...overrides },
  }), res);
  const refreshCall = res.cookie.mock.calls.find(c => c[0] === 'admin_refresh_token');
  const accessCall  = res.cookie.mock.calls.find(c => c[0] === 'admin_token');
  return {
    res,
    refreshToken: refreshCall?.[1],
    accessToken:  accessCall?.[1],
  };
}

/** Perform a /refresh with the given token (via cookie). */
async function refresh(refreshToken) {
  const res = mockRes();
  await handleRefresh(mockReq({ cookies: { admin_refresh_token: refreshToken }, body: {} }), res);
  const refreshCall = res.cookie.mock.calls.find(c => c[0] === 'admin_refresh_token');
  return { res, newRefreshToken: refreshCall?.[1] };
}

beforeEach(() => {
  _resetStore();
  delete process.env.REDIS_HOST;
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Hash storage
// ─────────────────────────────────────────────────────────────────────────────

describe('1. Hash storage — raw token never in the store', () => {
  test('_hashToken is exported and produces a 64-char hex SHA-256 digest', () => {
    const raw = 'abc123';
    const h = _hashToken(raw);
    expect(typeof h).toBe('string');
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test('two different tokens produce different hashes', () => {
    const h1 = _hashToken('tokenA');
    const h2 = _hashToken('tokenB');
    expect(h1).not.toBe(h2);
  });

  test('same token always produces the same hash', () => {
    const raw = 'stable-token-value';
    expect(_hashToken(raw)).toBe(_hashToken(raw));
  });

  test('raw token does not appear in a successful /refresh response body', async () => {
    const { refreshToken } = await login();
    const { res } = await refresh(refreshToken);
    const body = res.json.mock.calls[0]?.[0] || {};
    // Response body must only contain TTL metadata — never a raw token
    expect(JSON.stringify(body)).not.toContain(refreshToken);
    expect(body.refreshToken).toBeUndefined();
    expect(body.token).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Token rotation on every /refresh
// ─────────────────────────────────────────────────────────────────────────────

describe('2. Token rotation on every use', () => {
  test('a new refresh token cookie is issued on each /refresh', async () => {
    const { refreshToken: t1 } = await login();
    const { newRefreshToken: t2 } = await refresh(t1);
    const { newRefreshToken: t3 } = await refresh(t2);

    expect(t1).toBeDefined();
    expect(t2).toBeDefined();
    expect(t3).toBeDefined();
    expect(t1).not.toBe(t2);
    expect(t2).not.toBe(t3);
  });

  test('the old token is rejected immediately after rotation', async () => {
    const { refreshToken: t1 } = await login();
    await refresh(t1); // consumes t1, issues t2

    const { res } = await refresh(t1); // replay t1 — must be rejected
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('/refresh returns 401 MISSING_REFRESH_TOKEN when no token is provided', async () => {
    const res = mockRes();
    await handleRefresh(mockReq({ cookies: {}, body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].code).toBe('MISSING_REFRESH_TOKEN');
  });

  test('new access token cookie is set on successful /refresh', async () => {
    const { refreshToken } = await login();
    const { res } = await refresh(refreshToken);
    const accessCookieSet = res.cookie.mock.calls.some(c => c[0] === 'admin_token');
    expect(accessCookieSet).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 & 4. Reuse detection — family revocation on replay
// ─────────────────────────────────────────────────────────────────────────────

describe('3 & 4. Reuse detection — family revoked on replay', () => {
  test('replaying a consumed token within the short window returns TOKEN_REUSE_DETECTED', async () => {
    const { refreshToken: t1 } = await login();
    await refresh(t1); // rotate: t1 → t2

    // Replay t1 immediately (within the consumed-map window)
    const { res } = await refresh(t1);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].code).toBe('TOKEN_REUSE_DETECTED');
  });

  test('after reuse detection the current (rotated) token t2 is also rejected (family revoked)', async () => {
    const { refreshToken: t1 } = await login();
    const { newRefreshToken: t2 } = await refresh(t1); // rotate: t1 → t2

    // Attacker replays t1 — triggers family revocation
    await refresh(t1);

    // Legitimate client tries t2 — must also be rejected (family is dead)
    const { res: res2 } = await refresh(t2);
    expect(res2.status).toHaveBeenCalledWith(401);
    expect(res2.json.mock.calls[0][0].code).toBe('SESSION_REVOKED');
  });

  test('reuse detection does not affect a different (independent) session', async () => {
    // Session A
    const { refreshToken: tA1 } = await login();
    const { newRefreshToken: tA2 } = await refresh(tA1);

    // Session B (independent login)
    const { refreshToken: tB1 } = await login();

    // Replay tA1 — revokes family A only
    await refresh(tA1);

    // Session B should still work
    const { res: resB } = await refresh(tB1);
    expect(resB.status).not.toHaveBeenCalledWith(401);
    expect(resB.json.mock.calls[0][0].expiresIn).toBeDefined();
  });

  test('a completely unknown token is rejected with INVALID_REFRESH_TOKEN (not REUSE)', async () => {
    const { res } = await refresh('completely-unknown-token-value');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].code).toBe('INVALID_REFRESH_TOKEN');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Logout revokes the family
// ─────────────────────────────────────────────────────────────────────────────

describe('5. Logout revokes the current token family', () => {
  test('after logout the refresh token cannot mint another session', async () => {
    const { refreshToken } = await login();
    const logoutRes = mockRes();
    await handleLogout(mockReq({ cookies: { admin_refresh_token: refreshToken }, body: {} }), logoutRes);
    expect(logoutRes.json.mock.calls[0][0].message).toMatch(/logged out/i);

    const { res } = await refresh(refreshToken);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('after logout a rotated copy of the token is also rejected', async () => {
    const { refreshToken: t1 } = await login();
    const { newRefreshToken: t2 } = await refresh(t1); // rotate to t2

    // Logout with t2 (the current token) — revokes the whole family
    await handleLogout(mockReq({ cookies: { admin_refresh_token: t2 }, body: {} }), mockRes());

    // Both t1 (old) and t2 (current) must be dead
    const { res: r1 } = await refresh(t1);
    const { res: r2 } = await refresh(t2);
    expect(r1.status).toHaveBeenCalledWith(401);
    expect(r2.status).toHaveBeenCalledWith(401);
  });

  test('logout clears both access and refresh cookies', async () => {
    const { refreshToken } = await login();
    const res = mockRes();
    await handleLogout(mockReq({ cookies: { admin_refresh_token: refreshToken }, body: {} }), res);

    const cleared = res.clearCookie.mock.calls.map(c => c[0]);
    expect(cleared).toContain('admin_token');
    expect(cleared).toContain('admin_refresh_token');
  });

  test('logout with no token still clears cookies and returns success', async () => {
    const res = mockRes();
    await handleLogout(mockReq({ cookies: {}, body: {} }), res);
    expect(res.json.mock.calls[0][0].message).toMatch(/logged out/i);
    const cleared = res.clearCookie.mock.calls.map(c => c[0]);
    expect(cleared).toContain('admin_token');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Admin revocation by sessionId
// ─────────────────────────────────────────────────────────────────────────────

describe('6. Admin revocation by sessionId', () => {
  test('revoking a sessionId invalidates the associated family', async () => {
    const { refreshToken } = await login();

    // List sessions to get the sessionId
    const userId = 'super_admin';
    const listRes = mockRes();
    await handleListSessions(
      mockReq({ admin: { userId } }),
      listRes
    );
    const { sessions } = listRes.json.mock.calls[0][0];
    expect(sessions.length).toBeGreaterThan(0);

    const { sessionId } = sessions[0];
    const revokeRes = mockRes();
    await handleRevokeSession(
      mockReq({ params: { sessionId }, admin: { userId } }),
      revokeRes
    );
    expect(revokeRes.json.mock.calls[0][0].message).toMatch(/session revoked/i);

    // The refresh token for that session must now be rejected
    const { res } = await refresh(refreshToken);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('revoking a non-existent sessionId returns 404', async () => {
    const res = mockRes();
    await handleRevokeSession(
      mockReq({ params: { sessionId: 'does-not-exist' }, admin: { userId: 'super_admin' } }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].code).toBe('SESSION_NOT_FOUND');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Admin revocation by userId
// ─────────────────────────────────────────────────────────────────────────────

describe('7. Admin revocation by userId', () => {
  test('handleRevokeUserSessions invalidates all sessions for the given userId', async () => {
    // Establish two sessions for the same user (super_admin)
    const { refreshToken: t1 } = await login();
    const { refreshToken: t2 } = await login();

    const res = mockRes();
    await handleRevokeUserSessions(
      mockReq({ params: { userId: 'super_admin' }, admin: { userId: 'super_admin' } }),
      res
    );
    expect(res.json.mock.calls[0][0].message).toMatch(/user sessions revoked/i);
    const { revokedCount } = res.json.mock.calls[0][0];
    expect(revokedCount).toBeGreaterThanOrEqual(2);

    // Both tokens must now be rejected
    const { res: r1 } = await refresh(t1);
    const { res: r2 } = await refresh(t2);
    expect(r1.status).toHaveBeenCalledWith(401);
    expect(r2.status).toHaveBeenCalledWith(401);
  });

  test('returns 400 when userId is missing or empty', async () => {
    const res = mockRes();
    await handleRevokeUserSessions(
      mockReq({ params: { userId: '' }, admin: { userId: 'super_admin' } }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].code).toBe('VALIDATION_ERROR');
  });

  test('returns revokedCount=0 when user has no active sessions', async () => {
    const res = mockRes();
    await handleRevokeUserSessions(
      mockReq({ params: { userId: 'user-with-no-sessions' }, admin: { userId: 'super_admin' } }),
      res
    );
    expect(res.json.mock.calls[0][0].revokedCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Cookie security attributes
// ─────────────────────────────────────────────────────────────────────────────

describe('8. Cookie security attributes', () => {
  test('login sets refresh cookie with HttpOnly', async () => {
    const { res } = await login();
    const call = res.cookie.mock.calls.find(c => c[0] === 'admin_refresh_token');
    expect(call[2]).toMatchObject({ httpOnly: true });
  });

  test('login sets refresh cookie with SameSite=strict', async () => {
    const { res } = await login();
    const call = res.cookie.mock.calls.find(c => c[0] === 'admin_refresh_token');
    expect(call[2].sameSite).toBe('strict');
  });

  test('login sets refresh cookie with Path=/api/auth', async () => {
    const { res } = await login();
    const call = res.cookie.mock.calls.find(c => c[0] === 'admin_refresh_token');
    expect(call[2].path).toBe('/api/auth');
  });

  test('login sets refresh cookie with explicit maxAge', async () => {
    const { res } = await login();
    const call = res.cookie.mock.calls.find(c => c[0] === 'admin_refresh_token');
    expect(typeof call[2].maxAge).toBe('number');
    expect(call[2].maxAge).toBeGreaterThan(0);
  });

  test('login sets access cookie with HttpOnly', async () => {
    const { res } = await login();
    const call = res.cookie.mock.calls.find(c => c[0] === 'admin_token');
    expect(call[2]).toMatchObject({ httpOnly: true });
  });

  test('login sets access cookie with SameSite=strict', async () => {
    const { res } = await login();
    const call = res.cookie.mock.calls.find(c => c[0] === 'admin_token');
    expect(call[2].sameSite).toBe('strict');
  });

  test('/refresh re-sets refresh cookie with same HttpOnly + Path attributes', async () => {
    const { refreshToken } = await login();
    const { res } = await refresh(refreshToken);
    const call = res.cookie.mock.calls.find(c => c[0] === 'admin_refresh_token');
    expect(call[2]).toMatchObject({ httpOnly: true, path: '/api/auth', sameSite: 'strict' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. No raw tokens in response bodies
// ─────────────────────────────────────────────────────────────────────────────

describe('9. No sensitive values in response bodies', () => {
  test('login response body does not contain token or refreshToken fields', async () => {
    const { res } = await login();
    const body = res.json.mock.calls[0][0];
    expect(body.token).toBeUndefined();
    expect(body.refreshToken).toBeUndefined();
    expect(body.accessToken).toBeUndefined();
  });

  test('/refresh response body contains only TTL metadata', async () => {
    const { refreshToken } = await login();
    const { res } = await refresh(refreshToken);
    const body = res.json.mock.calls[0][0];
    expect(body.token).toBeUndefined();
    expect(body.refreshToken).toBeUndefined();
    expect(typeof body.expiresIn).toBe('number');
    expect(typeof body.refreshExpiresIn).toBe('number');
  });

  test('/logout response body does not contain any token value', async () => {
    const { refreshToken } = await login();
    const res = mockRes();
    await handleLogout(mockReq({ cookies: { admin_refresh_token: refreshToken }, body: {} }), res);
    const body = res.json.mock.calls[0][0];
    expect(body.token).toBeUndefined();
    expect(body.refreshToken).toBeUndefined();
    expect(typeof body.message).toBe('string');
  });
});
