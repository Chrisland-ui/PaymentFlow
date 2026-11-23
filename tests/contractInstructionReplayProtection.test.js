'use strict';

/**
 * Issue #57: Add replay protection for contract instructions.
 *
 * Acceptance criteria:
 *   1. A replay is rejected without changing state.
 *   2. Concurrent submissions converge safely.
 *   3. Operation IDs are included in audit traces.
 */

const {
  INSTRUCTION_STATUS,
  ERROR_CODES,
  ContractInstructionReplayError,
  executeInstructionWithReplayProtection,
  verifyAndConsumeNonce,
  getAuditTracesForOperation,
  clearStores,
} = require('../backend/src/services/contractInstructionReplayProtection');

describe('Issue #57 — Contract Instruction Replay Protection', () => {
  beforeEach(() => {
    clearStores();
  });

  describe('Basic Execution & Replay Rejection', () => {
    test('executes a new instruction and commits state change', async () => {
      let stateCounter = 0;
      const res = await executeInstructionWithReplayProtection({
        operationId: 'op_release_001',
        instructionType: 'RELEASE',
        actor: 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G6O7ODYY2NO74PTDXWUC',
        payload: { amount: '100.0000000', studentId: 'STU101' },
        executeFn: async () => {
          stateCounter += 1;
          return { released: true, stateCounter };
        },
      });

      expect(res.status).toBe('COMMITTED');
      expect(res.stateMutated).toBe(true);
      expect(res.result).toEqual({ released: true, stateCounter: 1 });
      expect(stateCounter).toBe(1);
    });

    test('rejects replay with identical payload WITHOUT changing state', async () => {
      let stateCounter = 0;
      const executeFn = jest.fn(async () => {
        stateCounter += 1;
        return { released: true, count: stateCounter };
      });

      // 1. Initial submission
      const firstRes = await executeInstructionWithReplayProtection({
        operationId: 'op_release_002',
        instructionType: 'RELEASE',
        actor: 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G6O7ODYY2NO74PTDXWUC',
        payload: { amount: '50.0000000', studentId: 'STU102' },
        executeFn,
      });

      expect(firstRes.status).toBe('COMMITTED');
      expect(firstRes.stateMutated).toBe(true);
      expect(executeFn).toHaveBeenCalledTimes(1);
      expect(stateCounter).toBe(1);

      // 2. Replay submission
      const replayRes = await executeInstructionWithReplayProtection({
        operationId: 'op_release_002',
        instructionType: 'RELEASE',
        actor: 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G6O7ODYY2NO74PTDXWUC',
        payload: { amount: '50.0000000', studentId: 'STU102' },
        executeFn,
      });

      expect(replayRes.status).toBe('REPLAY_IDEMPOTENT');
      expect(replayRes.stateMutated).toBe(false);
      // Ensure executeFn was NOT invoked a second time
      expect(executeFn).toHaveBeenCalledTimes(1);
      expect(stateCounter).toBe(1);
      expect(replayRes.result).toEqual(firstRes.result);
    });

    test('rejects replay when throwOnReplay is true', async () => {
      const executeFn = jest.fn(async () => ({ ok: true }));

      await executeInstructionWithReplayProtection({
        operationId: 'op_release_003',
        instructionType: 'RELEASE',
        payload: { test: 1 },
        executeFn,
      });

      await expect(
        executeInstructionWithReplayProtection({
          operationId: 'op_release_003',
          instructionType: 'RELEASE',
          payload: { test: 1 },
          executeFn,
          throwOnReplay: true,
        })
      ).rejects.toThrow(ContractInstructionReplayError);
    });

    test('rejects operation if payload differs (tampering attempt) without mutating state', async () => {
      let stateCounter = 0;
      const executeFn = jest.fn(async () => {
        stateCounter += 100;
        return { count: stateCounter };
      });

      // 1. Initial valid operation
      await executeInstructionWithReplayProtection({
        operationId: 'op_refund_001',
        instructionType: 'REFUND',
        payload: { studentId: 'STU103', amount: '25.0000000' },
        executeFn,
      });
      expect(stateCounter).toBe(100);

      // 2. Attacker modifies amount using same operation ID
      await expect(
        executeInstructionWithReplayProtection({
          operationId: 'op_refund_001',
          instructionType: 'REFUND',
          payload: { studentId: 'STU103', amount: '999.0000000' }, // modified
          executeFn,
        })
      ).rejects.toThrow(ContractInstructionReplayError);

      try {
        await executeInstructionWithReplayProtection({
          operationId: 'op_refund_001',
          instructionType: 'REFUND',
          payload: { studentId: 'STU103', amount: '999.0000000' },
          executeFn,
        });
      } catch (err) {
        expect(err.code).toBe(ERROR_CODES.OPERATION_PAYLOAD_MISMATCH);
      }

      // State is guaranteed to NOT have been mutated
      expect(stateCounter).toBe(100);
      expect(executeFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('Concurrent Submissions Convergence', () => {
    test('concurrent submissions converge safely to a single execution', async () => {
      let executionCount = 0;
      const slowExecutionFn = async () => {
        executionCount += 1;
        // simulate async work
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { executionId: executionCount, timestamp: Date.now() };
      };

      // Launch 5 concurrent calls with the exact same operationId
      const promises = [1, 2, 3, 4, 5].map(() =>
        executeInstructionWithReplayProtection({
          operationId: 'op_concurrent_001',
          instructionType: 'RELEASE',
          payload: { studentId: 'STU_CONCURRENT', amount: '200.0000000' },
          executeFn: slowExecutionFn,
        })
      );

      const results = await Promise.all(promises);

      // Verify that execution was run exactly once
      expect(executionCount).toBe(1);

      // All 5 concurrent callers received the identical execution result
      const expectedResult = results[0].result;
      for (const res of results) {
        expect(res.result).toEqual(expectedResult);
      }

      // Exactly 1 reported stateMutated: true, the others converged safely
      const mutatedCount = results.filter((r) => r.stateMutated).length;
      expect(mutatedCount).toBe(1);
    });
  });

  describe('Audit Trace Inclusion of Operation IDs', () => {
    test('operation ID is included in audit traces for new executions', async () => {
      const opId = 'op_audit_trace_001';
      await executeInstructionWithReplayProtection({
        operationId: opId,
        instructionType: 'DEPOSIT',
        actor: 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G6O7ODYY2NO74PTDXWUC',
        payload: { amount: '75.0000000' },
        executeFn: async () => ({ deposited: true }),
      });

      const traces = getAuditTracesForOperation(opId);
      expect(traces.length).toBeGreaterThanOrEqual(2); // start + committed

      for (const trace of traces) {
        expect(trace.operationId).toBe(opId);
        expect(trace.instructionType).toBe('DEPOSIT');
        expect(trace.timestamp).toBeDefined();
      }
    });

    test('operation ID is included in audit traces for replay rejection', async () => {
      const opId = 'op_audit_trace_002';
      const executeFn = async () => ({ done: true });

      await executeInstructionWithReplayProtection({
        operationId: opId,
        instructionType: 'DISPUTE',
        payload: { reason: 'chargeback' },
        executeFn,
      });

      await executeInstructionWithReplayProtection({
        operationId: opId,
        instructionType: 'DISPUTE',
        payload: { reason: 'chargeback' },
        executeFn,
      });

      const traces = getAuditTracesForOperation(opId);
      const replayTrace = traces.find((t) => t.action === 'REPLAY_REJECTED_IDEMPOTENT');
      expect(replayTrace).toBeDefined();
      expect(replayTrace.operationId).toBe(opId);
      expect(replayTrace.status).toBe('IDEMPOTENT_SKIPPED');
    });

    test('operation ID is included in audit traces on failed execution', async () => {
      const opId = 'op_audit_trace_003';
      await expect(
        executeInstructionWithReplayProtection({
          operationId: opId,
          instructionType: 'REFUND',
          payload: { reason: 'error' },
          executeFn: async () => {
            throw new Error('On-chain failure');
          },
        })
      ).rejects.toThrow('On-chain failure');

      const traces = getAuditTracesForOperation(opId);
      const failTrace = traces.find((t) => t.status === INSTRUCTION_STATUS.FAILED);
      expect(failTrace).toBeDefined();
      expect(failTrace.operationId).toBe(opId);
      expect(failTrace.details.error).toBe('On-chain failure');
    });
  });

  describe('Sequential Nonce Semantics', () => {
    test('accepts strictly monotonically increasing nonces', () => {
      const account = 'GACCOUNT_TEST_NONCE';
      expect(verifyAndConsumeNonce(account, 1n)).toBe(true);
      expect(verifyAndConsumeNonce(account, 2n)).toBe(true);
      expect(verifyAndConsumeNonce(account, 3n)).toBe(true);
    });

    test('rejects non-monotonic or replayed nonce', () => {
      const account = 'GACCOUNT_TEST_NONCE_REPLAY';
      verifyAndConsumeNonce(account, 1n);

      // Replaying nonce 1n
      expect(() => verifyAndConsumeNonce(account, 1n)).toThrow(ContractInstructionReplayError);
      // Skipping to nonce 5n (out of order)
      expect(() => verifyAndConsumeNonce(account, 5n)).toThrow(ContractInstructionReplayError);
    });
  });
});
