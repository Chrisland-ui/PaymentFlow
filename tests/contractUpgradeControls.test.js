'use strict';

/**
 * Tests for Issue #61: Define contract upgrade and pause controls.
 *
 * Acceptance Criteria:
 *   1. Controls are least-privilege and auditable.
 *   2. Paused behavior is tested (blocked actions, allowed exceptions).
 *   3. A recovery runbook covers key loss and upgrade failure.
 *      (See docs/runbooks/contract-upgrade-failure.md)
 */

const {
  UPGRADE_STATES,
  PAUSE_ROLES,
  UPGRADE_QUORUM,
  ALLOWED_ACTIONS_WHILE_PAUSED,
  ERROR_CODES,
  UpgradeControlError,
  pauseContract,
  unpauseContract,
  getAllowedActionsWhilePaused,
  checkActionPermitted,
  validateUpgradeAuthorization,
  proposeUpgrade,
  approveUpgrade,
  executeUpgrade,
  rollbackUpgrade,
} = require('../backend/src/services/contractUpgradeControls');

const OWNER_KEY = 'GOWNER_EXAMPLE_KEY_123456789';
const OPERATOR_KEY = 'GOPERATOR_EXAMPLE_KEY_123456789';
const PAYER_KEY = 'GPAYER_EXAMPLE_KEY_123456789';
const VALID_HASH = 'deadbeef1234567890abcdef12345678';

// ---------------------------------------------------------------------------
// getAllowedActionsWhilePaused
// ---------------------------------------------------------------------------
describe('getAllowedActionsWhilePaused', () => {
  test('returns an array containing only "unpause"', () => {
    const allowed = getAllowedActionsWhilePaused();
    expect(Array.isArray(allowed)).toBe(true);
    expect(allowed).toContain('unpause');
    // Only 'unpause' is allowed while paused — no state-changing ops
    expect(allowed.length).toBe(1);
  });

  test('returns a frozen / non-mutable value', () => {
    const allowed = getAllowedActionsWhilePaused();
    expect(() => { allowed.push('deposit'); }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// pauseContract
// ---------------------------------------------------------------------------
describe('pauseContract', () => {
  test('OWNER can pause the contract', () => {
    const record = pauseContract(OWNER_KEY, 'OWNER');
    expect(record.paused).toBe(true);
    expect(record.pausedBy).toBe(OWNER_KEY);
    expect(typeof record.pausedAt).toBe('string');
  });

  test('OPERATOR can pause the contract', () => {
    const record = pauseContract(OPERATOR_KEY, 'OPERATOR');
    expect(record.paused).toBe(true);
    expect(record.pausedBy).toBe(OPERATOR_KEY);
  });

  test('PAYER cannot pause the contract', () => {
    expect(() => pauseContract(PAYER_KEY, 'PAYER')).toThrow(UpgradeControlError);
    expect(() => pauseContract(PAYER_KEY, 'PAYER')).toThrow(ERROR_CODES.UNAUTHORIZED_ROLE);
  });

  test('BENEFICIARY cannot pause the contract', () => {
    expect(() => pauseContract('GBENEFICIARY', 'BENEFICIARY')).toThrow(UpgradeControlError);
  });

  test('Unknown role cannot pause the contract', () => {
    expect(() => pauseContract('GUNKOWN', 'UNKNOWN_ROLE')).toThrow(UpgradeControlError);
  });

  test('pause record includes the callers role', () => {
    const record = pauseContract(OPERATOR_KEY, 'OPERATOR');
    expect(record.role).toBe('OPERATOR');
  });
});

// ---------------------------------------------------------------------------
// unpauseContract
// ---------------------------------------------------------------------------
describe('unpauseContract', () => {
  let pauseRecord;

  beforeEach(() => {
    pauseRecord = pauseContract(OPERATOR_KEY, 'OPERATOR');
  });

  test('OWNER can unpause a paused contract', () => {
    const result = unpauseContract(OWNER_KEY, 'OWNER', pauseRecord);
    expect(result.paused).toBe(false);
    expect(result.unpausedBy).toBe(OWNER_KEY);
    expect(typeof result.unpausedAt).toBe('string');
    expect(typeof result.pauseDurationMs).toBe('number');
  });

  test('OPERATOR cannot unpause the contract', () => {
    expect(() => unpauseContract(OPERATOR_KEY, 'OPERATOR', pauseRecord))
      .toThrow(UpgradeControlError);
  });

  test('PAYER cannot unpause the contract', () => {
    expect(() => unpauseContract(PAYER_KEY, 'PAYER', pauseRecord))
      .toThrow(UpgradeControlError);
  });

  test('throws when contract is not paused', () => {
    expect(() => unpauseContract(OWNER_KEY, 'OWNER', { paused: false }))
      .toThrow(UpgradeControlError);
    expect(() => unpauseContract(OWNER_KEY, 'OWNER', null))
      .toThrow(UpgradeControlError);
  });

  test('unpause record references the previous pause record', () => {
    const result = unpauseContract(OWNER_KEY, 'OWNER', pauseRecord);
    expect(result.previousPauseRecord).toEqual(pauseRecord);
  });
});

// ---------------------------------------------------------------------------
// checkActionPermitted (pause gate)
// ---------------------------------------------------------------------------
describe('checkActionPermitted', () => {
  test('all actions permitted when contract is not paused', () => {
    expect(checkActionPermitted('deposit', false, 'PAYER').permitted).toBe(true);
    expect(checkActionPermitted('release', false, 'OPERATOR').permitted).toBe(true);
    expect(checkActionPermitted('dispute', false, 'PAYER').permitted).toBe(true);
  });

  test('deposit is blocked when paused', () => {
    const result = checkActionPermitted('deposit', true, 'PAYER');
    expect(result.permitted).toBe(false);
    expect(result.code).toBe(ERROR_CODES.CONTRACT_PAUSED);
  });

  test('release is blocked when paused', () => {
    const result = checkActionPermitted('release', true, 'OPERATOR');
    expect(result.permitted).toBe(false);
    expect(result.code).toBe(ERROR_CODES.CONTRACT_PAUSED);
  });

  test('unpause by OWNER is permitted when paused', () => {
    const result = checkActionPermitted('unpause', true, 'OWNER');
    expect(result.permitted).toBe(true);
  });

  test('unpause by OPERATOR is blocked when paused', () => {
    const result = checkActionPermitted('unpause', true, 'OPERATOR');
    expect(result.permitted).toBe(false);
    expect(result.code).toBe(ERROR_CODES.UNAUTHORIZED_ROLE);
  });

  test('dispute is blocked when paused', () => {
    const result = checkActionPermitted('dispute', true, 'PAYER');
    expect(result.permitted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateUpgradeAuthorization (least-privilege)
// ---------------------------------------------------------------------------
describe('validateUpgradeAuthorization', () => {
  test('OWNER is authorized to upgrade', () => {
    const result = validateUpgradeAuthorization('OWNER');
    expect(result.authorized).toBe(true);
  });

  test('OPERATOR is NOT authorized to upgrade', () => {
    const result = validateUpgradeAuthorization('OPERATOR');
    expect(result.authorized).toBe(false);
    expect(typeof result.reason).toBe('string');
  });

  test('PAYER is NOT authorized to upgrade', () => {
    const result = validateUpgradeAuthorization('PAYER');
    expect(result.authorized).toBe(false);
  });

  test('BENEFICIARY is NOT authorized to upgrade', () => {
    const result = validateUpgradeAuthorization('BENEFICIARY');
    expect(result.authorized).toBe(false);
  });

  test('UNAUTHORIZED role is NOT authorized to upgrade', () => {
    const result = validateUpgradeAuthorization('UNAUTHORIZED');
    expect(result.authorized).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// proposeUpgrade
// ---------------------------------------------------------------------------
describe('proposeUpgrade', () => {
  test('OWNER can propose an upgrade', () => {
    const proposal = proposeUpgrade(OWNER_KEY, 'OWNER', VALID_HASH, { description: 'v1.1.0 patch' });
    expect(proposal.state).toBe(UPGRADE_STATES.PROPOSED);
    expect(proposal.proposer).toBe(OWNER_KEY);
    expect(proposal.newContractHash).toBe(VALID_HASH);
    expect(proposal.approvals).toContain(OWNER_KEY);
    expect(proposal.quorumRequired).toBe(UPGRADE_QUORUM);
    expect(typeof proposal.proposedAt).toBe('string');
  });

  test('OPERATOR cannot propose an upgrade', () => {
    expect(() => proposeUpgrade(OPERATOR_KEY, 'OPERATOR', VALID_HASH))
      .toThrow(UpgradeControlError);
  });

  test('PAYER cannot propose an upgrade', () => {
    expect(() => proposeUpgrade(PAYER_KEY, 'PAYER', VALID_HASH))
      .toThrow(UpgradeControlError);
  });

  test('throws when contract hash is missing', () => {
    expect(() => proposeUpgrade(OWNER_KEY, 'OWNER', ''))
      .toThrow(UpgradeControlError);
    expect(() => proposeUpgrade(OWNER_KEY, 'OWNER', null))
      .toThrow(UpgradeControlError);
  });

  test('throws when contract hash is too short', () => {
    expect(() => proposeUpgrade(OWNER_KEY, 'OWNER', 'abc'))
      .toThrow(UpgradeControlError);
  });

  test('proposer is counted as first approval', () => {
    const proposal = proposeUpgrade(OWNER_KEY, 'OWNER', VALID_HASH);
    expect(proposal.approvals.length).toBe(1);
    expect(proposal.approvals[0]).toBe(OWNER_KEY);
  });
});

// ---------------------------------------------------------------------------
// approveUpgrade
// ---------------------------------------------------------------------------
describe('approveUpgrade', () => {
  let proposal;
  const SECOND_OWNER = 'GOWNER2_EXAMPLE_KEY_987654321';

  beforeEach(() => {
    proposal = proposeUpgrade(OWNER_KEY, 'OWNER', VALID_HASH);
  });

  test('second OWNER approval meets quorum and transitions to APPROVED', () => {
    const updated = approveUpgrade(proposal, SECOND_OWNER, 'OWNER');
    expect(updated.state).toBe(UPGRADE_STATES.APPROVED);
    expect(updated.approvals).toContain(SECOND_OWNER);
    expect(updated.approvals.length).toBe(2);
    expect(typeof updated.approvedAt).toBe('string');
  });

  test('OPERATOR cannot approve an upgrade', () => {
    expect(() => approveUpgrade(proposal, OPERATOR_KEY, 'OPERATOR'))
      .toThrow(UpgradeControlError);
  });

  test('duplicate approval by the same actor is rejected', () => {
    expect(() => approveUpgrade(proposal, OWNER_KEY, 'OWNER'))
      .toThrow(UpgradeControlError);
  });

  test('cannot approve an upgrade that is not in PROPOSED state', () => {
    const approved = approveUpgrade(proposal, SECOND_OWNER, 'OWNER');
    expect(() => approveUpgrade(approved, 'GOWNER3', 'OWNER'))
      .toThrow(UpgradeControlError);
  });
});

// ---------------------------------------------------------------------------
// executeUpgrade
// ---------------------------------------------------------------------------
describe('executeUpgrade', () => {
  let approvedProposal;
  const SECOND_OWNER = 'GOWNER2_EXAMPLE_KEY_987654321';

  beforeEach(() => {
    const proposed = proposeUpgrade(OWNER_KEY, 'OWNER', VALID_HASH);
    approvedProposal = approveUpgrade(proposed, SECOND_OWNER, 'OWNER');
  });

  test('OWNER can execute an APPROVED upgrade', () => {
    const executing = executeUpgrade(approvedProposal, OWNER_KEY, 'OWNER');
    expect(executing.state).toBe(UPGRADE_STATES.EXECUTING);
    expect(executing.executor).toBe(OWNER_KEY);
    expect(typeof executing.executionStartedAt).toBe('string');
  });

  test('OPERATOR cannot execute an upgrade', () => {
    expect(() => executeUpgrade(approvedProposal, OPERATOR_KEY, 'OPERATOR'))
      .toThrow(UpgradeControlError);
  });

  test('cannot execute a PROPOSED (not yet approved) upgrade', () => {
    const proposed = proposeUpgrade(OWNER_KEY, 'OWNER', VALID_HASH);
    expect(() => executeUpgrade(proposed, OWNER_KEY, 'OWNER'))
      .toThrow(UpgradeControlError);
  });
});

// ---------------------------------------------------------------------------
// rollbackUpgrade
// ---------------------------------------------------------------------------
describe('rollbackUpgrade', () => {
  let executingProposal;
  const SECOND_OWNER = 'GOWNER2_EXAMPLE_KEY_987654321';

  beforeEach(() => {
    const proposed = proposeUpgrade(OWNER_KEY, 'OWNER', VALID_HASH);
    const approved = approveUpgrade(proposed, SECOND_OWNER, 'OWNER');
    executingProposal = executeUpgrade(approved, OWNER_KEY, 'OWNER');
  });

  test('records rollback with reason and timestamp', () => {
    const rolled = rollbackUpgrade(executingProposal, 'WASM hash mismatch detected post-deploy', OWNER_KEY);
    expect(rolled.state).toBe(UPGRADE_STATES.ROLLED_BACK);
    expect(rolled.rollback.reason).toBe('WASM hash mismatch detected post-deploy');
    expect(rolled.rollback.rolledBackBy).toBe(OWNER_KEY);
    expect(typeof rolled.rollback.rolledBackAt).toBe('string');
    expect(rolled.rollback.previousState).toBe(UPGRADE_STATES.EXECUTING);
  });

  test('rollback from APPROVED state is also permitted', () => {
    const proposed = proposeUpgrade(OWNER_KEY, 'OWNER', VALID_HASH);
    const approved = approveUpgrade(proposed, SECOND_OWNER, 'OWNER');
    const rolled = rollbackUpgrade(approved, 'Pre-execution abort', OWNER_KEY);
    expect(rolled.state).toBe(UPGRADE_STATES.ROLLED_BACK);
  });

  test('throws when reason is empty', () => {
    expect(() => rollbackUpgrade(executingProposal, ''))
      .toThrow(UpgradeControlError);
    expect(() => rollbackUpgrade(executingProposal, '   '))
      .toThrow(UpgradeControlError);
  });

  test('cannot roll back an already-rolled-back upgrade', () => {
    const rolled = rollbackUpgrade(executingProposal, 'first rollback', OWNER_KEY);
    expect(() => rollbackUpgrade(rolled, 'second rollback attempt', OWNER_KEY))
      .toThrow(UpgradeControlError);
  });

  test('cannot roll back an IDLE (PROPOSED) upgrade', () => {
    const proposed = proposeUpgrade(OWNER_KEY, 'OWNER', VALID_HASH);
    expect(() => rollbackUpgrade(proposed, 'trying to rollback too early'))
      .toThrow(UpgradeControlError);
  });
});

// ---------------------------------------------------------------------------
// PAUSE_ROLES constant — least-privilege audit
// ---------------------------------------------------------------------------
describe('PAUSE_ROLES constants (auditability)', () => {
  test('PAYER is NOT in CAN_PAUSE list', () => {
    expect(PAUSE_ROLES.CAN_PAUSE).not.toContain('PAYER');
  });

  test('BENEFICIARY is NOT in CAN_PAUSE list', () => {
    expect(PAUSE_ROLES.CAN_PAUSE).not.toContain('BENEFICIARY');
  });

  test('only OWNER is in CAN_UNPAUSE list', () => {
    expect(PAUSE_ROLES.CAN_UNPAUSE).toEqual(['OWNER']);
  });

  test('UPGRADE_QUORUM is at least 2 (prevents single-key unilateral upgrade)', () => {
    expect(UPGRADE_QUORUM).toBeGreaterThanOrEqual(2);
  });
});
