/**
 * Tests for useSessionGuard — Issue #5
 *
 * Acceptance criteria:
 *   ✓ The user sees one clear re-authentication prompt (redirectToLogin is
 *     called by the existing axios interceptor — not re-tested here)
 *   ✓ Sensitive fields are never persisted (only SAFE_FIELDS are stored)
 *   ✓ Successful re-authentication returns the user to the interrupted
 *     payment flow (draft is restored from sessionStorage on re-mount)
 *
 * Strategy: test the exported pure helpers (pickSafeFields, writeDraft,
 * readAndClearDraft, clearDraft) directly without a React renderer.
 * The hook itself is exercised via a mock of React hooks.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Fake sessionStorage implementation.
let fakeStore = {};
const fakeSessionStorage = {
  getItem:    (k)    => fakeStore[k] ?? null,
  setItem:    (k, v) => { fakeStore[k] = String(v); },
  removeItem: (k)    => { delete fakeStore[k]; },
  clear:      ()     => { fakeStore = {}; },
};

Object.defineProperty(global, 'sessionStorage', {
  value: fakeSessionStorage,
  writable: true,
});

// Fake window event listener support.
const windowListeners = {};
Object.defineProperty(global, 'window', {
  value: {
    addEventListener:    (e, fn) => { (windowListeners[e] = windowListeners[e] || []).push(fn); },
    removeEventListener: (e, fn) => { windowListeners[e] = (windowListeners[e] || []).filter(h => h !== fn); },
    dispatchEvent:       (ev)    => { (windowListeners[ev.type] || []).forEach(h => h(ev)); },
  },
  writable: true,
});

// Track useEffect registrations so we can run cleanup manually.
const effects = [];
jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useEffect: jest.fn((fn) => { effects.push(fn); }),
    useCallback: jest.fn((fn) => fn),
  };
});

const {
  DRAFT_KEY,
  SAFE_FIELDS,
  pickSafeFields,
  writeDraft,
  readAndClearDraft,
  clearDraft,
  useSessionGuard,
} = require('../useSessionGuard');

// ── Helpers ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  fakeSessionStorage.clear();
  for (const k of Object.keys(windowListeners)) delete windowListeners[k];
  effects.length = 0;
  jest.clearAllMocks();
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('DRAFT_KEY is a non-empty string', () => {
    expect(typeof DRAFT_KEY).toBe('string');
    expect(DRAFT_KEY.length).toBeGreaterThan(0);
  });

  it('SAFE_FIELDS contains studentId', () => {
    expect(SAFE_FIELDS).toContain('studentId');
  });

  it('SAFE_FIELDS does NOT contain sensitive fields', () => {
    const sensitive = [
      'walletAddress', 'memo', 'txHash', 'amount',
      'parentEmail', 'parentPhone', 'password', 'token',
      'schoolId', 'userId', 'privateKey', 'secretKey',
    ];
    for (const field of sensitive) {
      expect(SAFE_FIELDS).not.toContain(field);
    }
  });
});

// ── pickSafeFields ────────────────────────────────────────────────────────────

describe('pickSafeFields', () => {
  it('returns only safe fields from a form state', () => {
    const result = pickSafeFields({
      studentId: 'STU001',
      walletAddress: 'GXXX',
      memo: 'secret',
      amount: 250,
    });
    expect(result).toEqual({ studentId: 'STU001' });
  });

  it('returns null when no safe fields have a value', () => {
    expect(pickSafeFields({ walletAddress: 'GXXX' })).toBeNull();
  });

  it('returns null for null input', () => {
    expect(pickSafeFields(null)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(pickSafeFields('string')).toBeNull();
  });

  it('ignores empty-string safe fields', () => {
    expect(pickSafeFields({ studentId: '' })).toBeNull();
  });

  it('ignores null safe fields', () => {
    expect(pickSafeFields({ studentId: null })).toBeNull();
  });

  it('includes a safe field when it has a non-empty value', () => {
    const result = pickSafeFields({ studentId: 'ABC', memo: 'secret' });
    expect(result).not.toBeNull();
    expect(result.studentId).toBe('ABC');
    expect(result.memo).toBeUndefined();
  });
});

// ── writeDraft ────────────────────────────────────────────────────────────────

describe('writeDraft', () => {
  it('writes only safe fields to sessionStorage', () => {
    writeDraft({ studentId: 'STU001', walletAddress: 'GXXX', memo: 'secret' });
    const stored = JSON.parse(fakeSessionStorage.getItem(DRAFT_KEY));
    expect(stored).toEqual({ studentId: 'STU001' });
    expect(stored.walletAddress).toBeUndefined();
    expect(stored.memo).toBeUndefined();
  });

  it('returns true when a draft was successfully written', () => {
    expect(writeDraft({ studentId: 'STU001' })).toBe(true);
  });

  it('returns false when there are no safe fields to persist', () => {
    expect(writeDraft({ walletAddress: 'GXXX' })).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(writeDraft({})).toBe(false);
  });

  it('does not write anything to sessionStorage when there are no safe fields', () => {
    writeDraft({ memo: 'secret' });
    expect(fakeSessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });
});

// ── readAndClearDraft ─────────────────────────────────────────────────────────

describe('readAndClearDraft', () => {
  it('returns the stored draft', () => {
    fakeSessionStorage.setItem(DRAFT_KEY, JSON.stringify({ studentId: 'STU002' }));
    const draft = readAndClearDraft();
    expect(draft).toEqual({ studentId: 'STU002' });
  });

  it('removes the draft from sessionStorage after reading', () => {
    fakeSessionStorage.setItem(DRAFT_KEY, JSON.stringify({ studentId: 'STU003' }));
    readAndClearDraft();
    expect(fakeSessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('returns null when no draft exists', () => {
    expect(readAndClearDraft()).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    fakeSessionStorage.setItem(DRAFT_KEY, '{not valid json}');
    expect(readAndClearDraft()).toBeNull();
  });

  it('re-validates against safe fields after parsing (tamper guard)', () => {
    // Simulate someone manually injecting a sensitive field into sessionStorage.
    fakeSessionStorage.setItem(DRAFT_KEY, JSON.stringify({
      studentId: 'STU001',
      walletAddress: 'GHACKED',
    }));
    const draft = readAndClearDraft();
    expect(draft?.walletAddress).toBeUndefined();
    expect(draft?.studentId).toBe('STU001');
  });
});

// ── clearDraft ────────────────────────────────────────────────────────────────

describe('clearDraft', () => {
  it('removes the draft from sessionStorage', () => {
    fakeSessionStorage.setItem(DRAFT_KEY, JSON.stringify({ studentId: 'X' }));
    clearDraft();
    expect(fakeSessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('does not throw when no draft exists', () => {
    expect(() => clearDraft()).not.toThrow();
  });
});

// ── useSessionGuard hook ──────────────────────────────────────────────────────

describe('useSessionGuard', () => {
  it('exports useSessionGuard as a function', () => {
    expect(typeof useSessionGuard).toBe('function');
  });

  it('returns saveDraft, restoreDraft, clearDraft', () => {
    const result = useSessionGuard();
    expect(typeof result.saveDraft).toBe('function');
    expect(typeof result.restoreDraft).toBe('function');
    expect(typeof result.clearDraft).toBe('function');
  });

  it('saveDraft persists safe fields', () => {
    const { saveDraft } = useSessionGuard();
    saveDraft({ studentId: 'STU010', walletAddress: 'GXXX' });
    const stored = JSON.parse(fakeSessionStorage.getItem(DRAFT_KEY));
    expect(stored).toEqual({ studentId: 'STU010' });
  });

  it('restoreDraft reads and clears the stored draft', () => {
    fakeSessionStorage.setItem(DRAFT_KEY, JSON.stringify({ studentId: 'STU011' }));
    const { restoreDraft } = useSessionGuard();
    const draft = restoreDraft();
    expect(draft).toEqual({ studentId: 'STU011' });
    expect(fakeSessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('registers a session:expired event listener via useEffect', () => {
    const onSessionExpired = jest.fn();
    useSessionGuard({ onSessionExpired });
    // Run the registered effect.
    effects.forEach(fn => fn());
    // Simulate the session:expired event fired by api.js.
    window.dispatchEvent({ type: 'session:expired' });
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('does not call onSessionExpired before the event fires', () => {
    const onSessionExpired = jest.fn();
    useSessionGuard({ onSessionExpired });
    effects.forEach(fn => fn());
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('sensitive fields never enter sessionStorage via saveDraft', () => {
    const { saveDraft } = useSessionGuard();
    saveDraft({
      studentId: 'STU012',
      walletAddress: 'G_SECRET',
      memo: 'STU012',
      txHash: 'abc123',
      amount: 500,
      parentEmail: 'parent@example.com',
    });
    const stored = JSON.parse(fakeSessionStorage.getItem(DRAFT_KEY));
    expect(Object.keys(stored)).toEqual(['studentId']);
  });
});
