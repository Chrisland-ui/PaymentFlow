/**
 * useSessionGuard — Issue #5
 *
 * Centralised session-expiry handler that:
 *   1. Detects a session expiry event (401 that survives the token-refresh
 *      cycle, i.e. the refresh itself failed and redirectToLogin was called).
 *   2. Preserves non-sensitive payment form state in sessionStorage before
 *      redirecting to /login.
 *   3. After successful re-authentication, restores the safe fields and
 *      returns the user to the interrupted page.
 *
 * Security contract
 * ─────────────────
 * Only safe, non-sensitive fields are ever persisted:
 *   SAFE   → studentId (a school-internal identifier with no PII on its own)
 *   NEVER  → walletAddress, memo, txHash, amount, parentEmail, parentPhone,
 *             any auth tokens, schoolId, userId
 *
 * The safe fields list is explicit and allowlisted (not a blocklist) to
 * prevent accidental future exposure of new sensitive fields.
 *
 * Storage choice: sessionStorage (not localStorage) so the draft is
 * automatically cleared when the browser tab is closed.  The tab that
 * initiated the login redirect reads back the draft on the same origin.
 *
 * Integration
 * ───────────
 * 1. In PaymentForm (or any form that should survive re-auth):
 *
 *     const { saveDraft, clearDraft, restoreDraft } = useSessionGuard();
 *
 *     // Before navigating away on 401:
 *     saveDraft({ studentId });
 *
 *     // On mount, after successful re-auth:
 *     const draft = restoreDraft();
 *     if (draft?.studentId) setStudentId(draft.studentId);
 *
 * 2. The axios interceptor (api.js / authRefresh.js) already calls
 *    redirectToLogin() on refresh failure.  That function is patched in
 *    api.js to call window.dispatchEvent(new Event('session:expired'))
 *    before redirecting.  This hook listens for that event.
 *
 * Note: the hook itself does NOT call redirectToLogin() — that is already
 * handled by the axios interceptor.  The hook only manages the draft state
 * so the form can survive the redirect.
 */

import { useCallback, useEffect } from 'react';

// ── Constants ─────────────────────────────────────────────────────────────────

/** sessionStorage key for the payment form draft. */
export const DRAFT_KEY = 'paymentFormDraft';

/**
 * Allowlist of field names that are safe to persist.
 * Sensitive fields (walletAddress, memo, amount, txHash, parentEmail, etc.)
 * must NEVER appear here.
 */
export const SAFE_FIELDS = ['studentId'];

// ── Pure helpers (exported so they can be unit-tested without React) ───────────

/**
 * Pick only the allowlisted safe fields from a form state object.
 * Returns null if no safe fields are present.
 *
 * @param {object} formState
 * @returns {object|null}
 */
export function pickSafeFields(formState) {
  if (!formState || typeof formState !== 'object') return null;
  const safe = {};
  let hasAny = false;
  for (const field of SAFE_FIELDS) {
    if (formState[field] !== undefined && formState[field] !== null && formState[field] !== '') {
      safe[field] = formState[field];
      hasAny = true;
    }
  }
  return hasAny ? safe : null;
}

/**
 * Write a sanitised draft to sessionStorage.
 * Silently no-ops if sessionStorage is unavailable (private browsing, SSR).
 *
 * @param {object} formState
 * @returns {boolean} true if the draft was written
 */
export function writeDraft(formState) {
  const safe = pickSafeFields(formState);
  if (!safe) return false;
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(safe));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and immediately remove the draft from sessionStorage.
 * Returns null if no draft exists or on parse error.
 *
 * @returns {object|null}
 */
export function readAndClearDraft() {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(DRAFT_KEY);
    const parsed = JSON.parse(raw);
    // Re-validate against the allowlist after parsing to guard against
    // storage tampering.
    return pickSafeFields(parsed);
  } catch {
    return null;
  }
}

/**
 * Remove any stored draft without reading it.
 */
export function clearDraft() {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // sessionStorage unavailable — nothing to clear.
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * @param {object}   [opts]
 * @param {Function} [opts.onSessionExpired]  Called when the session expires
 *   (before redirect).  Receives no arguments.  Use this to call saveDraft()
 *   with the current form state.
 */
export function useSessionGuard({ onSessionExpired } = {}) {
  useEffect(() => {
    function handleExpiry() {
      onSessionExpired?.();
    }
    window.addEventListener('session:expired', handleExpiry);
    return () => window.removeEventListener('session:expired', handleExpiry);
  }, [onSessionExpired]);

  /**
   * Persist the safe subset of formState to sessionStorage for restoration
   * after re-authentication.
   */
  const saveDraft = useCallback((formState) => {
    writeDraft(formState);
  }, []);

  /**
   * Restore a previously saved draft and remove it from storage.
   * Returns null if no draft is available.
   */
  const restoreDraft = useCallback(() => {
    return readAndClearDraft();
  }, []);

  return { saveDraft, restoreDraft, clearDraft };
}
