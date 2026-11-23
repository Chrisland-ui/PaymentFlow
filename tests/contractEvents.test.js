'use strict';

/**
 * contractEvents.test.js — Test suite for the Soroban escrow contract event schema
 *
 * Covers:
 *
 *   escrowContract.js (emitter)
 *     1.  emitEscrowCreated  — happy path emits correct event shape
 *     2.  emitEscrowCreated  — rejects missing / invalid required fields
 *     3.  emitFundsReleased  — happy path emits correct event shape
 *     4.  emitFundsReleased  — rejects invalid feeValidationStatus enum
 *     5.  emitRefundIssued   — happy path emits correct event shape
 *     6.  emitRefundIssued   — rejects invalid reason code
 *     7.  emitDisputeRaised  — happy path emits correct event shape + auto-generates disputeId
 *     8.  emitDisputeRaised  — rejects negative stroop amount
 *     9.  emitDisputeResolved — happy path emits correct event shape
 *     10. emitDisputeResolved — rejects invalid outcome enum
 *     11. event topics[0] is always "escrow"
 *     12. event data always contains schemaVersion
 *
 *   contractEvents.js (types / validator)
 *     13. validateContractEvent — accepts valid EscrowCreated
 *     14. validateContractEvent — accepts valid FundsReleased
 *     15. validateContractEvent — accepts valid RefundIssued
 *     16. validateContractEvent — accepts valid DisputeRaised
 *     17. validateContractEvent — accepts valid DisputeResolved
 *     18. validateContractEvent — rejects null / non-object input
 *     19. validateContractEvent — rejects missing topics array
 *     20. validateContractEvent — rejects wrong namespace (topics[0])
 *     21. validateContractEvent — rejects unknown event type (topics[1])
 *     22. validateContractEvent — emits warning for unexpected schema version
 *     23. validateContractEvent — rejects missing required data field
 *     24. validateContractEvent — rejects invalid stroop value (float)
 *     25. validateContractEvent — rejects invalid enum value
 *     26. validateContractEvent — allows optional resolutionNote to be null/absent
 *
 *   contractEventParser.js (parser)
 *     27. parse — returns valid result with correct reconciliationAction for each type
 *     28. parse — converts stroops to decimal correctly
 *     29. parse — returns valid=false for a malformed event
 *     30. parse — attaches schemaVersion warning when version mismatches
 *     31. parseBatch — filters out invalid events, calls onInvalid callback
 *     32. parseBatch — returns all valid events in order
 *     33. stroopsToDecimal — boundary values (0, 1, 10_000_000)
 *     34. decimalToStroops — round-trip precision
 *     35. deriveReconciliationAction — maps all five event types
 */

// ── Imports ───────────────────────────────────────────────────────────────────

const {
  contractEvents,
  emitEscrowCreated,
  emitFundsReleased,
  emitRefundIssued,
  emitDisputeRaised,
  emitDisputeResolved,
  EVENT_TYPES,
  ASSETS,
  SCHEMA_VERSION,
  REFUND_REASON_CODES,
  DISPUTE_REASON_CODES,
  DISPUTE_OUTCOMES,
} = require('../backend/src/soroban/escrowContract');

const {
  validateContractEvent,
  CONTRACT_EVENT_SCHEMAS,
} = require('../backend/src/types/contractEvents');

const {
  parse,
  parseBatch,
  stroopsToDecimal,
  decimalToStroops,
  deriveReconciliationAction,
  RECONCILIATION_ACTIONS,
} = require('../backend/src/services/contractEventParser');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_ESCROW_CREATED_PARAMS = {
  paymentId:        'TX-abc123',
  schoolId:         'SCH-DEFAULT',
  studentId:        'STU-001',
  schoolAccount:    'GSCHOOL1234567890ABCDEFGH',
  depositorAccount: 'GPARENT1234567890ABCDEFGH',
  amount:           2_500_000_000,          // 250 XLM in stroops
  asset:            'XLM',
  feeCategory:      'TUITION_2026',
  expectedFeeAmount: 2_500_000_000,
  memoText:         'STU-001',
  expiresAtMs:      Date.now() + 86_400_000, // +1 day
};

const BASE_FUNDS_RELEASED_PARAMS = {
  paymentId:           'TX-abc123',
  schoolId:            'SCH-DEFAULT',
  studentId:           'STU-001',
  schoolAccount:       'GSCHOOL1234567890ABCDEFGH',
  depositorAccount:    'GPARENT1234567890ABCDEFGH',
  releasedAmount:      2_500_000_000,
  excessAmount:        0,
  asset:               'XLM',
  feeValidationStatus: 'valid',
  releasedBy:          'GADMIN1234567890ABCDEFGH',
};

const BASE_REFUND_ISSUED_PARAMS = {
  paymentId:        'TX-abc123',
  refundTxHash:     'TX-refund456',
  schoolId:         'SCH-DEFAULT',
  studentId:        'STU-001',
  depositorAccount: 'GPARENT1234567890ABCDEFGH',
  schoolAccount:    'GSCHOOL1234567890ABCDEFGH',
  refundAmount:     2_500_000_000,
  asset:            'XLM',
  reason:           'dispute_resolved',
  initiatedBy:      'GADMIN1234567890ABCDEFGH',
};

const BASE_DISPUTE_RAISED_PARAMS = {
  paymentId:        'TX-abc123',
  disputeId:        'DISP-xyz789',
  schoolId:         'SCH-DEFAULT',
  studentId:        'STU-001',
  raisedBy:         'GPARENT1234567890ABCDEFGH',
  schoolAccount:    'GSCHOOL1234567890ABCDEFGH',
  depositorAccount: 'GPARENT1234567890ABCDEFGH',
  disputedAmount:   2_500_000_000,
  asset:            'XLM',
  reasonCode:       'wrong_amount',
  slaDeadlineMs:    Date.now() + 72 * 3_600_000, // +72 hours
};

const BASE_DISPUTE_RESOLVED_PARAMS = {
  paymentId:        'TX-abc123',
  disputeId:        'DISP-xyz789',
  schoolId:         'SCH-DEFAULT',
  studentId:        'STU-001',
  resolvedBy:       'GADMIN1234567890ABCDEFGH',
  schoolAccount:    'GSCHOOL1234567890ABCDEFGH',
  depositorAccount: 'GPARENT1234567890ABCDEFGH',
  outcome:          'refunded_to_depositor',
  schoolAmount:     0,
  depositorAmount:  2_500_000_000,
  asset:            'XLM',
};

/** Capture the next 'contract.event' emission from the bus */
function captureNextEvent() {
  return new Promise((resolve) => {
    contractEvents.once('contract.event', resolve);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1: escrowContract.js — emitter behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('escrowContract — EscrowCreated', () => {
  test('happy path: emits event with correct topics and data shape', async () => {
    const capture = captureNextEvent();
    await emitEscrowCreated(BASE_ESCROW_CREATED_PARAMS);
    const event = await capture;

    expect(event.topics[0]).toBe('escrow');
    expect(event.topics[1]).toBe(EVENT_TYPES.ESCROW_CREATED);
    expect(event.topics[2]).toBe(BASE_ESCROW_CREATED_PARAMS.paymentId);
    expect(event.topics[3]).toBe(BASE_ESCROW_CREATED_PARAMS.schoolAccount);

    expect(event.data.schemaVersion).toBe(SCHEMA_VERSION);
    expect(event.data.paymentId).toBe(BASE_ESCROW_CREATED_PARAMS.paymentId);
    expect(event.data.schoolId).toBe(BASE_ESCROW_CREATED_PARAMS.schoolId);
    expect(event.data.studentId).toBe(BASE_ESCROW_CREATED_PARAMS.studentId);
    expect(event.data.amount).toBe(BASE_ESCROW_CREATED_PARAMS.amount);
    expect(event.data.asset).toBe('XLM');
    expect(event.data.feeCategory).toBe('TUITION_2026');
    expect(event.data.memoText).toBe('STU-001');
    expect(typeof event.data.timestampMs).toBe('number');
    expect(typeof event.data.ledgerSequence).toBe('number');
  });

  test.each([
    ['missing paymentId',        { ...BASE_ESCROW_CREATED_PARAMS, paymentId: '' }],
    ['null schoolId',            { ...BASE_ESCROW_CREATED_PARAMS, schoolId: null }],
    ['float amount (not stroops)', { ...BASE_ESCROW_CREATED_PARAMS, amount: 250.5 }],
    ['negative amount',          { ...BASE_ESCROW_CREATED_PARAMS, amount: -1 }],
    ['missing studentId',        { ...BASE_ESCROW_CREATED_PARAMS, studentId: undefined }],
    ['invalid asset',            { ...BASE_ESCROW_CREATED_PARAMS, asset: 'BTC' }],
    ['zero expiresAtMs',         { ...BASE_ESCROW_CREATED_PARAMS, expiresAtMs: 0 }],
  ])('rejects: %s', async (_, params) => {
    await expect(emitEscrowCreated(params)).rejects.toThrow();
  });
});

describe('escrowContract — FundsReleased', () => {
  test('happy path: emits event with correct topics and data shape', async () => {
    const capture = captureNextEvent();
    await emitFundsReleased(BASE_FUNDS_RELEASED_PARAMS);
    const event = await capture;

    expect(event.topics[0]).toBe('escrow');
    expect(event.topics[1]).toBe(EVENT_TYPES.FUNDS_RELEASED);
    expect(event.topics[2]).toBe(BASE_FUNDS_RELEASED_PARAMS.paymentId);
    expect(event.topics[3]).toBe(BASE_FUNDS_RELEASED_PARAMS.schoolAccount);

    expect(event.data.releasedAmount).toBe(2_500_000_000);
    expect(event.data.excessAmount).toBe(0);
    expect(event.data.feeValidationStatus).toBe('valid');
    expect(event.data.releasedBy).toBe(BASE_FUNDS_RELEASED_PARAMS.releasedBy);
  });

  test('rejects invalid feeValidationStatus', async () => {
    await expect(
      emitFundsReleased({ ...BASE_FUNDS_RELEASED_PARAMS, feeValidationStatus: 'partially_paid' }),
    ).rejects.toThrow(/feeValidationStatus/);
  });

  test('defaults excessAmount to 0 when not provided', async () => {
    const { excessAmount: _, ...params } = BASE_FUNDS_RELEASED_PARAMS;
    const capture = captureNextEvent();
    await emitFundsReleased(params);
    const event = await capture;
    expect(event.data.excessAmount).toBe(0);
  });
});

describe('escrowContract — RefundIssued', () => {
  test('happy path: emits event with correct topics and data shape', async () => {
    const capture = captureNextEvent();
    await emitRefundIssued(BASE_REFUND_ISSUED_PARAMS);
    const event = await capture;

    expect(event.topics[0]).toBe('escrow');
    expect(event.topics[1]).toBe(EVENT_TYPES.REFUND_ISSUED);
    expect(event.topics[2]).toBe(BASE_REFUND_ISSUED_PARAMS.paymentId);
    expect(event.topics[3]).toBe(BASE_REFUND_ISSUED_PARAMS.depositorAccount);

    expect(event.data.refundTxHash).toBe('TX-refund456');
    expect(event.data.reason).toBe('dispute_resolved');
    expect(event.data.refundAmount).toBe(2_500_000_000);
  });

  test.each(REFUND_REASON_CODES)('accepts valid reason code: %s', async (reason) => {
    const capture = captureNextEvent();
    await expect(
      emitRefundIssued({ ...BASE_REFUND_ISSUED_PARAMS, reason }),
    ).resolves.not.toThrow();
    await capture; // drain
  });

  test('rejects invalid reason code', async () => {
    await expect(
      emitRefundIssued({ ...BASE_REFUND_ISSUED_PARAMS, reason: 'hacker_initiated' }),
    ).rejects.toThrow(/reason/);
  });
});

describe('escrowContract — DisputeRaised', () => {
  test('happy path: emits event with correct topics and data shape', async () => {
    const capture = captureNextEvent();
    await emitDisputeRaised(BASE_DISPUTE_RAISED_PARAMS);
    const event = await capture;

    expect(event.topics[0]).toBe('escrow');
    expect(event.topics[1]).toBe(EVENT_TYPES.DISPUTE_RAISED);
    expect(event.topics[2]).toBe(BASE_DISPUTE_RAISED_PARAMS.paymentId);
    expect(event.topics[3]).toBe(BASE_DISPUTE_RAISED_PARAMS.disputeId);

    expect(event.data.reasonCode).toBe('wrong_amount');
    expect(event.data.disputeId).toBe('DISP-xyz789');
    expect(event.data.slaDeadlineMs).toBeGreaterThan(Date.now());
  });

  test('auto-generates disputeId when not provided', async () => {
    const { disputeId: _, ...params } = BASE_DISPUTE_RAISED_PARAMS;
    const capture = captureNextEvent();
    await emitDisputeRaised(params);
    const event = await capture;
    expect(typeof event.data.disputeId).toBe('string');
    expect(event.data.disputeId.length).toBeGreaterThan(0);
  });

  test('rejects negative disputedAmount', async () => {
    await expect(
      emitDisputeRaised({ ...BASE_DISPUTE_RAISED_PARAMS, disputedAmount: -100 }),
    ).rejects.toThrow(/disputedAmount/);
  });

  test.each(DISPUTE_REASON_CODES)('accepts all reason codes: %s', async (reasonCode) => {
    const capture = captureNextEvent();
    await expect(
      emitDisputeRaised({ ...BASE_DISPUTE_RAISED_PARAMS, reasonCode }),
    ).resolves.not.toThrow();
    await capture;
  });
});

describe('escrowContract — DisputeResolved', () => {
  test('happy path: emits event with correct topics and data shape', async () => {
    const capture = captureNextEvent();
    await emitDisputeResolved(BASE_DISPUTE_RESOLVED_PARAMS);
    const event = await capture;

    expect(event.topics[0]).toBe('escrow');
    expect(event.topics[1]).toBe(EVENT_TYPES.DISPUTE_RESOLVED);
    expect(event.topics[2]).toBe(BASE_DISPUTE_RESOLVED_PARAMS.paymentId);
    expect(event.topics[3]).toBe(BASE_DISPUTE_RESOLVED_PARAMS.disputeId);

    expect(event.data.outcome).toBe('refunded_to_depositor');
    expect(event.data.schoolAmount).toBe(0);
    expect(event.data.depositorAmount).toBe(2_500_000_000);
    expect(event.data.resolutionNote).toBeNull();
  });

  test('accepts optional resolutionNote', async () => {
    const capture = captureNextEvent();
    await emitDisputeResolved({
      ...BASE_DISPUTE_RESOLVED_PARAMS,
      resolutionNote: 'Duplicate payment confirmed',
    });
    const event = await capture;
    expect(event.data.resolutionNote).toBe('Duplicate payment confirmed');
  });

  test('rejects invalid outcome enum', async () => {
    await expect(
      emitDisputeResolved({ ...BASE_DISPUTE_RESOLVED_PARAMS, outcome: 'school_wins' }),
    ).rejects.toThrow(/outcome/);
  });

  test.each(DISPUTE_OUTCOMES)('accepts all outcome codes: %s', async (outcome) => {
    const cap = captureNextEvent();
    await expect(
      emitDisputeResolved({
        ...BASE_DISPUTE_RESOLVED_PARAMS,
        outcome,
        schoolAmount:    outcome === 'refunded_to_depositor' ? 0 : 1_000_000_000,
        depositorAmount: outcome === 'released_to_school'    ? 0 : 2_500_000_000,
      }),
    ).resolves.not.toThrow();
    await cap;
  });
});

describe('escrowContract — invariants across all event types', () => {
  const emitters = [
    ['EscrowCreated',   () => emitEscrowCreated(BASE_ESCROW_CREATED_PARAMS)],
    ['FundsReleased',   () => emitFundsReleased(BASE_FUNDS_RELEASED_PARAMS)],
    ['RefundIssued',    () => emitRefundIssued(BASE_REFUND_ISSUED_PARAMS)],
    ['DisputeRaised',   () => emitDisputeRaised(BASE_DISPUTE_RAISED_PARAMS)],
    ['DisputeResolved', () => emitDisputeResolved(BASE_DISPUTE_RESOLVED_PARAMS)],
  ];

  test.each(emitters)('%s: topics[0] is always "escrow"', async (_, emit) => {
    const capture = captureNextEvent();
    await emit();
    const event = await capture;
    expect(event.topics[0]).toBe('escrow');
  });

  test.each(emitters)('%s: data.schemaVersion equals SCHEMA_VERSION constant', async (_, emit) => {
    const capture = captureNextEvent();
    await emit();
    const event = await capture;
    expect(event.data.schemaVersion).toBe(SCHEMA_VERSION);
  });

  test.each(emitters)('%s: data.timestampMs is a positive number', async (_, emit) => {
    const capture = captureNextEvent();
    await emit();
    const event = await capture;
    expect(typeof event.data.timestampMs).toBe('number');
    expect(event.data.timestampMs).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 2: contractEvents.js — validator
// ─────────────────────────────────────────────────────────────────────────────

/** Build a minimal valid raw event for testing the validator directly */
function makeRawEvent(eventType, overrides = {}) {
  const bases = {
    [EVENT_TYPES.ESCROW_CREATED]: {
      topics: ['escrow', EVENT_TYPES.ESCROW_CREATED, 'TX-abc', 'GSCHOOL...'],
      data: {
        schemaVersion: SCHEMA_VERSION, contractId: 'CCONTRACT', ledgerSequence: 100, timestampMs: Date.now(),
        paymentId: 'TX-abc', schoolId: 'SCH-1', studentId: 'STU-1',
        schoolAccount: 'GSCHOOL', depositorAccount: 'GPARENT',
        amount: 1_000_000, asset: 'XLM', feeCategory: 'TUI',
        expectedFeeAmount: 1_000_000, memoText: 'STU-1',
        expiresAtMs: Date.now() + 1000,
      },
    },
    [EVENT_TYPES.FUNDS_RELEASED]: {
      topics: ['escrow', EVENT_TYPES.FUNDS_RELEASED, 'TX-abc', 'GSCHOOL...'],
      data: {
        schemaVersion: SCHEMA_VERSION, contractId: 'CCONTRACT', ledgerSequence: 101, timestampMs: Date.now(),
        paymentId: 'TX-abc', schoolId: 'SCH-1', studentId: 'STU-1',
        schoolAccount: 'GSCHOOL', depositorAccount: 'GPARENT',
        releasedAmount: 1_000_000, excessAmount: 0, asset: 'XLM',
        feeValidationStatus: 'valid', releasedBy: 'GADMIN',
      },
    },
    [EVENT_TYPES.REFUND_ISSUED]: {
      topics: ['escrow', EVENT_TYPES.REFUND_ISSUED, 'TX-abc', 'GPARENT...'],
      data: {
        schemaVersion: SCHEMA_VERSION, contractId: 'CCONTRACT', ledgerSequence: 102, timestampMs: Date.now(),
        paymentId: 'TX-abc', refundTxHash: 'TX-ref', schoolId: 'SCH-1', studentId: 'STU-1',
        depositorAccount: 'GPARENT', schoolAccount: 'GSCHOOL',
        refundAmount: 1_000_000, asset: 'XLM', reason: 'overpayment', initiatedBy: 'GADMIN',
      },
    },
    [EVENT_TYPES.DISPUTE_RAISED]: {
      topics: ['escrow', EVENT_TYPES.DISPUTE_RAISED, 'TX-abc', 'DISP-1'],
      data: {
        schemaVersion: SCHEMA_VERSION, contractId: 'CCONTRACT', ledgerSequence: 103, timestampMs: Date.now(),
        paymentId: 'TX-abc', disputeId: 'DISP-1', schoolId: 'SCH-1', studentId: 'STU-1',
        raisedBy: 'GPARENT', schoolAccount: 'GSCHOOL', depositorAccount: 'GPARENT',
        disputedAmount: 1_000_000, asset: 'USDC', reasonCode: 'not_received',
        slaDeadlineMs: Date.now() + 72_000_000,
      },
    },
    [EVENT_TYPES.DISPUTE_RESOLVED]: {
      topics: ['escrow', EVENT_TYPES.DISPUTE_RESOLVED, 'TX-abc', 'DISP-1'],
      data: {
        schemaVersion: SCHEMA_VERSION, contractId: 'CCONTRACT', ledgerSequence: 104, timestampMs: Date.now(),
        paymentId: 'TX-abc', disputeId: 'DISP-1', schoolId: 'SCH-1', studentId: 'STU-1',
        resolvedBy: 'GADMIN', schoolAccount: 'GSCHOOL', depositorAccount: 'GPARENT',
        outcome: 'released_to_school', schoolAmount: 1_000_000, depositorAmount: 0,
        asset: 'XLM',
      },
    },
  };

  const base = bases[eventType];
  return {
    topics: overrides.topics ?? base.topics,
    data:   overrides.data   ?? { ...base.data, ...overrides },
  };
}

describe('validateContractEvent — valid events', () => {
  test.each(Object.values(EVENT_TYPES))('accepts valid %s event', (eventType) => {
    const result = validateContractEvent(makeRawEvent(eventType));
    expect(result.valid).toBe(true);
    expect(result.eventType).toBe(eventType);
    expect(result.errors).toHaveLength(0);
  });
});

describe('validateContractEvent — structural failures', () => {
  test('rejects null input', () => {
    const result = validateContractEvent(null);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/must be an object/);
  });

  test('rejects missing topics array', () => {
    const result = validateContractEvent({ data: {} });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('topics'))).toBe(true);
  });

  test('rejects topics with fewer than 2 elements', () => {
    const result = validateContractEvent({ topics: ['escrow'], data: {} });
    expect(result.valid).toBe(false);
  });

  test('rejects missing data object', () => {
    const result = validateContractEvent({
      topics: ['escrow', EVENT_TYPES.ESCROW_CREATED],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('data'))).toBe(true);
  });
});

describe('validateContractEvent — namespace and event type', () => {
  test('rejects wrong namespace in topics[0]', () => {
    const raw = makeRawEvent(EVENT_TYPES.ESCROW_CREATED);
    raw.topics[0] = 'payment';
    const result = validateContractEvent(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('"escrow"'))).toBe(true);
  });

  test('rejects unknown event type in topics[1]', () => {
    const raw = makeRawEvent(EVENT_TYPES.ESCROW_CREATED);
    raw.topics[1] = 'UnknownEvent';
    const result = validateContractEvent(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('topics[1]'))).toBe(true);
  });
});

describe('validateContractEvent — schema version', () => {
  test('emits warning when schemaVersion differs from expected', () => {
    const raw = makeRawEvent(EVENT_TYPES.ESCROW_CREATED);
    raw.data.schemaVersion = 99;
    const result = validateContractEvent(raw);
    // Should still be valid structurally, but warn
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes('schemaVersion'))).toBe(true);
  });
});

describe('validateContractEvent — field-level validation', () => {
  test('rejects missing required field (paymentId)', () => {
    const raw = makeRawEvent(EVENT_TYPES.ESCROW_CREATED);
    delete raw.data.paymentId;
    const result = validateContractEvent(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('paymentId'))).toBe(true);
  });

  test('rejects float stroop value', () => {
    const raw = makeRawEvent(EVENT_TYPES.ESCROW_CREATED);
    raw.data.amount = 250.5;
    const result = validateContractEvent(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('amount'))).toBe(true);
  });

  test('rejects negative stroop value', () => {
    const raw = makeRawEvent(EVENT_TYPES.FUNDS_RELEASED);
    raw.data.releasedAmount = -1;
    const result = validateContractEvent(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('releasedAmount'))).toBe(true);
  });

  test('rejects invalid enum value for asset', () => {
    const raw = makeRawEvent(EVENT_TYPES.ESCROW_CREATED);
    raw.data.asset = 'BTC';
    const result = validateContractEvent(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('asset'))).toBe(true);
  });

  test('rejects invalid enum for feeValidationStatus', () => {
    const raw = makeRawEvent(EVENT_TYPES.FUNDS_RELEASED);
    raw.data.feeValidationStatus = 'partial';
    const result = validateContractEvent(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('feeValidationStatus'))).toBe(true);
  });

  test('allows resolutionNote to be absent in DisputeResolved', () => {
    const raw = makeRawEvent(EVENT_TYPES.DISPUTE_RESOLVED);
    delete raw.data.resolutionNote;
    const result = validateContractEvent(raw);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('allows resolutionNote to be null in DisputeResolved', () => {
    const raw = makeRawEvent(EVENT_TYPES.DISPUTE_RESOLVED);
    raw.data.resolutionNote = null;
    const result = validateContractEvent(raw);
    expect(result.valid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 3: contractEventParser.js — parser behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('parse — reconciliation action derivation', () => {
  const cases = [
    [EVENT_TYPES.ESCROW_CREATED,   RECONCILIATION_ACTIONS.CREATE_OR_UPDATE_PAYMENT],
    [EVENT_TYPES.FUNDS_RELEASED,   RECONCILIATION_ACTIONS.CONFIRM_PAYMENT],
    [EVENT_TYPES.REFUND_ISSUED,    RECONCILIATION_ACTIONS.PROCESS_REFUND],
    [EVENT_TYPES.DISPUTE_RAISED,   RECONCILIATION_ACTIONS.OPEN_DISPUTE],
    [EVENT_TYPES.DISPUTE_RESOLVED, RECONCILIATION_ACTIONS.RESOLVE_DISPUTE],
  ];

  test.each(cases)('%s → %s', (eventType, expectedAction) => {
    const raw = makeRawEvent(eventType);
    const result = parse(raw);
    expect(result.valid).toBe(true);
    expect(result.reconciliationAction).toBe(expectedAction);
  });
});

describe('parse — stroop to decimal conversion', () => {
  test('EscrowCreated: amount 2_500_000_000 → 250 XLM', () => {
    const raw = makeRawEvent(EVENT_TYPES.ESCROW_CREATED);
    raw.data.amount = 2_500_000_000;
    raw.data.expectedFeeAmount = 2_500_000_000;
    const result = parse(raw);
    expect(result.valid).toBe(true);
    expect(result.payload.amount).toBeCloseTo(250, 5);
    expect(result.payload.amountStroops).toBe(2_500_000_000);
  });

  test('FundsReleased: releasedAmount and excessAmount converted', () => {
    const raw = makeRawEvent(EVENT_TYPES.FUNDS_RELEASED);
    raw.data.releasedAmount = 1_000_000_000;
    raw.data.excessAmount   = 500_000;
    const result = parse(raw);
    expect(result.payload.releasedAmount).toBeCloseTo(100, 5);
    expect(result.payload.excessAmount).toBeCloseTo(0.05, 5);
    expect(result.payload.releasedAmountStroops).toBe(1_000_000_000);
  });

  test('RefundIssued: refundAmount converted', () => {
    const raw = makeRawEvent(EVENT_TYPES.REFUND_ISSUED);
    raw.data.refundAmount = 10_000_000;
    const result = parse(raw);
    expect(result.payload.refundAmount).toBeCloseTo(1, 5);
    expect(result.payload.refundAmountStroops).toBe(10_000_000);
  });

  test('DisputeRaised: disputedAmount converted', () => {
    const raw = makeRawEvent(EVENT_TYPES.DISPUTE_RAISED);
    raw.data.disputedAmount = 7_500_000_000;
    const result = parse(raw);
    expect(result.payload.disputedAmount).toBeCloseTo(750, 5);
  });

  test('DisputeResolved: schoolAmount and depositorAmount converted', () => {
    const raw = makeRawEvent(EVENT_TYPES.DISPUTE_RESOLVED);
    raw.data.schoolAmount    = 1_000_000_000;
    raw.data.depositorAmount = 500_000_000;
    const result = parse(raw);
    expect(result.payload.schoolAmount).toBeCloseTo(100, 5);
    expect(result.payload.depositorAmount).toBeCloseTo(50, 5);
  });
});

describe('parse — invalid event handling', () => {
  test('returns valid=false for a null event', () => {
    const result = parse(null);
    expect(result.valid).toBe(false);
    expect(result.payload).toBeNull();
    expect(result.reconciliationAction).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('returns valid=false for missing required field', () => {
    const raw = makeRawEvent(EVENT_TYPES.ESCROW_CREATED);
    delete raw.data.studentId;
    const result = parse(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('studentId'))).toBe(true);
  });

  test('attaches warnings when schemaVersion mismatches', () => {
    const raw = makeRawEvent(EVENT_TYPES.FUNDS_RELEASED);
    raw.data.schemaVersion = 2; // future version
    const result = parse(raw);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes('schemaVersion'))).toBe(true);
  });
});

describe('parseBatch', () => {
  test('returns only valid events', () => {
    const valid1   = makeRawEvent(EVENT_TYPES.ESCROW_CREATED);
    const invalid  = { topics: ['escrow', 'EscrowCreated'], data: {} }; // missing fields
    const valid2   = makeRawEvent(EVENT_TYPES.FUNDS_RELEASED);

    const results = parseBatch([valid1, invalid, valid2]);
    expect(results).toHaveLength(2);
    expect(results[0].eventType).toBe(EVENT_TYPES.ESCROW_CREATED);
    expect(results[1].eventType).toBe(EVENT_TYPES.FUNDS_RELEASED);
  });

  test('calls onInvalid for each rejected event', () => {
    const onInvalid = jest.fn();
    const invalid1 = null;
    const invalid2 = { topics: ['wrong'], data: {} };
    parseBatch([invalid1, invalid2], { onInvalid });
    expect(onInvalid).toHaveBeenCalledTimes(2);
    expect(onInvalid.mock.calls[0][0].valid).toBe(false);
  });

  test('returns empty array for empty input', () => {
    expect(parseBatch([])).toEqual([]);
  });

  test('processes all five event types in a single batch', () => {
    const batch = Object.values(EVENT_TYPES).map((t) => makeRawEvent(t));
    const results = parseBatch(batch);
    expect(results).toHaveLength(5);
    const types = results.map(r => r.eventType);
    expect(types).toEqual(expect.arrayContaining(Object.values(EVENT_TYPES)));
  });
});

describe('stroopsToDecimal and decimalToStroops', () => {
  test('0 stroops → 0.0 XLM', () => {
    expect(stroopsToDecimal(0)).toBe(0);
  });

  test('1 stroop → 0.0000001 XLM', () => {
    expect(stroopsToDecimal(1)).toBeCloseTo(0.0000001, 7);
  });

  test('10_000_000 stroops → 1 XLM', () => {
    expect(stroopsToDecimal(10_000_000)).toBe(1);
  });

  test('1 XLM → 10_000_000 stroops (round-trip)', () => {
    expect(decimalToStroops(1)).toBe(10_000_000);
  });

  test('250 XLM → 2_500_000_000 stroops', () => {
    expect(decimalToStroops(250)).toBe(2_500_000_000);
  });

  test('round-trip: stroopsToDecimal(decimalToStroops(x)) ≈ x', () => {
    const values = [0, 1, 100, 999.9999999, 10_000];
    for (const v of values) {
      expect(stroopsToDecimal(decimalToStroops(v))).toBeCloseTo(v, 5);
    }
  });
});

describe('deriveReconciliationAction', () => {
  test('returns correct action for each known type', () => {
    expect(deriveReconciliationAction(EVENT_TYPES.ESCROW_CREATED)).toBe(RECONCILIATION_ACTIONS.CREATE_OR_UPDATE_PAYMENT);
    expect(deriveReconciliationAction(EVENT_TYPES.FUNDS_RELEASED)).toBe(RECONCILIATION_ACTIONS.CONFIRM_PAYMENT);
    expect(deriveReconciliationAction(EVENT_TYPES.REFUND_ISSUED)).toBe(RECONCILIATION_ACTIONS.PROCESS_REFUND);
    expect(deriveReconciliationAction(EVENT_TYPES.DISPUTE_RAISED)).toBe(RECONCILIATION_ACTIONS.OPEN_DISPUTE);
    expect(deriveReconciliationAction(EVENT_TYPES.DISPUTE_RESOLVED)).toBe(RECONCILIATION_ACTIONS.RESOLVE_DISPUTE);
  });

  test('returns null for unknown event type', () => {
    expect(deriveReconciliationAction('UnknownEvent')).toBeNull();
  });
});
