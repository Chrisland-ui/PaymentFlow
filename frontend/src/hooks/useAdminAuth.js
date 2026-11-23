import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';

// Maximum number of /auth/me retry attempts after the initial failure.
const AUTH_ME_MAX_RETRIES = 3;
// Base delay in ms for exponential backoff (1 s, 2 s, 4 s).
const AUTH_ME_RETRY_BASE_MS = 1000;

/**
 * Fetch /auth/me with automatic exponential-backoff retry.
 *
 * Resolves with the parsed JSON on success, or rejects after all attempts
 * have been exhausted.  A 401/403 response is treated as a permanent auth
 * failure and is not retried (retrying would be pointless without fresh
 * credentials).
 *
 * @param {number} [maxRetries]
 * @returns {Promise<object>}
 */
async function fetchAuthMe(maxRetries = AUTH_ME_MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 1 s, 2 s, 4 s, …
      await new Promise((resolve) =>
        setTimeout(resolve, AUTH_ME_RETRY_BASE_MS * Math.pow(2, attempt - 1))
      );
    }
    try {
      const r = await fetch(`${API_URL}/auth/me`, { credentials: 'include' });
      if (r.ok) return r.json();
      // 401 / 403 → not authenticated; no point retrying.
      if (r.status === 401 || r.status === 403) {
        throw Object.assign(new Error('Not authenticated'), { permanent: true });
      }
      // 5xx or other transient errors — record and retry.
      lastError = new Error(`/auth/me responded with ${r.status}`);
    } catch (err) {
      if (err.permanent) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

export function useAdminAuth() {
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState(false);
  const [schoolId, setSchoolId] = useState(null);
  const [timeZone, setTimeZone] = useState('UTC');
  const [userId, setUserId] = useState(null);
  const [features, setFeatures] = useState({});
  const [checked, setChecked] = useState(false);
  // #1218 — surfaces a recoverable auth-me failure so consuming pages can
  // render a "Retry" affordance instead of silently breaking.
  const [authMeError, setAuthMeError] = useState(false);
  // #253 — expose the JWT expiry timestamp so components can schedule a
  // session-expiry warning toast before the token expires.
  const [tokenExp, setTokenExp] = useState(null);

  // Tracks whether the component is still mounted so async callbacks don't
  // update state after unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /**
   * Apply a successful /auth/me response to state and localStorage.
   */
  const applyAuthData = useCallback((data) => {
    if (!mountedRef.current) return;
    setIsAdmin(true);
    setSchoolId(data.schoolId || null);
    setTimeZone(data.timezone || 'UTC');
    setUserId(data.userId || null);
    setFeatures(data.features && typeof data.features === 'object' ? data.features : {});
    setAuthMeError(false);
    // #253 — store the JWT expiry claim so components can schedule a
    // session-expiry warning toast before the access token expires.
    setTokenExp(typeof data.exp === 'number' ? data.exp : null);
    if (typeof window !== 'undefined') {
      if (data.schoolId) localStorage.setItem('schoolId', data.schoolId);
      if (data.userId)   localStorage.setItem('userId',   data.userId);
    }
  }, []);

  // Fetch user context from /auth/me on mount — includes schoolId from authenticated session.
  // The HttpOnly cookie is sent automatically by the browser; we never touch it from JS.
  useEffect(() => {
    fetchAuthMe()
      .then((data) => {
        applyAuthData(data);
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setIsAdmin(false);
        setSchoolId(null);
        setTimeZone('UTC');
        setUserId(null);
        setFeatures({});
      })
      .finally(() => {
        if (mountedRef.current) setChecked(true);
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const login = useCallback(() => {
    // Called after a successful POST /auth/login — the cookie is already set.
    // Fetch user context with retry so a transient network blip right after
    // login doesn't permanently strand the admin with schoolId: null.
    setAuthMeError(false);
    fetchAuthMe()
      .then((data) => {
        applyAuthData(data);
      })
      .catch(() => {
        if (!mountedRef.current) return;
        // Mark admin as logged in (the login POST succeeded) but signal that
        // /auth/me context could not be loaded so the UI can offer a retry.
        setIsAdmin(true);
        setSchoolId(null);
        setTimeZone('UTC');
        setUserId(null);
        setFeatures({});
        setAuthMeError(true);
      });
  }, [applyAuthData]);

  /**
   * Manual retry for /auth/me — call this from a "Retry" button in any page
   * that renders an error state when schoolId is null after login.
   */
  const retryAuth = useCallback(() => {
    setAuthMeError(false);
    fetchAuthMe()
      .then((data) => {
        applyAuthData(data);
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setAuthMeError(true);
      });
  }, [applyAuthData]);

  const logout = useCallback(async () => {
    await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => console.debug('[useAdminAuth] logout request failed'));
    setIsAdmin(false);
    setSchoolId(null);
    setTimeZone('UTC');
    setUserId(null);
    setFeatures({});
    setAuthMeError(false);
    setTokenExp(null);
    // Clear school context from storage
    if (typeof window !== 'undefined') {
      localStorage.removeItem('schoolId');
      localStorage.removeItem('userId');
    }
    router.push('/login');
  }, [router]);

  return { isAdmin, checked, login, logout, schoolId, timeZone, userId, authMeError, retryAuth };
}
