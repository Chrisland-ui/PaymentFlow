'use strict';

/**
 * Tests for Issue #54: Add contract interface and versioning policy.
 *
 * Acceptance Criteria:
 *   1. A client can discover supported interfaces.
 *   2. Incompatible upgrades are rejected clearly.
 *   3. Version policy is included in integration docs (docs/contract-interface-versioning.md).
 */

const {
  CONTRACT_VERSION,
  COMPATIBILITY_POLICY,
  DEPRECATION_TIMELINE_DAYS,
  INTERFACE_IDS,
  UnknownInterfaceError,
  registerInterface,
  discoverInterfaces,
  validateInterfaceId,
  getInterface,
  isCompatibleUpgrade,
  getDeprecationDeadline,
  getInterfaceIds,
} = require('../backend/src/services/contractInterfaceRegistry');

// ---------------------------------------------------------------------------
// Contract version
// ---------------------------------------------------------------------------
describe('Contract versioning constants', () => {
  test('CONTRACT_VERSION is a valid semantic version string', () => {
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('COMPATIBILITY_POLICY defines MAJOR, MINOR, PATCH', () => {
    expect(COMPATIBILITY_POLICY.MAJOR).toBe('breaking');
    expect(COMPATIBILITY_POLICY.MINOR).toBe('additive');
    expect(COMPATIBILITY_POLICY.PATCH).toBe('bugfix');
  });

  test('DEPRECATION_TIMELINE_DAYS is 90', () => {
    expect(DEPRECATION_TIMELINE_DAYS).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// Client discovery
// ---------------------------------------------------------------------------
describe('discoverInterfaces — client discovery', () => {
  let interfaces;

  beforeAll(() => {
    interfaces = discoverInterfaces();
  });

  test('returns a non-empty array', () => {
    expect(Array.isArray(interfaces)).toBe(true);
    expect(interfaces.length).toBeGreaterThan(0);
  });

  test('each interface has interfaceId, entryPoint, and version fields', () => {
    for (const iface of interfaces) {
      expect(typeof iface.interfaceId).toBe('string');
      expect(typeof iface.entryPoint).toBe('string');
      expect(typeof iface.version).toBe('string');
    }
  });

  test('all INTERFACE_IDS are present in the discovered set', () => {
    const discoveredIds = new Set(interfaces.map(i => i.interfaceId));
    for (const id of Object.values(INTERFACE_IDS)) {
      expect(discoveredIds.has(id)).toBe(true);
    }
  });

  test('deposit interface is discoverable', () => {
    const deposit = interfaces.find(i => i.interfaceId === INTERFACE_IDS.DEPOSIT);
    expect(deposit).toBeDefined();
    expect(deposit.entryPoint).toBe('deposit');
  });

  test('release interface is discoverable', () => {
    const release = interfaces.find(i => i.interfaceId === INTERFACE_IDS.RELEASE);
    expect(release).toBeDefined();
    expect(release.entryPoint).toBe('release');
  });

  test('pause interface is discoverable', () => {
    const pause = interfaces.find(i => i.interfaceId === INTERFACE_IDS.PAUSE);
    expect(pause).toBeDefined();
    expect(pause.entryPoint).toBe('pause');
  });
});

// ---------------------------------------------------------------------------
// All PRIVILEGED_ENTRY_POINTS have corresponding interface IDs
// ---------------------------------------------------------------------------
describe('INTERFACE_IDS coverage', () => {
  const expectedEntryPoints = [
    'version',
    'initialize', 'deposit', 'release', 'refund', 'dispute',
    'resolveDispute', 'pause', 'unpause', 'updateConfig', 'rotateSigner',
  ];

  test('all expected entry points have a registered interface', () => {
    const interfaces = discoverInterfaces();
    const registeredEntryPoints = new Set(interfaces.map(i => i.entryPoint));
    for (const ep of expectedEntryPoints) {
      expect(registeredEntryPoints.has(ep)).toBe(true);
    }
  });

  test('INTERFACE_IDS object has one key per expected entry point', () => {
    expect(Object.keys(INTERFACE_IDS).length).toBe(expectedEntryPoints.length);
  });
});

// ---------------------------------------------------------------------------
// validateInterfaceId
// ---------------------------------------------------------------------------
describe('validateInterfaceId', () => {
  test('returns true for a known interface ID', () => {
    expect(validateInterfaceId(INTERFACE_IDS.DEPOSIT)).toBe(true);
  });

  test('throws UnknownInterfaceError for an unknown ID', () => {
    expect(() => validateInterfaceId('IFACE_NONEXISTENT_V99'))
      .toThrow(UnknownInterfaceError);
  });

  test('throws UnknownInterfaceError with the ID in the message', () => {
    let caught;
    try {
      validateInterfaceId('IFACE_NONEXISTENT_V99');
    } catch (e) {
      caught = e;
    }
    expect(caught.message).toMatch(/IFACE_NONEXISTENT_V99/);
    expect(caught.interfaceId).toBe('IFACE_NONEXISTENT_V99');
  });

  test('throws for empty string', () => {
    expect(() => validateInterfaceId('')).toThrow(UnknownInterfaceError);
  });
});

// ---------------------------------------------------------------------------
// getInterface
// ---------------------------------------------------------------------------
describe('getInterface', () => {
  test('returns the spec for a known interface', () => {
    const spec = getInterface(INTERFACE_IDS.RELEASE);
    expect(spec.entryPoint).toBe('release');
    expect(spec.interfaceId).toBe(INTERFACE_IDS.RELEASE);
  });

  test('throws UnknownInterfaceError for unknown ID', () => {
    expect(() => getInterface('IFACE_INVALID')).toThrow(UnknownInterfaceError);
  });
});

// ---------------------------------------------------------------------------
// isCompatibleUpgrade
// ---------------------------------------------------------------------------
describe('isCompatibleUpgrade — compatibility rules', () => {
  test('same version is compatible', () => {
    const result = isCompatibleUpgrade('1.0.0', '1.0.0');
    expect(result.compatible).toBe(true);
  });

  test('patch increment is compatible', () => {
    const result = isCompatibleUpgrade('1.0.0', '1.0.1');
    expect(result.compatible).toBe(true);
    expect(result.policy).toBe(COMPATIBILITY_POLICY.PATCH);
  });

  test('minor increment is compatible', () => {
    const result = isCompatibleUpgrade('1.0.0', '1.1.0');
    expect(result.compatible).toBe(true);
    expect(result.policy).toBe(COMPATIBILITY_POLICY.MINOR);
  });

  test('major increment is NOT compatible', () => {
    const result = isCompatibleUpgrade('1.0.0', '2.0.0');
    expect(result.compatible).toBe(false);
    expect(result.policy).toBe(COMPATIBILITY_POLICY.MAJOR);
  });

  test('major version mismatch reason mentions "Major version mismatch"', () => {
    const result = isCompatibleUpgrade('1.5.3', '2.0.0');
    expect(result.compatible).toBe(false);
    expect(result.reason).toMatch(/Major version mismatch/);
  });

  test('downgrade is not compatible', () => {
    const result = isCompatibleUpgrade('1.1.0', '1.0.0');
    expect(result.compatible).toBe(false);
  });

  test('invalid version format returns incompatible', () => {
    const result = isCompatibleUpgrade('not-a-version', '1.0.0');
    expect(result.compatible).toBe(false);
  });

  test('missing toVersion returns incompatible', () => {
    const result = isCompatibleUpgrade('1.0.0', null);
    expect(result.compatible).toBe(false);
  });

  test('minor increment 1.0.0 → 1.3.0 is compatible', () => {
    const result = isCompatibleUpgrade('1.0.0', '1.3.0');
    expect(result.compatible).toBe(true);
  });

  test('cross-major 0.x → 1.0 is breaking', () => {
    const result = isCompatibleUpgrade('0.9.9', '1.0.0');
    expect(result.compatible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getDeprecationDeadline
// ---------------------------------------------------------------------------
describe('getDeprecationDeadline', () => {
  test('deadline is exactly 90 days after the deprecation date', () => {
    const deprecatedAt = new Date('2026-01-01T00:00:00.000Z');
    const deadline = getDeprecationDeadline(deprecatedAt);
    const expectedDeadline = new Date('2026-04-01T00:00:00.000Z'); // Jan 1 + 90 days
    expect(deadline.getTime()).toBe(expectedDeadline.getTime());
  });

  test('accepts ISO string as input', () => {
    const deadline = getDeprecationDeadline('2026-06-01T00:00:00.000Z');
    expect(deadline instanceof Date).toBe(true);
  });

  test('custom timeline overrides the default 90 days', () => {
    const deprecatedAt = new Date('2026-01-01T00:00:00.000Z');
    const deadline = getDeprecationDeadline(deprecatedAt, 30);
    const expected = new Date('2026-01-31T00:00:00.000Z');
    expect(deadline.getTime()).toBe(expected.getTime());
  });

  test('throws TypeError for invalid date', () => {
    expect(() => getDeprecationDeadline('not-a-date')).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// registerInterface (custom registration)
// ---------------------------------------------------------------------------
describe('registerInterface', () => {
  test('a newly registered interface is discoverable', () => {
    registerInterface('IFACE_CUSTOM_TEST_V1', {
      entryPoint: 'customTest',
      version: '1.0.0',
      description: 'Custom test interface',
    });
    const found = discoverInterfaces().find(i => i.interfaceId === 'IFACE_CUSTOM_TEST_V1');
    expect(found).toBeDefined();
    expect(found.entryPoint).toBe('customTest');
  });

  test('throws TypeError when interfaceId is missing', () => {
    expect(() => registerInterface('', {})).toThrow(TypeError);
  });

  test('throws TypeError when spec is null', () => {
    expect(() => registerInterface('IFACE_NULL_SPEC', null)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// getInterfaceIds helper
// ---------------------------------------------------------------------------
describe('getInterfaceIds', () => {
  test('returns the INTERFACE_IDS object', () => {
    const ids = getInterfaceIds();
    expect(ids.DEPOSIT).toBe(INTERFACE_IDS.DEPOSIT);
    expect(ids.RELEASE).toBe(INTERFACE_IDS.RELEASE);
  });
});
