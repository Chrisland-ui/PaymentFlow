/**
 * Tests for the analytics event contract — Issue #22.
 *
 * Covers:
 *   - Unknown event names are rejected by validateEvent
 *   - Known events pass validation with correct properties
 *   - Sensitive properties are flagged by validateEvent
 *   - Unknown (non-sensitive) properties are flagged by validateEvent
 *   - track() strips sensitive fields before calling the adapter
 *   - track() is a no-op (no adapter call) for unknown event names
 *   - setAdapter wires in a custom adapter
 *   - Global sensitive fields are always stripped regardless of event spec
 */

import {
  EVENT_CATALOG,
  EVENTS,
  track,
  validateEvent,
  setAdapter,
} from '../analyticsEvents';

// ── validateEvent ────────────────────────────────────────────────────────────

describe('validateEvent — unknown event name', () => {
  it('returns invalid with a descriptive error for an unknown event key', () => {
    const result = validateEvent('THIS_EVENT_DOES_NOT_EXIST');
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/unknown event/i);
  });

  it('returns valid:true with no errors for a known event and no properties', () => {
    const result = validateEvent(EVENTS.SYNC_TRIGGERED);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe('validateEvent — allowed properties', () => {
  it('accepts all declared allowed properties', () => {
    const result = validateEvent(EVENTS.STUDENT_LOOKUP_SUCCESS, {
      className: 'Grade 5',
      paymentStatus: 'unpaid',
      studentIdPrefix: 'STU',
    });
    expect(result.valid).toBe(true);
  });

  it('reports an error for an unknown (non-sensitive) property', () => {
    const result = validateEvent(EVENTS.SYNC_TRIGGERED, {
      unknownProp: 'value',
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/unknown property/i);
    expect(result.errors[0]).toMatch(/unknownProp/);
  });
});

describe('validateEvent — sensitive properties', () => {
  it('flags txHash as sensitive for PAYMENT_VERIFY_SUBMITTED', () => {
    const result = validateEvent(EVENTS.PAYMENT_VERIFY_SUBMITTED, {
      txHash: 'abc123',
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/sensitive/i);
    expect(result.errors[0]).toMatch(/txHash/);
  });

  it('flags parentEmail as sensitive for STUDENT_LOOKUP_SUCCESS', () => {
    const result = validateEvent(EVENTS.STUDENT_LOOKUP_SUCCESS, {
      parentEmail: 'parent@example.com',
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/sensitive/i);
    expect(result.errors[0]).toMatch(/parentEmail/);
  });

  it('flags walletAddress as sensitive via the global list', () => {
    const result = validateEvent(EVENTS.SYNC_TRIGGERED, {
      walletAddress: 'GXYZ',
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/sensitive/i);
    expect(result.errors[0]).toMatch(/walletAddress/);
  });

  it('reports both sensitive and unknown property errors in one call', () => {
    const result = validateEvent(EVENTS.DISPUTE_SUBMITTED, {
      txHash: 'hash',      // sensitive
      unknownField: 'x',   // unknown
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

// ── track() ──────────────────────────────────────────────────────────────────

describe('track — adapter integration', () => {
  let calls;

  beforeEach(() => {
    calls = [];
    setAdapter((name, props) => calls.push({ name, props }));
  });

  it('calls the adapter with the canonical event name', () => {
    track(EVENTS.SYNC_TRIGGERED, { source: 'button' });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe(EVENT_CATALOG[EVENTS.SYNC_TRIGGERED].name);
  });

  it('does not call the adapter for an unknown event key', () => {
    track('NONEXISTENT_EVENT', { foo: 'bar' });
    expect(calls).toHaveLength(0);
  });

  it('strips event-specific sensitive properties before calling the adapter', () => {
    track(EVENTS.PAYMENT_VERIFY_SUBMITTED, {
      assetType: 'XLM',
      txHash: 'should-be-stripped',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].props).not.toHaveProperty('txHash');
    expect(calls[0].props).toHaveProperty('assetType', 'XLM');
  });

  it('strips global sensitive properties regardless of event spec', () => {
    track(EVENTS.SYNC_TRIGGERED, {
      source: 'menu',
      walletAddress: 'GABCDEF',   // global sensitive
      parentEmail: 'x@y.com',     // global sensitive
      secretKey: 'SXYZ',          // global sensitive
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].props).not.toHaveProperty('walletAddress');
    expect(calls[0].props).not.toHaveProperty('parentEmail');
    expect(calls[0].props).not.toHaveProperty('secretKey');
    expect(calls[0].props).toHaveProperty('source', 'menu');
  });

  it('strips studentId from STUDENT_LOOKUP_SUCCESS', () => {
    track(EVENTS.STUDENT_LOOKUP_SUCCESS, {
      className: 'Grade 1',
      paymentStatus: 'paid',
      studentId: 'STU001',      // must be stripped
      studentIdPrefix: 'STU',   // allowed
    });
    expect(calls[0].props).not.toHaveProperty('studentId');
    expect(calls[0].props).toHaveProperty('studentIdPrefix', 'STU');
  });

  it('passes an empty properties object (with schemaVersion) to the adapter when all properties are sensitive', () => {
    track(EVENTS.STUDENT_LOOKUP_SUBMITTED, {
      studentId: 'STU001',
      parentEmail: 'p@school.com',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].props).toHaveProperty('schemaVersion', '1.0.0');
    expect(calls[0].props).not.toHaveProperty('studentId');
    expect(calls[0].props).not.toHaveProperty('parentEmail');
  });

  it('includes schemaVersion in every tracked event payload (#270)', () => {
    track(EVENTS.SYNC_TRIGGERED, { source: 'dashboard' });
    expect(calls[calls.length - 1].props).toHaveProperty('schemaVersion', '1.0.0');
  });
});

// ── EVENT_CATALOG integrity ───────────────────────────────────────────────────

describe('EVENT_CATALOG — structural integrity', () => {
  it('every entry has name, allowedProperties, sensitiveProperties, and description', () => {
    for (const [key, spec] of Object.entries(EVENT_CATALOG)) {
      expect(typeof spec.name).toBe('string', `${key}.name`);
      expect(Array.isArray(spec.allowedProperties)).toBe(true, `${key}.allowedProperties`);
      expect(Array.isArray(spec.sensitiveProperties)).toBe(true, `${key}.sensitiveProperties`);
      expect(typeof spec.description).toBe('string', `${key}.description`);
    }
  });

  it('EVENTS keys match EVENT_CATALOG keys', () => {
    expect(Object.keys(EVENTS).sort()).toEqual(Object.keys(EVENT_CATALOG).sort());
  });

  it('no event declares a property as both allowed and sensitive', () => {
    for (const [key, spec] of Object.entries(EVENT_CATALOG)) {
      const overlap = spec.allowedProperties.filter((p) =>
        spec.sensitiveProperties.includes(p),
      );
      expect(overlap).toHaveLength(0, `${key} has overlap: ${overlap.join(', ')}`);
    }
  });
});
