'use strict';

/**
 * Tests for Issue #302: Contract interface versioning and upgrade policy.
 *
 * Covers:
 *   - contractVersionAdapter: N / N-1 compatibility adapter
 *   - version() view function concept (getContractVersion)
 *   - assertVersionSupported rejects out-of-range versions
 *   - Call builders select correct parameter set per major version
 *   - UnsupportedContractVersionError thrown for unsupported versions
 */

const {
  CURRENT_MAJOR,
  MIN_SUPPORTED_MAJOR,
  SUPPORTED_VERSIONS,
  UnsupportedContractVersionError,
  ContractVersionQueryError,
  assertVersionSupported,
  getSupportedRange,
  buildDepositArgs,
  buildReleaseArgs,
  buildRefundArgs,
  getBuildersForVersion,
  parseMajor,
} = require('../backend/src/services/contractVersionAdapter');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('contractVersionAdapter — constants', () => {
  test('CURRENT_MAJOR is a positive integer', () => {
    expect(Number.isInteger(CURRENT_MAJOR)).toBe(true);
    expect(CURRENT_MAJOR).toBeGreaterThan(0);
  });

  test('MIN_SUPPORTED_MAJOR is CURRENT_MAJOR - 1 or 1 (whichever is larger)', () => {
    expect(MIN_SUPPORTED_MAJOR).toBe(Math.max(1, CURRENT_MAJOR - 1));
  });

  test('SUPPORTED_VERSIONS contains at least one entry', () => {
    expect(typeof SUPPORTED_VERSIONS).toBe('object');
    expect(Object.keys(SUPPORTED_VERSIONS).length).toBeGreaterThan(0);
  });

  test('SUPPORTED_VERSIONS keys are string integers', () => {
    for (const key of Object.keys(SUPPORTED_VERSIONS)) {
      expect(Number.isInteger(Number(key))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// parseMajor
// ---------------------------------------------------------------------------

describe('parseMajor', () => {
  test.each([
    ['1.0.0', 1],
    ['2.3.4', 2],
    ['10.0.1', 10],
  ])('parses %s → %d', (input, expected) => {
    expect(parseMajor(input)).toBe(expected);
  });

  test.each(['invalid', '1.0', '', 'v1.0.0', '1.0.0.0'])(
    'throws for invalid version "%s"',
    (bad) => {
      expect(() => parseMajor(bad)).toThrow();
    }
  );
});

// ---------------------------------------------------------------------------
// getSupportedRange
// ---------------------------------------------------------------------------

describe('getSupportedRange', () => {
  test('returns a non-empty string', () => {
    const range = getSupportedRange();
    expect(typeof range).toBe('string');
    expect(range.length).toBeGreaterThan(0);
  });

  test('includes the expected version pattern', () => {
    const range = getSupportedRange();
    expect(range).toMatch(/v\d+\.x\.x/);
  });
});

// ---------------------------------------------------------------------------
// assertVersionSupported
// ---------------------------------------------------------------------------

describe('assertVersionSupported', () => {
  test('accepts a version within the supported range (v1)', () => {
    const result = assertVersionSupported('1.0.0');
    expect(result).toEqual({ supported: true, version: '1.0.0' });
  });

  test('accepts a version within the supported range (v1 with minor bump)', () => {
    const result = assertVersionSupported('1.2.3');
    expect(result.supported).toBe(true);
  });

  test('accepts v2 if v2 is in SUPPORTED_VERSIONS', () => {
    if (SUPPORTED_VERSIONS['2']) {
      const result = assertVersionSupported('2.0.0');
      expect(result.supported).toBe(true);
    }
  });

  test('throws UnsupportedContractVersionError for a very old version', () => {
    expect(() => assertVersionSupported('0.1.0')).toThrow(UnsupportedContractVersionError);
  });

  test('throws UnsupportedContractVersionError for a future unsupported version', () => {
    // v999 will not be in SUPPORTED_VERSIONS
    expect(() => assertVersionSupported('999.0.0')).toThrow(UnsupportedContractVersionError);
  });

  test('error message references the on-chain version and supported range', () => {
    try {
      assertVersionSupported('999.0.0');
    } catch (err) {
      expect(err.onChainVersion).toBe('999.0.0');
      expect(err.supportedRange).toBeTruthy();
      expect(err.message).toContain('999.0.0');
    }
  });
});

// ---------------------------------------------------------------------------
// UnsupportedContractVersionError
// ---------------------------------------------------------------------------

describe('UnsupportedContractVersionError', () => {
  test('is an instance of Error', () => {
    const err = new UnsupportedContractVersionError('0.1.0', 'v1.x.x – v2.x.x');
    expect(err).toBeInstanceOf(Error);
  });

  test('has correct name', () => {
    const err = new UnsupportedContractVersionError('0.1.0', 'v1.x.x – v2.x.x');
    expect(err.name).toBe('UnsupportedContractVersionError');
  });

  test('exposes onChainVersion and supportedRange', () => {
    const err = new UnsupportedContractVersionError('0.1.0', 'v1.x.x – v2.x.x');
    expect(err.onChainVersion).toBe('0.1.0');
    expect(err.supportedRange).toBe('v1.x.x – v2.x.x');
  });
});

// ---------------------------------------------------------------------------
// ContractVersionQueryError
// ---------------------------------------------------------------------------

describe('ContractVersionQueryError', () => {
  test('is an instance of Error', () => {
    const cause = new Error('RPC timeout');
    const err = new ContractVersionQueryError('CTEST123', cause);
    expect(err).toBeInstanceOf(Error);
  });

  test('has correct name', () => {
    const cause = new Error('RPC timeout');
    const err = new ContractVersionQueryError('CTEST123', cause);
    expect(err.name).toBe('ContractVersionQueryError');
  });

  test('exposes contractId and cause', () => {
    const cause = new Error('network unreachable');
    const err = new ContractVersionQueryError('CTEST123', cause);
    expect(err.contractId).toBe('CTEST123');
    expect(err.cause).toBe(cause);
  });

  test('message includes contractId and cause message', () => {
    const cause = new Error('RPC timeout');
    const err = new ContractVersionQueryError('CTEST123', cause);
    expect(err.message).toContain('CTEST123');
    expect(err.message).toContain('RPC timeout');
  });
});

// ---------------------------------------------------------------------------
// getBuildersForVersion
// ---------------------------------------------------------------------------

describe('getBuildersForVersion', () => {
  test('returns builders for v1', () => {
    const builders = getBuildersForVersion('1.0.0');
    expect(typeof builders.buildDepositArgs).toBe('function');
    expect(typeof builders.buildReleaseArgs).toBe('function');
    expect(typeof builders.buildRefundArgs).toBe('function');
  });

  test('returns builders for v1 with patch bump', () => {
    const builders = getBuildersForVersion('1.2.3');
    expect(builders).toBeDefined();
  });

  test('throws UnsupportedContractVersionError for v999', () => {
    expect(() => getBuildersForVersion('999.0.0')).toThrow(UnsupportedContractVersionError);
  });
});

// ---------------------------------------------------------------------------
// buildDepositArgs
// ---------------------------------------------------------------------------

describe('buildDepositArgs', () => {
  const baseParams = {
    payer: 'GPAYER123',
    beneficiary: 'GSCHOOL456',
    arbiter: 'GARBITER789',
    amount: '5000000000',
    asset: { code: 'XLM', type: 'native' },
    memo: 'STU-2024-001',
    timeoutLedger: 1234567,
  };

  test('returns an object with fnName, version, and args for v1', () => {
    const result = buildDepositArgs('1.0.0', baseParams);
    expect(result.fnName).toBe('deposit');
    expect(result.version).toBe('1');
    expect(result.args).toBeDefined();
  });

  test('v1 args include all expected fields', () => {
    const result = buildDepositArgs('1.0.0', baseParams);
    expect(result.args.payer).toBe(baseParams.payer);
    expect(result.args.beneficiary).toBe(baseParams.beneficiary);
    expect(result.args.memo).toBe(baseParams.memo);
    expect(result.args.amount).toBe(baseParams.amount);
    expect(result.args.timeoutLedger).toBe(baseParams.timeoutLedger);
  });

  test('v2 args include schoolId if v2 is supported', () => {
    if (!SUPPORTED_VERSIONS['2']) return;
    const v2Params = { ...baseParams, schoolId: 'SCH-001' };
    const result = buildDepositArgs('2.0.0', v2Params);
    expect(result.version).toBe('2');
    expect(result.args.schoolId).toBe('SCH-001');
  });

  test('throws UnsupportedContractVersionError for unsupported version', () => {
    expect(() => buildDepositArgs('999.0.0', baseParams)).toThrow(
      UnsupportedContractVersionError
    );
  });
});

// ---------------------------------------------------------------------------
// buildReleaseArgs
// ---------------------------------------------------------------------------

describe('buildReleaseArgs', () => {
  const params = { escrowId: 'escrow-abc-123', caller: 'GSCHOOL456' };

  test('returns correct shape for v1', () => {
    const result = buildReleaseArgs('1.0.0', params);
    expect(result.fnName).toBe('release');
    expect(result.version).toBe('1');
    expect(result.args.escrowId).toBe(params.escrowId);
    expect(result.args.caller).toBe(params.caller);
  });

  test('throws for unsupported version', () => {
    expect(() => buildReleaseArgs('999.0.0', params)).toThrow(UnsupportedContractVersionError);
  });
});

// ---------------------------------------------------------------------------
// buildRefundArgs
// ---------------------------------------------------------------------------

describe('buildRefundArgs', () => {
  const params = {
    escrowId: 'escrow-abc-123',
    caller: 'GARBITER789',
    reason: 'Duplicate payment',
  };

  test('returns correct shape for v1', () => {
    const result = buildRefundArgs('1.0.0', params);
    expect(result.fnName).toBe('refund');
    expect(result.version).toBe('1');
    expect(result.args.escrowId).toBe(params.escrowId);
    expect(result.args.caller).toBe(params.caller);
    expect(result.args.reason).toBe(params.reason);
  });

  test('throws for unsupported version', () => {
    expect(() => buildRefundArgs('999.0.0', params)).toThrow(UnsupportedContractVersionError);
  });
});

// ---------------------------------------------------------------------------
// N / N-1 compatibility — same method, different version, different args
// ---------------------------------------------------------------------------

describe('N / N-1 compatibility adapter', () => {
  test('v1 deposit does not include schoolId', () => {
    const params = {
      payer: 'GPAYER',
      beneficiary: 'GSCHOOL',
      arbiter: 'GARB',
      schoolId: 'SCH-001', // provided but should be ignored by v1
      amount: '100',
      asset: { type: 'native' },
      memo: 'STU001',
      timeoutLedger: 100,
    };
    const result = buildDepositArgs('1.0.0', params);
    // v1 does not include schoolId in args
    expect(result.version).toBe('1');
    expect(result.args).not.toHaveProperty('schoolId');
  });

  test('v2 deposit includes schoolId', () => {
    if (!SUPPORTED_VERSIONS['2']) return; // skip if v2 not yet defined
    const params = {
      payer: 'GPAYER',
      beneficiary: 'GSCHOOL',
      arbiter: 'GARB',
      schoolId: 'SCH-001',
      amount: '100',
      asset: { type: 'native' },
      memo: 'STU001',
      timeoutLedger: 100,
    };
    const result = buildDepositArgs('2.0.0', params);
    expect(result.version).toBe('2');
    expect(result.args.schoolId).toBe('SCH-001');
  });

  test('both v1 and v2 are in SUPPORTED_VERSIONS (N and N-1 window)', () => {
    expect(SUPPORTED_VERSIONS['1']).toBeDefined();
    expect(SUPPORTED_VERSIONS['2']).toBeDefined();
  });

  test('at least two major versions are always supported simultaneously', () => {
    const numSupported = Object.keys(SUPPORTED_VERSIONS).length;
    expect(numSupported).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// contractInterfaceRegistry — version() view function registration
// ---------------------------------------------------------------------------

describe('contractInterfaceRegistry — version() view function', () => {
  const {
    INTERFACE_IDS,
    discoverInterfaces,
    validateInterfaceId,
    getInterface,
  } = require('../backend/src/services/contractInterfaceRegistry');

  test('INTERFACE_IDS includes VERSION', () => {
    expect(INTERFACE_IDS.VERSION).toBeDefined();
    expect(INTERFACE_IDS.VERSION).toMatch(/^IFACE_VERSION/);
  });

  test('version() interface is registered and discoverable', () => {
    const interfaces = discoverInterfaces();
    const versionIface = interfaces.find((i) => i.entryPoint === 'version');
    expect(versionIface).toBeDefined();
    expect(versionIface.interfaceId).toBe(INTERFACE_IDS.VERSION);
  });

  test('version() interface has null input (no arguments)', () => {
    const iface = getInterface(INTERFACE_IDS.VERSION);
    expect(iface.input).toBeNull();
  });

  test('version() interface output is { version: "string" }', () => {
    const iface = getInterface(INTERFACE_IDS.VERSION);
    expect(iface.output).toEqual({ version: 'string' });
  });

  test('version() interface is not deprecated', () => {
    const iface = getInterface(INTERFACE_IDS.VERSION);
    expect(iface.deprecated).toBe(false);
  });

  test('validateInterfaceId accepts IFACE_VERSION_V1', () => {
    expect(() => validateInterfaceId(INTERFACE_IDS.VERSION)).not.toThrow();
  });
});
