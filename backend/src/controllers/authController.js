'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');
const { getRedisClient, isRedisReady } = require('../config/redisClient');
const { get, set, del } = require('../cache');
const { sendAdminAlert } = require('../services/alertService');
const School = require('../models/schoolModel');

// ── Constant-time string comparison ───────────────────────────────────────────

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // consume equal time
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── Token hashing ─────────────────────────────────────────────────────────────
// Raw refresh tokens are NEVER stored. Every store operation hashes the token
// with SHA-256 first so that a Redis/memory dump cannot be used to forge
// sessions. The client always receives and presents the raw token; the store
// only ever sees (and persists) the hash.
//
// Security note: SHA-256 is appropriate here because the tokens are 40-byte
// (320-bit) cryptographically random values. There is no need for a password
// KDF (bcrypt/argon2) — the entropy of the raw token already makes brute-force
// infeasible. SHA-256 keeps store operations O(1) without a timing risk.

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ── Token & session store ─────────────────────────────────────────────────────
// Redis keys:
//   refresh:token:<sha256(token)>    → JSON metadata ({ familyId, sessionId, userId, role, ... })
//   refresh:revoked:<familyId>       → '1' (TTL: refresh token max TTL)
//   session:<sid>                    → JSON session record
//   sessions:user:<uid>              → Redis set of active sessionIds
//
// Reuse detection strategy:
//   On every successful rotation the old hash is deleted and the family is
//   atomically recorded as the "active family" for audit. When an unknown
//   hash arrives we check whether the FAMILY itself has been revoked — if not,
//   it means the token pre-dates the family's last rotation, which is a
//   replay. We immediately revoke the family regardless of how old the token
//   is (no 300-second window). This closes the gap where a delayed replay
//   (> 5 min after rotation) escaped family revocation.

function makeRedisStore(client) {
  return {
    // Store token metadata keyed by SHA-256(raw token).
    async setToken(token, ttlSeconds, meta) {
      await client.set(`refresh:token:${hashToken(token)}`, JSON.stringify(meta), 'EX', ttlSeconds);
    },
    async getToken(token) {
      const raw = await client.get(`refresh:token:${hashToken(token)}`);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    async delToken(token) {
      await client.del(`refresh:token:${hashToken(token)}`);
    },
    async consumeToken(token, familyId, ttlSeconds) {
      if (ttlSeconds <= 0) return null;
      const tokenKey = `refresh:token:${hashToken(token)}`;
      const consumedKey = `refresh:consumed:${hashToken(token)}`;
      const script = [
        "local token = redis.call('GET', KEYS[1])",
        'if not token then return nil end',
        "redis.call('DEL', KEYS[1])",
        "redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])",
        'return token',
      ].join('\n');
      const raw = await client.eval(script, 2, tokenKey, consumedKey, familyId, String(ttlSeconds));
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    // Family-level consumed tracking: record which familyId issued the most
    // recent token. This lets us detect any replay regardless of time elapsed.
    async markConsumed(token, familyId, ttlSeconds) {
      // Also record the hash → familyId mapping for a short window so that
      // concurrent requests with the old token can be detected and surfaced
      // with a clear REPLAY code rather than the generic INVALID_REFRESH_TOKEN.
      // The primary guard is the family-level check in getTokenFamily; this is
      // a belt-and-suspenders trace.
      if (ttlSeconds && ttlSeconds > 0) {
        await client.set(`refresh:consumed:${hashToken(token)}`, familyId, 'EX', ttlSeconds);
      }
    },
    async getConsumedFamily(token) {
      return client.get(`refresh:consumed:${hashToken(token)}`);
    },
    // Store the familyId → generation counter mapping so we can detect
    // whether an unknown token belongs to an active family.
    async setTokenFamily(familyId, generation, ttlSeconds, expiresAt, userId = null) {
      const RefreshTokenFamily = require('../models/refreshTokenFamilyModel');
      const familyExpiry = expiresAt || new Date(Date.now() + ttlSeconds * 1000);
      await RefreshTokenFamily.updateOne(
        { familyId },
        { $set: { generation, expiresAt: familyExpiry, userId } },
        { upsert: true }
      );
      await client.set(`refresh:family:${familyId}`, String(generation), 'EX', ttlSeconds);
    },
    async getTokenFamily(familyId) {
      const RefreshTokenFamily = require('../models/refreshTokenFamilyModel');
      const family = await RefreshTokenFamily.findOne({ familyId, expiresAt: { $gt: new Date() }, revokedAt: null })
        .select('generation')
        .lean();
      return family?.generation ?? null;
    },
    async delTokenFamily(familyId) {
      await client.del(`refresh:family:${familyId}`);
    },
    async revokeFamily(familyId, ttlSeconds) {
      const RefreshTokenFamily = require('../models/refreshTokenFamilyModel');
      const family = await RefreshTokenFamily.findOneAndUpdate(
        { familyId },
        { $set: { revokedAt: new Date() }, $setOnInsert: { generation: 1, expiresAt: new Date(Date.now() + ttlSeconds * 1000) } },
        { upsert: true, new: true }
      ).select('expiresAt').lean();
      const remainingTtl = Math.max(1, Math.ceil((family.expiresAt.getTime() - Date.now()) / 1000));
      await client.set(`refresh:revoked:${familyId}`, '1', 'EX', remainingTtl);
      await client.del(`refresh:family:${familyId}`);
    },
    async isFamilyRevoked(familyId) {
      if ((await client.exists(`refresh:revoked:${familyId}`)) === 1) return true;
      const RefreshTokenFamily = require('../models/refreshTokenFamilyModel');
      const revoked = await RefreshTokenFamily.exists({ familyId, revokedAt: { $ne: null }, expiresAt: { $gt: new Date() } });
      return Boolean(revoked);
    },
    async setSession(sessionId, data, ttlSeconds) {
      await client.set(`session:${sessionId}`, JSON.stringify(data), 'EX', ttlSeconds);
      if (data.userId) {
        await client.sadd(`sessions:user:${data.userId}`, sessionId);
        await client.expire(`sessions:user:${data.userId}`, ttlSeconds);
      }
    },
    async getSession(sessionId) {
      const raw = await client.get(`session:${sessionId}`);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    async delSession(sessionId) {
      const raw = await client.get(`session:${sessionId}`);
      if (raw) {
        try {
          const data = JSON.parse(raw);
          if (data.userId) await client.srem(`sessions:user:${data.userId}`, sessionId);
        } catch {}
      }
      await client.del(`session:${sessionId}`);
    },
    async listUserSessions(userId) {
      const ids = await client.smembers(`sessions:user:${userId}`);
      const result = [];
      for (const id of ids) {
        const sess = await this.getSession(id);
        if (sess) result.push({ sessionId: id, ...sess });
        else await client.srem(`sessions:user:${userId}`, id);
      }
      return result;
    },
    // Revoke all session families for a given userId. Used by admin endpoints
    // and by handleChangePassword.
    async revokeUserSessions(userId, ttlSeconds) {
      const sessions = await this.listUserSessions(userId);
      await Promise.all(sessions.map(async ({ sessionId, familyId }) => {
        if (familyId) await this.revokeFamily(familyId, ttlSeconds).catch(() => {});
        await this.delSession(sessionId).catch(() => {});
      }));
      return sessions.length;
    },
  };
}

function makeMemoryStore() {
  const tokens = new Map();
  const consumed = new Map();
  const revoked = new Map();
  const families = new Map();
  const sessions = new Map();
  const userSessions = new Map();

  function alive(entry) { return entry && Date.now() < entry.exp; }

  return {
    async setToken(token, ttlSeconds, meta) {
      tokens.set(hashToken(token), { meta, exp: Date.now() + ttlSeconds * 1000 });
    },
    async getToken(token) {
      const e = tokens.get(hashToken(token));
      if (!alive(e)) { tokens.delete(hashToken(token)); return null; }
      return e.meta;
    },
    async delToken(token) { tokens.delete(hashToken(token)); },
    async consumeToken(token, familyId, ttlSeconds) {
      const tokenHash = hashToken(token);
      const entry = tokens.get(tokenHash);
      if (!alive(entry) || ttlSeconds <= 0) {
        tokens.delete(tokenHash);
        return null;
      }
      tokens.delete(tokenHash);
      consumed.set(tokenHash, { familyId, exp: Date.now() + ttlSeconds * 1000 });
      return entry.meta;
    },
    async markConsumed(token, familyId, ttlSeconds = 300) {
      if (ttlSeconds && ttlSeconds > 0) {
        consumed.set(hashToken(token), { familyId, exp: Date.now() + ttlSeconds * 1000 });
      }
    },
    async getConsumedFamily(token) {
      const e = consumed.get(hashToken(token));
      if (!alive(e)) { consumed.delete(hashToken(token)); return null; }
      return e.familyId;
    },
    async setTokenFamily(familyId, generation, ttlSeconds, expiresAt) {
      families.set(familyId, { generation, exp: expiresAt ? new Date(expiresAt).getTime() : Date.now() + ttlSeconds * 1000 });
    },
    async getTokenFamily(familyId) {
      const e = families.get(familyId);
      if (!alive(e)) { families.delete(familyId); return null; }
      return e.generation;
    },
    async delTokenFamily(familyId) { families.delete(familyId); },
    async revokeFamily(familyId, ttlSeconds) {
      revoked.set(familyId, Date.now() + ttlSeconds * 1000);
      families.delete(familyId);
    },
    async isFamilyRevoked(familyId) {
      const exp = revoked.get(familyId);
      if (!exp) return false;
      if (Date.now() > exp) { revoked.delete(familyId); return false; }
      return true;
    },
    async setSession(sessionId, data, ttlSeconds) {
      sessions.set(sessionId, { data, exp: Date.now() + ttlSeconds * 1000 });
      if (data.userId) {
        if (!userSessions.has(data.userId)) userSessions.set(data.userId, new Set());
        userSessions.get(data.userId).add(sessionId);
      }
    },
    async getSession(sessionId) {
      const e = sessions.get(sessionId);
      if (!alive(e)) { sessions.delete(sessionId); return null; }
      return e.data;
    },
    async delSession(sessionId) {
      const e = sessions.get(sessionId);
      if (e?.data?.userId) userSessions.get(e.data.userId)?.delete(sessionId);
      sessions.delete(sessionId);
    },
    async listUserSessions(userId) {
      const ids = userSessions.get(userId) || new Set();
      const result = [];
      for (const id of [...ids]) {
        const sess = await this.getSession(id);
        if (sess) result.push({ sessionId: id, ...sess });
        else ids.delete(id);
      }
      return result;
    },
    async revokeUserSessions(userId, ttlSeconds) {
      const sessions = await this.listUserSessions(userId);
      await Promise.all(sessions.map(async ({ sessionId, familyId }) => {
        if (familyId) await this.revokeFamily(familyId, ttlSeconds).catch(() => {});
        await this.delSession(sessionId).catch(() => {});
      }));
      return sessions.length;
    },
  };
}

let _store;

function getStore() {
  if (_store) return _store;

  if (process.env.REDIS_HOST) {
    const client = getRedisClient();
    if (client && client.status === 'ready') {
      _store = makeRedisStore(client);
      return _store;
    }
    logger.warn('[AuthController] Redis unavailable — falling back to in-memory token store');
  }

  _store = makeMemoryStore();
  return _store;
}

function _resetStore() { _store = null; }

// ── Per-account login lockout ─────────────────────────────────────────────────

const LOGIN_FAIL_WINDOW = 900;
const LOGIN_FAIL_THRESHOLD = 5;
const LOGIN_LOCK_TTL = 900;

function loginLockKey(id) { return `loginLock:${id}`; }
function loginFailKey(id) { return `loginFail:${id}`; }

function isLockedOut(loginId) {
  return Boolean(get(loginLockKey(loginId)));
}

async function recordLoginFailure(loginId) {
  const fk = loginFailKey(loginId);
  const lk = loginLockKey(loginId);

  const prevCount = get(fk) || 0;
  const newCount = prevCount + 1;
  set(fk, newCount, LOGIN_FAIL_WINDOW);

  const redis = getRedisClient();
  if (redis && isRedisReady()) {
    try {
      const count = await redis.incr(fk);
      if (count === 1) await redis.expire(fk, LOGIN_FAIL_WINDOW);
      if (count >= LOGIN_FAIL_THRESHOLD) {
        await redis.set(lk, '1', 'EX', LOGIN_LOCK_TTL);
        set(lk, true, LOGIN_LOCK_TTL);
        await sendAdminAlert(`Login lockout triggered for "${loginId}"`, { loginId, failCount: count });
      }
    } catch (e) {
      logger.warn('[AuthController] Redis error tracking login failure', { error: e.message });
    }
  } else if (newCount >= LOGIN_FAIL_THRESHOLD) {
    set(lk, true, LOGIN_LOCK_TTL);
    await sendAdminAlert(`Login lockout triggered for "${loginId}"`, { loginId, failCount: newCount });
  }
}

function clearLoginFailures(loginId) {
  const fk = loginFailKey(loginId);
  const lk = loginLockKey(loginId);
  del(fk, lk);
  const redis = getRedisClient();
  if (redis && isRedisReady()) {
    redis.del(fk, lk).catch(() => logger.debug('[AuthController] clearLoginFailures redis del missed'));
  }
}

// ── Cookies ───────────────────────────────────────────────────────────────────

const ACCESS_COOKIE = 'admin_token';
const REFRESH_COOKIE = 'admin_refresh_token';
const REFRESH_COOKIE_PATH = '/api/auth';

function accessCookieOptions(ttlSeconds) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: ttlSeconds * 1000,
    path: '/',
  };
}

function refreshCookieOptions(ttlSeconds) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: ttlSeconds * 1000,
    path: REFRESH_COOKIE_PATH,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseTTL(envVar, defaultSeconds) {
  const val = process.env[envVar];
  if (!val) return defaultSeconds;
  const match = val.match(/^(\d+)([smhd]?)$/);
  if (!match) return defaultSeconds;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400, '': 1 };
  return n * (multipliers[unit] ?? 1);
}

function extractDeviceInfo(req) {
  return {
    userAgent: req.headers?.['user-agent'] || null,
    ip: req.ip || req.connection?.remoteAddress || null,
  };
}

// Persist a refresh token and create a session record. Returns the generated
// refreshToken string. Throws on store write failure (#820).
async function issueRefreshToken(store, jwtPayload, refreshTTL, req) {
  const familyId  = crypto.randomBytes(16).toString('hex');
  const sessionId = crypto.randomBytes(16).toString('hex');
  const refreshToken = crypto.randomBytes(40).toString('hex');
  const familyExpiresAt = new Date(Date.now() + refreshTTL * 1000);
  const tokenMeta = {
    familyId,
    sessionId,
    ...jwtPayload,
    familyExpiresAt: familyExpiresAt.toISOString(),
  };

  // Store the hash of the token, never the raw value (#820 hash-storage).
  await store.setToken(refreshToken, refreshTTL, tokenMeta);

  await store.setTokenFamily(familyId, 1, refreshTTL, familyExpiresAt, jwtPayload.userId || null);

  store.setSession(sessionId, {
    userId:     jwtPayload.userId   || null,
    role:       jwtPayload.role     || null,
    roles:      jwtPayload.roles    || [],
    schoolId:   jwtPayload.schoolId || null,
    familyId,
    familyExpiresAt: familyExpiresAt.toISOString(),
    deviceInfo: extractDeviceInfo(req),
    createdAt:  new Date().toISOString(),
    lastUsed:   new Date().toISOString(),
  }, refreshTTL).catch(err =>
    logger.warn('[AuthController] Failed to persist session record', { error: err.message })
  );

  return refreshToken;
}

// ── Login handler ─────────────────────────────────────────────────────────────

async function handleLogin(req, res) {
  const { username, email, password, mfaCode } = req.body || {};
  const loginId = ((email || username) || '').trim().toLowerCase();

  if (isLockedOut(loginId)) {
    return res.status(429).json({
      error: 'Too many failed login attempts. Account temporarily locked.',
      code: 'ACCOUNT_LOCKED',
    });
  }

  // ── ENV super-admin path ───────────────────────────────────────────────────
  if (!email) {
    const envUsername     = process.env.ADMIN_USERNAME;
    const envPasswordHash = process.env.ADMIN_PASSWORD_HASH;
    const envPassword     = process.env.ADMIN_PASSWORD;

    if (!envUsername || (!envPassword && !envPasswordHash)) {
      return res.status(500).json({
        error: 'Server misconfiguration: ADMIN_USERNAME or ADMIN_PASSWORD is not set.',
        code: 'AUTH_MISCONFIGURED',
      });
    }

    const usernameMatch = loginId ? safeEqual(loginId, envUsername) : false;
    let credValid = false;

    if (envPasswordHash) {
      credValid = usernameMatch && Boolean(password) && await bcrypt.compare(password, envPasswordHash);
    } else {
      credValid = usernameMatch && Boolean(password) && safeEqual(password, envPassword);
    }

    if (!credValid) {
      recordLoginFailure(loginId).catch(() => logger.debug('[AuthController] recordLoginFailure missed (invalid credentials)'));
      return res.status(401).json({ error: 'Invalid credentials.', code: 'INVALID_CREDENTIALS' });
    }

    clearLoginFailures(loginId);

    const jwt = require('jsonwebtoken');
    const secret    = process.env.JWT_SECRET;
    const accessTTL = parseTTL('JWT_ACCESS_TOKEN_TTL', 8 * 3600);
    const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);

    const jwtPayload = { role: 'admin', username: loginId, userId: 'super_admin', roles: ['super_admin'] };
    const token = jwt.sign(jwtPayload, secret, { expiresIn: accessTTL });

    const store = getStore();
    let refreshToken;
    try {
      refreshToken = await issueRefreshToken(store, jwtPayload, refreshTTL, req);
    } catch (err) {
      logger.error('[AuthController] Failed to persist refresh token during login', { error: err.message });
      return res.status(500).json({ error: 'Authentication service unavailable.', code: 'TOKEN_STORE_ERROR' });
    }

    // Deliver tokens via httpOnly cookies only — no tokens in response body (#821)
    res.cookie(ACCESS_COOKIE, token, accessCookieOptions(accessTTL));
    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(refreshTTL));

    return res.json({ isAdmin: true, expiresIn: accessTTL, refreshExpiresIn: refreshTTL });
  }

  // ── DB user path ───────────────────────────────────────────────────────────
  let user;
  try {
    const User = require('../models/userModel');
    user = await User.findOne({ email: loginId, isActive: true });
  } catch (err) {
    logger.error('[AuthController] DB lookup failed during login', { error: err.message });
    return res.status(503).json({ error: 'Authentication service unavailable.', code: 'AUTH_DB_ERROR' });
  }

  if (!user) {
    await bcrypt.compare(password || '', '$2a$10$dummyhashtopreventtimingattacks000000000000000000000000');
    recordLoginFailure(loginId).catch(() => logger.debug('[AuthController] recordLoginFailure missed (no user)'));
    return res.status(401).json({ error: 'Invalid credentials.', code: 'INVALID_CREDENTIALS' });
  }

  const credValid = Boolean(password) && await bcrypt.compare(password, user.passwordHash);
  if (!credValid) {
    recordLoginFailure(loginId).catch(() => logger.debug('[AuthController] recordLoginFailure missed (invalid credentials)'));
    return res.status(401).json({ error: 'Invalid credentials.', code: 'INVALID_CREDENTIALS' });
  }

  // ── MFA check ──────────────────────────────────────────────────────────────
  let mfaSchool = null;
  {
    const { verifyTotpCode, verifyBackupCode } = require('./mfaController');

    if (user.mfaEnabled && user.mfaSecret) {
      if (!mfaCode) {
        return res.status(200).json({ requiresMfa: true });
      }
      const totpValid = verifyTotpCode(user.mfaSecret, mfaCode);
      if (!totpValid) {
        const bcIdx = verifyBackupCode(user.mfaBackupCodes || [], mfaCode);
        if (bcIdx === -1) {
          recordLoginFailure(loginId).catch(() => logger.debug('[AuthController] recordLoginFailure missed (invalid MFA)'));
          return res.status(401).json({ error: 'Invalid MFA code.', code: 'INVALID_MFA_CODE' });
        }
        const User = require('../models/userModel');
        User.findByIdAndUpdate(user._id, { $set: { [`mfaBackupCodes.${bcIdx}.used`]: true } }).catch(() => logger.debug('[AuthController] mark user backup code used missed'));
      }
    } else if (user.schoolId) {
      const School = require('../models/schoolModel');
      let school;
      try {
        school = await School.findOne({ schoolId: user.schoolId, isActive: true });
      } catch {
        school = null;
      }
      mfaSchool = school;

      if (school?.mfaEnabled && school.mfaSecret) {
        if (!mfaCode) {
          return res.status(200).json({ requiresMfa: true });
        }
        const totpValid = verifyTotpCode(school.mfaSecret, mfaCode);
        if (!totpValid) {
          const bcIdx = verifyBackupCode(school.mfaBackupCodes, mfaCode);
          if (bcIdx === -1) {
            recordLoginFailure(loginId).catch(() => logger.debug('[AuthController] recordLoginFailure missed (invalid MFA school)'));
            return res.status(401).json({ error: 'Invalid MFA code.', code: 'INVALID_MFA_CODE' });
          }
          school.mfaBackupCodes[bcIdx].used = true;
          School.findOneAndUpdate(
            { schoolId: user.schoolId },
            { $set: { [`mfaBackupCodes.${bcIdx}.used`]: true } }
          ).catch(() => logger.debug('[AuthController] mark school backup code used missed'));
        }
      }
    }
  }

  clearLoginFailures(loginId);

  const jwt = require('jsonwebtoken');
  const secret    = process.env.JWT_SECRET;
  const accessTTL  = parseTTL('JWT_ACCESS_TOKEN_TTL', 8 * 3600);
  const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);

  // #1356 — When REQUIRE_MFA is enabled, an admin with no MFA configured (on
  // their own account or their school's) gets a restricted token: the auth
  // middleware only lets it reach the MFA setup endpoints until MFA is
  // enabled, closing the gap where a compromised password alone grants full
  // access. See requireSchoolAuth's mfaSetupPending check in middleware/auth.js.
  const mfaAlreadyEnabled = Boolean(
    (user.mfaEnabled && user.mfaSecret) || (mfaSchool?.mfaEnabled && mfaSchool.mfaSecret)
  );
  const mfaSetupPending = process.env.REQUIRE_MFA === 'true' && !mfaAlreadyEnabled;

  const jwtPayload = {
    role:     'user',
    userId:   user._id.toString(),
    schoolId: user.schoolId,
    roles:    user.roles,
    ...(mfaSetupPending ? { mfaSetupPending: true } : {}),
  };
  const token = jwt.sign(jwtPayload, secret, { expiresIn: accessTTL });

  const store = getStore();
  let refreshToken;
  try {
    refreshToken = await issueRefreshToken(store, jwtPayload, refreshTTL, req);
  } catch (err) {
    logger.error('[AuthController] Failed to persist refresh token during login', { error: err.message });
    return res.status(500).json({ error: 'Authentication service unavailable.', code: 'TOKEN_STORE_ERROR' });
  }

  // Deliver tokens via httpOnly cookies only — no tokens in response body (#821)
  res.cookie(ACCESS_COOKIE, token, accessCookieOptions(accessTTL));
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(refreshTTL));

  return res.json({ expiresIn: accessTTL, refreshExpiresIn: refreshTTL, mfaSetupRequired: mfaSetupPending });
}

// ── Refresh ───────────────────────────────────────────────────────────────────

async function handleRefresh(req, res) {
  const refreshToken = req.cookies?.[REFRESH_COOKIE] || (req.body && req.body.refreshToken);

  if (!refreshToken) {
    return res.status(401).json({ error: 'Refresh token required.', code: 'MISSING_REFRESH_TOKEN' });
  }

  const store = getStore();
  const meta = await store.getToken(refreshToken);

  if (!meta) {
    // ── Reuse detection (family-level, no time-window gap) ────────────────
    // The token hash was not found. Two cases:
    //   A. This is a completely unknown token (wrong value, already expired).
    //   B. This token was issued by this server but has since been rotated
    //      away. In case B the family is still alive (generation > 0).
    //
    // Strategy: first check the short-window consumed map (belt-and-suspenders
    // for concurrent requests). Then check whether the family key still
    // exists — if it does, the token is a stale/replayed prior-generation
    // token from an active family, which means theft is suspected.
    //
    // This closes the pre-existing gap where a replay arriving more than
    // 300 s after rotation was silently rejected without revoking the family.
    let familyIdToRevoke = null;

    // Belt 1: short-window consumed map (catches fast concurrent replays)
    const consumedFamilyId = await store.getConsumedFamily(refreshToken).catch(() => null);
    if (consumedFamilyId) {
      familyIdToRevoke = consumedFamilyId;
    }

    // Belt 2: if we couldn't identify the family from the consumed map,
    // we cannot determine which family this unknown token belongs to, so
    // we cannot revoke anything further — just reject.
    if (familyIdToRevoke) {
      const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);
      logger.warn('[AuthController] Refresh token reuse detected — revoking family', { familyId: familyIdToRevoke });
      await store.revokeFamily(familyIdToRevoke, refreshTTL).catch(() =>
        logger.debug('[AuthController] revokeFamily on reuse-detection missed')
      );
      res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(0));
      return res.status(401).json({ error: 'Token reuse detected. Session revoked.', code: 'TOKEN_REUSE_DETECTED' });
    }

    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(0));
    return res.status(401).json({ error: 'Invalid or expired refresh token.', code: 'INVALID_REFRESH_TOKEN' });
  }

  // Reject if the whole token family has been revoked
  if (!meta.familyId || await store.isFamilyRevoked(meta.familyId)) {
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(0));
    return res.status(401).json({ error: 'Session has been revoked.', code: 'SESSION_REVOKED' });
  }

  const jwt = require('jsonwebtoken');
  const secret     = process.env.JWT_SECRET;
  const accessTTL  = parseTTL('JWT_ACCESS_TOKEN_TTL', 8 * 3600);
  const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);
  const familyExpiry = Number.isFinite(Date.parse(meta.familyExpiresAt))
    ? new Date(meta.familyExpiresAt)
    : new Date(Date.now() + refreshTTL * 1000);
  const remainingTTL = Math.ceil((familyExpiry.getTime() - Date.now()) / 1000);
  if (remainingTTL <= 0) {
    await store.revokeFamily(meta.familyId, 1).catch(() => {});
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(0));
    return res.status(401).json({ error: 'Refresh token family has expired.', code: 'INVALID_REFRESH_TOKEN' });
  }

  const newRefreshToken = crypto.randomBytes(40).toString('hex');

  // ── Atomic rotation ───────────────────────────────────────────────────────
  // Atomically remove the old token and retain its family mapping until the
  // family's fixed expiry so delayed replays revoke the active family too.
  const consumedMeta = await store.consumeToken(refreshToken, meta.familyId, remainingTTL);
  if (!consumedMeta) {
    const consumedFamilyId = await store.getConsumedFamily(refreshToken).catch(() => null);
    if (consumedFamilyId) {
      await store.revokeFamily(consumedFamilyId, remainingTTL).catch(() => {});
      res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(0));
      return res.status(401).json({ error: 'Token reuse detected. Session revoked.', code: 'TOKEN_REUSE_DETECTED' });
    }
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(0));
    return res.status(401).json({ error: 'Invalid or expired refresh token.', code: 'INVALID_REFRESH_TOKEN' });
  }

  // Advance the family generation in persistent storage.
  const currentGen = await store.getTokenFamily(meta.familyId).catch(() => null);
  const nextGen = (currentGen ?? 1) + 1;

  try {
    await store.setToken(newRefreshToken, remainingTTL, {
      ...meta,
      familyExpiresAt: familyExpiry.toISOString(),
      issuedAt: new Date().toISOString(),
    });
    await store.setTokenFamily(meta.familyId, nextGen, remainingTTL, familyExpiry, meta.userId || null);
  } catch (err) {
    await store.delToken(newRefreshToken).catch(() => {});
    logger.error('[AuthController] Failed to persist rotated refresh token', { error: err.message });
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(0));
    return res.status(500).json({ error: 'Authentication service unavailable.', code: 'TOKEN_STORE_ERROR' });
  }

  if (await store.isFamilyRevoked(meta.familyId)) {
    await store.delToken(newRefreshToken).catch(() => {});
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(0));
    return res.status(401).json({ error: 'Token reuse detected. Session revoked.', code: 'TOKEN_REUSE_DETECTED' });
  }

  // Update session lastUsed (non-critical)
  if (meta.sessionId) {
    store.getSession(meta.sessionId)
      .then(sess => sess && store.setSession(meta.sessionId, { ...sess, lastUsed: new Date().toISOString() }, remainingTTL))
      .catch(() => logger.debug('[AuthController] session lastUsed update missed'));
  }

  // Reconstruct JWT payload from stored metadata
  const jwtPayload = {};
  if (meta.role)     jwtPayload.role     = meta.role;
  if (meta.userId)   jwtPayload.userId   = meta.userId;
  if (meta.roles)    jwtPayload.roles    = meta.roles;
  if (meta.schoolId) jwtPayload.schoolId = meta.schoolId;
  if (meta.username) jwtPayload.username = meta.username;
  if (meta.mfaSetupPending) jwtPayload.mfaSetupPending = meta.mfaSetupPending;

  const accessToken = jwt.sign(jwtPayload, secret, { expiresIn: accessTTL });

  // Deliver via cookies only — no tokens in response body (#821)
  res.cookie(ACCESS_COOKIE, accessToken, accessCookieOptions(accessTTL));
  res.cookie(REFRESH_COOKIE, newRefreshToken, refreshCookieOptions(remainingTTL));

  return res.json({ expiresIn: accessTTL, refreshExpiresIn: remainingTTL });
}

// ── Logout ────────────────────────────────────────────────────────────────────

async function handleLogout(req, res) {
  const refreshToken = req.cookies?.[REFRESH_COOKIE] || (req.body && req.body.refreshToken);

  if (refreshToken) {
    const store = getStore();
    const meta = await store.getToken(refreshToken).catch(() => null);
    if (meta?.familyId) {
      // Revoke the whole family so any rotated copies are also invalidated
      const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);
      await store.revokeFamily(meta.familyId, refreshTTL).catch(() => logger.debug('[AuthController] revokeFamily on logout missed'));
      if (meta.sessionId) await store.delSession(meta.sessionId).catch(() => logger.debug('[AuthController] delSession on logout missed'));
    }
    await store.delToken(refreshToken).catch(() => logger.debug('[AuthController] delToken on logout missed'));
  }

  const cookieBase = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' };
  res.clearCookie(ACCESS_COOKIE, { ...cookieBase, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase, path: REFRESH_COOKIE_PATH });
  return res.json({ message: 'Logged out.' });
}

// ── Me ────────────────────────────────────────────────────────────────────────

async function handleMe(req, res) {
  const p = req.admin;
  let timezone = 'UTC';
  if (p.schoolId) {
    try {
      const school = await School.findOne({ schoolId: p.schoolId }).select('timezone').lean();
      timezone = school?.timezone || 'UTC';
    } catch (err) {
      logger.warn('[AuthController] Failed to resolve school timezone', { error: err.message });
    }
  }
  return res.json({
    userId:   p.userId   || p.sub || null,
    schoolId: p.schoolId || null,
    timezone,
    roles:    Array.isArray(p.roles) ? p.roles : (p.role ? [p.role] : []),
    features,
    exp:      p.exp      || null,
  });
}

// ── Session management (admin) ────────────────────────────────────────────────

async function handleListSessions(req, res) {
  const userId = req.admin?.userId || 'super_admin';
  try {
    const sessions = await getStore().listUserSessions(userId);
    return res.json({ sessions });
  } catch (err) {
    logger.error('[AuthController] Failed to list sessions', { error: err.message });
    return res.status(500).json({ error: 'Failed to list sessions.', code: 'SESSION_LIST_ERROR' });
  }
}

async function handleRevokeSession(req, res) {
  const { sessionId } = req.params;
  const store = getStore();
  const sess = await store.getSession(sessionId).catch(() => null);
  if (!sess) {
    return res.status(404).json({ error: 'Session not found.', code: 'SESSION_NOT_FOUND' });
  }
  if (sess.familyId) {
    const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);
    await store.revokeFamily(sess.familyId, refreshTTL).catch(() => logger.debug('[AuthController] revokeFamily in handleRevokeSession missed'));
  }
  await store.delSession(sessionId).catch(() => logger.debug('[AuthController] delSession in handleRevokeSession missed'));

  // Audit: session revocation is a privileged security mutation
  try {
    const { logAudit } = require('../services/auditService');
    const performedBy = req.admin?.email || req.admin?.userId || 'unknown';
    await logAudit({
      schoolId:    req.admin?.schoolId || 'system',
      action:      'session_revoked',
      performedBy,
      targetId:    sessionId,
      targetType:  'session',
      details:     { revokedUserId: sess.userId || null },
      result:      'success',
      ipAddress:   req.ip || null,
      userAgent:   req.get('user-agent') || null,
      severity:    'high',
    });
  } catch (auditErr) {
    logger.warn('[AuthController] Failed to write session_revoked audit entry', { error: auditErr.message });
  }

  return res.json({ message: 'Session revoked.' });
}

/**
 * DELETE /api/auth/sessions/user/:userId
 *
 * Revoke ALL active sessions (and their refresh token families) for the given
 * userId. Requires admin auth. Intended for:
 *  - Account takeover response (operator revokes a compromised user's sessions)
 *  - Forced password reset flows where all tokens must be invalidated
 *
 * Security: the route guard (requireAdminAuth) ensures only authenticated
 * admins can call this. The userId in the path is untrusted input and is
 * used only for store lookups — no PII is logged.
 */
async function handleRevokeUserSessions(req, res) {
  const { userId } = req.params;
  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    return res.status(400).json({ error: 'userId is required.', code: 'VALIDATION_ERROR' });
  }
  const store = getStore();
  const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);
  try {
    const count = await store.revokeUserSessions(userId.trim(), refreshTTL);
    return res.json({ message: 'User sessions revoked.', revokedCount: count });
  } catch (err) {
    logger.error('[AuthController] Failed to revoke user sessions', { error: err.message });
    return res.status(500).json({ error: 'Failed to revoke user sessions.', code: 'SESSION_REVOKE_ERROR' });
  }
}

async function handleRevokeOwnSessions(req, res) {
  const userId = req.admin?.userId || req.user?.userId || req.admin?.sub || req.user?.sub;
  if (!userId) return res.status(401).json({ error: 'Authenticated user is required.', code: 'UNAUTHORIZED' });

  try {
    const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);
    const revokedCount = await getStore().revokeUserSessions(userId, refreshTTL);
    res.clearCookie(ACCESS_COOKIE, accessCookieOptions(0));
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(0));
    return res.json({ message: 'All sessions revoked.', revokedCount });
  } catch (err) {
    logger.error('[AuthController] Failed to revoke own sessions', { error: err.message });
    return res.status(500).json({ error: 'Failed to revoke sessions.', code: 'SESSION_REVOKE_ERROR' });
  }
}

// ── Change Password ───────────────────────────────────────────────────────────
// #1360 — Invalidate ALL existing refresh tokens and sessions for the user
// when their password changes so that a stolen refresh token cannot be used
// to continue obtaining access tokens after a password reset.

async function handleChangePassword(req, res) {
  const { currentPassword, newPassword } = req.body || {};

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      error: 'currentPassword and newPassword are required.',
      code: 'VALIDATION_ERROR',
    });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({
      error: 'New password must be at least 8 characters.',
      code: 'VALIDATION_ERROR',
    });
  }

  const userId = req.admin?.userId;

  // Super-admin (env-based) path
  if (!userId || userId === 'super_admin') {
    return res.status(403).json({
      error: 'Super-admin password must be changed via environment variables.',
      code: 'FORBIDDEN',
    });
  }

  let user;
  try {
    const User = require('../models/userModel');
    user = await User.findById(userId);
  } catch (err) {
    logger.error('[AuthController] DB lookup failed during password change', { error: err.message });
    return res.status(503).json({ error: 'Service unavailable.', code: 'AUTH_DB_ERROR' });
  }

  if (!user) {
    return res.status(404).json({ error: 'User not found.', code: 'NOT_FOUND' });
  }

  const currentValid = Boolean(currentPassword) && await bcrypt.compare(currentPassword, user.passwordHash);
  if (!currentValid) {
    // Audit failed attempt without exposing the submitted password
    try {
      const { logAudit } = require('../services/auditService');
      await logAudit({
        schoolId:    req.admin?.schoolId || 'system',
        action:      'password_change',
        performedBy: userId,
        targetId:    userId,
        targetType:  'user',
        details:     {},
        result:      'failure',
        errorMessage: 'Invalid current password',
        ipAddress:   req.ip || null,
        userAgent:   req.get('user-agent') || null,
        severity:    'high',
      });
    } catch (auditErr) {
      logger.warn('[AuthController] Failed to write password_change audit entry', { error: auditErr.message });
    }
    return res.status(401).json({ error: 'Current password is incorrect.', code: 'INVALID_CREDENTIALS' });
  }

  const newHash = await bcrypt.hash(newPassword, 12);

  try {
    const User = require('../models/userModel');
    await User.findByIdAndUpdate(userId, { $set: { passwordHash: newHash } });
  } catch (err) {
    logger.error('[AuthController] Failed to update password hash', { error: err.message });
    return res.status(500).json({ error: 'Failed to update password.', code: 'DB_ERROR' });
  }

  // #1360 — Revoke ALL active sessions and their refresh token families so
  // any stolen refresh token is immediately invalidated after a password change.
  const store = getStore();
  const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);
  try {
    const count = await store.revokeUserSessions(userId, refreshTTL);
    logger.info('[AuthController] All sessions revoked after password change', { userId, count });
  } catch (err) {
    // Non-fatal: password is already updated; log and continue.
    logger.warn('[AuthController] Failed to revoke sessions after password change', { userId, error: err.message });
  }

  // Clear the caller's own cookies — they must log in again with the new password.
  const cookieBase = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' };
  res.clearCookie(ACCESS_COOKIE, { ...cookieBase, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase, path: REFRESH_COOKIE_PATH });

  // Audit: password change is a high-severity privileged mutation
  try {
    const { logAudit } = require('../services/auditService');
    await logAudit({
      schoolId:    req.admin?.schoolId || 'system',
      action:      'password_change',
      performedBy: userId,
      targetId:    userId,
      targetType:  'user',
      // Never log old or new password hash values
      details:     { sessionsRevoked: true },
      result:      'success',
      ipAddress:   req.ip || null,
      userAgent:   req.get('user-agent') || null,
      severity:    'high',
    });
  } catch (auditErr) {
    logger.warn('[AuthController] Failed to write password_change audit entry', { error: auditErr.message });
  }

  return res.json({ message: 'Password changed. All sessions have been invalidated. Please log in again.' });
}

module.exports = {
  handleLogin,
  handleRefresh,
  handleLogout,
  handleMe,
  handleListSessions,
  handleRevokeSession,
  handleRevokeUserSessions,
  handleRevokeOwnSessions,
  handleChangePassword,
  _resetStore,
  // Exported for tests only — allows verifying hash storage without touching Redis
  _hashToken: hashToken,
};
