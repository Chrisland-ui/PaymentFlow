'use strict';

/**
 * Issue #59: Add contract event schema for indexing.
 *
 * Acceptance Criteria:
 *   1. Indexers can process events idempotently.
 *   2. Event schemas are documented (docs/contract-event-schema.md).
 *   3. Event changes have compatibility tests.
 */

const {
  CURRENT_SCHEMA_VERSION,
  CONTRACT_EVENT_TOPICS,
  ContractEventSchemaError,
  validateContractEvent,
  createContractEvent,
  processEventIdempotently,
  rebuildProjectionFromEvents,
  validateSchemaCompatibility,
} = require('../backend/src/services/contractEventSchema');

describe('Issue #59 — Contract Event Schema for Indexing', () => {
  const sampleContractId = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  const sampleTxHash = 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0';

  describe('Event Factory and Schema Validation', () => {
    test('creates and validates a valid deposit event', () => {
      const event = createContractEvent(CONTRACT_EVENT_TOPICS.DEPOSIT, {
        contractId: sampleContractId,
        ledger: 1001,
        txHash: sampleTxHash,
        correlationId: 'intent_stu001_dep',
        payload: {
          payer: 'GAY2Y7...EXAMPLE',
          studentId: 'STU001',
          schoolId: 'SCH001',
          asset: { code: 'XLM', type: 'native', issuer: null },
          amountStroops: '500000000',
          amountDecimal: '50.0000000',
          memo: 'STU001',
        },
      });

      expect(event.eventVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(event.topic).toBe(CONTRACT_EVENT_TOPICS.DEPOSIT);
      expect(validateContractEvent(event)).toBe(true);
    });

    test('creates and validates a valid release event', () => {
      const event = createContractEvent(CONTRACT_EVENT_TOPICS.RELEASE, {
        contractId: sampleContractId,
        ledger: 1002,
        txHash: sampleTxHash,
        correlationId: 'op_rel_001',
        payload: {
          beneficiary: 'GSCHOOL...EXAMPLE',
          studentId: 'STU001',
          schoolId: 'SCH001',
          asset: { code: 'USDC', type: 'credit_alphanum4', issuer: 'GBUQWP...ISSUER' },
          amountStroops: '1000000000',
          amountDecimal: '100.0000000',
          authorizedBy: 'GOPERATOR...EXAMPLE',
        },
      });

      expect(validateContractEvent(event)).toBe(true);
    });

    test('creates and validates a valid refund event', () => {
      const event = createContractEvent(CONTRACT_EVENT_TOPICS.REFUND, {
        contractId: sampleContractId,
        ledger: 1003,
        txHash: sampleTxHash,
        correlationId: 'op_ref_001',
        payload: {
          recipient: 'GPARENT...EXAMPLE',
          studentId: 'STU002',
          schoolId: 'SCH001',
          asset: { code: 'XLM', type: 'native', issuer: null },
          amountStroops: '250000000',
          amountDecimal: '25.0000000',
          reason: 'Overpayment balance returned',
          authorizedBy: 'GOPERATOR...EXAMPLE',
        },
      });

      expect(validateContractEvent(event)).toBe(true);
    });

    test('creates and validates a valid dispute event', () => {
      const event = createContractEvent(CONTRACT_EVENT_TOPICS.DISPUTE, {
        contractId: sampleContractId,
        ledger: 1004,
        txHash: sampleTxHash,
        correlationId: 'disp_001',
        payload: {
          disputeId: 'DISP_1001',
          studentId: 'STU003',
          schoolId: 'SCH001',
          initiator: 'GPARENT...EXAMPLE',
          status: 'opened',
          amountStroops: '500000000',
          amountDecimal: '50.0000000',
          reason: 'Duplicate billing charged',
        },
      });

      expect(validateContractEvent(event)).toBe(true);
    });

    test('rejects event with missing correlationId', () => {
      expect(() => {
        createContractEvent(CONTRACT_EVENT_TOPICS.DEPOSIT, {
          contractId: sampleContractId,
          ledger: 1001,
          txHash: sampleTxHash,
          correlationId: '', // empty
          payload: {
            payer: 'GAY2Y7...EXAMPLE',
            studentId: 'STU001',
            schoolId: 'SCH001',
            asset: { code: 'XLM' },
            amountStroops: '100',
            amountDecimal: '0.0000100',
          },
        });
      }).toThrow(ContractEventSchemaError);
    });

    test('rejects event with invalid topic', () => {
      expect(() => {
        validateContractEvent({
          eventId: 'ev_001',
          eventVersion: '1.0.0',
          topic: 'invalid_topic',
          contractId: sampleContractId,
          ledger: 100,
          txHash: sampleTxHash,
          timestamp: new Date().toISOString(),
          correlationId: 'c1',
          payload: {},
        });
      }).toThrow(ContractEventSchemaError);
    });
  });

  describe('Idempotent Indexer Processing', () => {
    test('processes new events and ignores duplicate event IDs without modifying projection', () => {
      const processedEventIds = new Set();
      const projection = {};

      const depositEvent = createContractEvent(CONTRACT_EVENT_TOPICS.DEPOSIT, {
        eventId: 'evt_dep_fixed_id_101',
        contractId: sampleContractId,
        ledger: 1001,
        txHash: sampleTxHash,
        correlationId: 'c_dep_01',
        payload: {
          payer: 'GPARENT',
          studentId: 'STU001',
          schoolId: 'SCH001',
          asset: { code: 'XLM', type: 'native' },
          amountStroops: '500000000',
          amountDecimal: '50.0000000',
          memo: 'STU001',
        },
      });

      // 1. Initial ingestion
      const firstRun = processEventIdempotently(depositEvent, projection, processedEventIds);
      expect(firstRun.processed).toBe(true);
      expect(projection.students['STU001'].depositedStroops).toBe(500000000n);
      expect(projection.students['STU001'].history.length).toBe(1);

      // 2. Duplicate ingestion (same event received again from network/horizon replay)
      const secondRun = processEventIdempotently(depositEvent, projection, processedEventIds);
      expect(secondRun.processed).toBe(false);
      expect(secondRun.reason).toBe('duplicate_event');

      // State is guaranteed to NOT be double-counted
      expect(projection.students['STU001'].depositedStroops).toBe(500000000n);
      expect(projection.students['STU001'].history.length).toBe(1);
    });
  });

  describe('Projection Rebuilding from Historical Event Stream', () => {
    test('correctly reconstructs student balances and dispute count from scratch', () => {
      const events = [
        createContractEvent(CONTRACT_EVENT_TOPICS.DEPOSIT, {
          eventId: 'e1',
          contractId: sampleContractId,
          ledger: 100,
          txHash: sampleTxHash,
          correlationId: 'c1',
          payload: {
            payer: 'P1',
            studentId: 'STU_REBUILD',
            schoolId: 'SCH1',
            asset: { code: 'XLM' },
            amountStroops: '1000000000', // 100 XLM
            amountDecimal: '100.0000000',
            memo: 'STU_REBUILD',
          },
        }),
        createContractEvent(CONTRACT_EVENT_TOPICS.RELEASE, {
          eventId: 'e2',
          contractId: sampleContractId,
          ledger: 101,
          txHash: sampleTxHash,
          correlationId: 'c2',
          payload: {
            beneficiary: 'B1',
            studentId: 'STU_REBUILD',
            schoolId: 'SCH1',
            asset: { code: 'XLM' },
            amountStroops: '600000000', // 60 XLM released
            amountDecimal: '60.0000000',
            authorizedBy: 'OP1',
          },
        }),
        createContractEvent(CONTRACT_EVENT_TOPICS.REFUND, {
          eventId: 'e3',
          contractId: sampleContractId,
          ledger: 102,
          txHash: sampleTxHash,
          correlationId: 'c3',
          payload: {
            recipient: 'P1',
            studentId: 'STU_REBUILD',
            schoolId: 'SCH1',
            asset: { code: 'XLM' },
            amountStroops: '200000000', // 20 XLM refunded
            amountDecimal: '20.0000000',
            reason: 'Excess fee return',
            authorizedBy: 'OP1',
          },
        }),
        createContractEvent(CONTRACT_EVENT_TOPICS.DISPUTE, {
          eventId: 'e4',
          contractId: sampleContractId,
          ledger: 103,
          txHash: sampleTxHash,
          correlationId: 'c4',
          payload: {
            disputeId: 'D1',
            studentId: 'STU_REBUILD',
            schoolId: 'SCH1',
            initiator: 'P1',
            status: 'opened',
            amountStroops: '200000000',
            amountDecimal: '20.0000000',
            reason: 'Remaining fee dispute',
          },
        }),
      ];

      const projection = rebuildProjectionFromEvents(events);
      const student = projection.students['STU_REBUILD'];

      expect(student).toBeDefined();
      expect(student.depositedStroops).toBe(1000000000n);
      expect(student.releasedStroops).toBe(600000000n);
      expect(student.refundedStroops).toBe(200000000n);
      expect(student.activeDisputes).toBe(1);
      expect(student.history.length).toBe(4);
    });
  });

  describe('Compatibility Tests', () => {
    test('forward compatibility: event with additional unknown fields does NOT fail validation', () => {
      const event = createContractEvent(CONTRACT_EVENT_TOPICS.DEPOSIT, {
        contractId: sampleContractId,
        ledger: 2001,
        txHash: sampleTxHash,
        correlationId: 'c_extra',
        payload: {
          payer: 'GPARENT',
          studentId: 'STU_COMPAT',
          schoolId: 'SCH001',
          asset: { code: 'XLM', type: 'native' },
          amountStroops: '100000000',
          amountDecimal: '10.0000000',
          memo: 'COMPAT',
          // New optional future fields
          futureExtensionField: 'experimental_data',
          metadataTags: ['fast_track', 'priority'],
        },
      });

      const compat = validateSchemaCompatibility(event, '1.0.0');
      expect(compat.compatible).toBe(true);
    });

    test('backward compatibility: detects incompatible major version mismatch', () => {
      const futureMajorEvent = {
        eventId: 'ev_v2',
        eventVersion: '2.0.0', // major version bump
        topic: 'deposit',
        contractId: sampleContractId,
        ledger: 500,
        txHash: sampleTxHash,
        timestamp: new Date().toISOString(),
        correlationId: 'c_v2',
        payload: {},
      };

      const compat = validateSchemaCompatibility(futureMajorEvent, '1.0.0');
      expect(compat.compatible).toBe(false);
      expect(compat.reason).toMatch(/Major version mismatch/);
    });
  });
});
