'use strict';

/**
 * Local Contract Simulation (Issue #60).
 *
 * Runs representative contract transaction simulations using the existing
 * contract services. This script is executed in CI to catch contract
 * assumption drift before it reaches staging.
 *
 * Exit codes:
 *   0 — all simulations passed
 *   1 — one or more simulations failed
 *
 * Env vars consumed:
 *   STELLAR_NETWORK              — logged as part of network config (default: testnet)
 *   CONTRACT_SIMULATION_TOOLCHAIN — toolchain version tag (default: 1.0.0)
 */

const {
  createContractEvent,
  CONTRACT_EVENT_TOPICS,
  validateContractEvent,
  CURRENT_SCHEMA_VERSION,
} = require('../backend/src/services/contractEventSchema');

const {
  evaluateAuthorization,
  ROLES,
  PRIVILEGED_ENTRY_POINTS,
} = require('../backend/src/services/contractAuthorizationPolicy');

const {
  validateContractAsset,
} = require('../backend/src/services/contractAssetValidation');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TOOLCHAIN_VERSION = process.env.CONTRACT_SIMULATION_TOOLCHAIN || '1.0.0';
const STELLAR_NETWORK = process.env.STELLAR_NETWORK || 'testnet';

const SAMPLE_CONTRACT_ID = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const SAMPLE_TX_HASH = 'a1b2c3d4e5f6789012345678abcdef0123456789abcdef0123456789abcdef01';

// ---------------------------------------------------------------------------
// Individual simulations
// ---------------------------------------------------------------------------

/**
 * Simulates a deposit transaction.
 * Validates event schema + authorization for the deposit entry point.
 *
 * @returns {{ name: string, passed: boolean, error?: string }}
 */
function runDepositSimulation() {
  const name = 'deposit';
  try {
    // 1. Build and validate the event
    const event = createContractEvent(CONTRACT_EVENT_TOPICS.DEPOSIT, {
      contractId: SAMPLE_CONTRACT_ID,
      ledger: 1001,
      txHash: SAMPLE_TX_HASH,
      correlationId: 'sim_deposit_001',
      payload: {
        payer: 'GPAYER_SIMULATION_ADDRESS_PLACEHOLDER_001',
        studentId: 'STU-SIM-001',
        schoolId: 'SCH-SIM-001',
        asset: { code: 'XLM', type: 'native', issuer: null },
        amountStroops: '2500000000',
        amountDecimal: '250.0000000',
        memo: 'STU-SIM-001',
      },
    });

    if (!validateContractEvent(event)) {
      return { name, passed: false, error: 'Event schema validation returned false' };
    }

    // 2. Check authorization (PAYER is allowed to call deposit)
    const authResult = evaluateAuthorization({
      action: PRIVILEGED_ENTRY_POINTS.DEPOSIT,
      role: ROLES.PAYER,
      actor: 'GPAYER_SIMULATION_ADDRESS_PLACEHOLDER_001',
      isPaused: false,
    });

    if (!authResult.authorized) {
      return { name, passed: false, error: `Authorization check failed: ${authResult.reason}` };
    }

    // 3. Validate the asset
    const assetResult = validateContractAsset({ code: 'XLM', type: 'native', issuer: null });
    if (!assetResult || !assetResult.valid) {
      return { name, passed: false, error: 'Asset validation failed for XLM' };
    }

    return { name, passed: true };
  } catch (err) {
    return { name, passed: false, error: err.message };
  }
}

/**
 * Simulates a release transaction.
 * Validates event schema + authorization for the release entry point.
 *
 * @returns {{ name: string, passed: boolean, error?: string }}
 */
function runReleaseSimulation() {
  const name = 'release';
  try {
    const event = createContractEvent(CONTRACT_EVENT_TOPICS.RELEASE, {
      contractId: SAMPLE_CONTRACT_ID,
      ledger: 1002,
      txHash: SAMPLE_TX_HASH,
      correlationId: 'sim_release_001',
      payload: {
        beneficiary: 'GSCHOOL_SIMULATION_ADDRESS_PLACEHOLDER_001',
        studentId: 'STU-SIM-001',
        schoolId: 'SCH-SIM-001',
        asset: { code: 'XLM', type: 'native', issuer: null },
        amountStroops: '2500000000',
        amountDecimal: '250.0000000',
        authorizedBy: 'GOPERATOR_SIMULATION_ADDRESS_PLACEHOLDER_001',
      },
    });

    if (!validateContractEvent(event)) {
      return { name, passed: false, error: 'Event schema validation returned false' };
    }

    // OPERATOR is allowed to release
    const authResult = evaluateAuthorization({
      action: PRIVILEGED_ENTRY_POINTS.RELEASE,
      role: ROLES.OPERATOR,
      actor: 'GOPERATOR_SIMULATION_ADDRESS_PLACEHOLDER_001',
      isPaused: false,
    });

    if (!authResult.authorized) {
      return { name, passed: false, error: `Authorization check failed: ${authResult.reason}` };
    }

    return { name, passed: true };
  } catch (err) {
    return { name, passed: false, error: err.message };
  }
}

/**
 * Simulates a dispute transaction.
 * Validates event schema + authorization for the dispute entry point.
 *
 * @returns {{ name: string, passed: boolean, error?: string }}
 */
function runDisputeSimulation() {
  const name = 'dispute';
  try {
    const event = createContractEvent(CONTRACT_EVENT_TOPICS.DISPUTE, {
      contractId: SAMPLE_CONTRACT_ID,
      ledger: 1003,
      txHash: SAMPLE_TX_HASH,
      correlationId: 'sim_dispute_001',
      payload: {
        disputeId: 'DISP-SIM-001',
        studentId: 'STU-SIM-002',
        schoolId: 'SCH-SIM-001',
        initiator: 'GPAYER_SIMULATION_ADDRESS_PLACEHOLDER_002',
        status: 'opened',
        amountStroops: '1000000000',
        amountDecimal: '100.0000000',
        reason: 'Simulation: payment not reflected',
      },
    });

    if (!validateContractEvent(event)) {
      return { name, passed: false, error: 'Event schema validation returned false' };
    }

    // PAYER is allowed to open a dispute on their own resource
    const authResult = evaluateAuthorization({
      action: PRIVILEGED_ENTRY_POINTS.DISPUTE,
      role: ROLES.PAYER,
      actor: 'GPAYER_SIMULATION_ADDRESS_PLACEHOLDER_002',
      isPaused: false,
      resourceOwner: 'GPAYER_SIMULATION_ADDRESS_PLACEHOLDER_002',
    });

    if (!authResult.authorized) {
      return { name, passed: false, error: `Authorization check failed: ${authResult.reason}` };
    }

    return { name, passed: true };
  } catch (err) {
    return { name, passed: false, error: err.message };
  }
}

/**
 * Simulates USDC deposit (non-native asset path).
 *
 * @returns {{ name: string, passed: boolean, error?: string }}
 */
function runUsdcDepositSimulation() {
  const name = 'deposit-usdc';
  try {
    const event = createContractEvent(CONTRACT_EVENT_TOPICS.DEPOSIT, {
      contractId: SAMPLE_CONTRACT_ID,
      ledger: 1004,
      txHash: SAMPLE_TX_HASH,
      correlationId: 'sim_deposit_usdc_001',
      payload: {
        payer: 'GPAYER_SIMULATION_ADDRESS_PLACEHOLDER_003',
        studentId: 'STU-SIM-003',
        schoolId: 'SCH-SIM-001',
        asset: {
          code: 'USDC',
          type: 'credit_alphanum4',
          issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        },
        amountStroops: '2500000000',
        amountDecimal: '250.0000000',
        memo: 'STU-SIM-003',
      },
    });

    if (!validateContractEvent(event)) {
      return { name, passed: false, error: 'Event schema validation returned false for USDC deposit' };
    }

    // Validate USDC asset with issuer
    const assetResult = validateContractAsset({
      code: 'USDC',
      type: 'credit_alphanum4',
      issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    });
    if (!assetResult || !assetResult.valid) {
      return { name, passed: false, error: 'Asset validation failed for USDC' };
    }

    return { name, passed: true };
  } catch (err) {
    return { name, passed: false, error: err.message };
  }
}

/**
 * Simulates that a paused contract blocks deposit.
 * This verifies the pause guard is present in the authorization policy.
 *
 * @returns {{ name: string, passed: boolean, error?: string }}
 */
function runPausedContractSimulation() {
  const name = 'paused-contract-blocks-deposit';
  try {
    const authResult = evaluateAuthorization({
      action: PRIVILEGED_ENTRY_POINTS.DEPOSIT,
      role: ROLES.PAYER,
      actor: 'GPAYER_SIM',
      isPaused: true,
    });

    if (authResult.authorized) {
      return {
        name,
        passed: false,
        error: 'Expected deposit to be blocked when contract is paused, but it was authorized',
      };
    }

    return { name, passed: true };
  } catch (err) {
    return { name, passed: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Runs all simulations and returns aggregated results.
 *
 * @returns {{ results: object[], passed: number, failed: number, total: number }}
 */
function runSimulations() {
  const simulations = [
    runDepositSimulation,
    runReleaseSimulation,
    runDisputeSimulation,
    runUsdcDepositSimulation,
    runPausedContractSimulation,
  ];

  const results = simulations.map(fn => fn());
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  return { results, passed, failed, total: results.length };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/* istanbul ignore next */
if (require.main === module) {
  console.log('=== Contract Simulation ===');
  console.log(`Network:           ${STELLAR_NETWORK}`);
  console.log(`Toolchain version: ${TOOLCHAIN_VERSION}`);
  console.log(`Schema version:    ${CURRENT_SCHEMA_VERSION}`);
  console.log('');

  const { results, passed, failed, total } = runSimulations();

  for (const result of results) {
    const icon = result.passed ? '✓' : '✗';
    const line = result.passed
      ? `  ${icon} ${result.name}`
      : `  ${icon} ${result.name}: ${result.error}`;
    console.log(line);
  }

  console.log('');
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);

  if (failed > 0) {
    console.error('Contract simulation FAILED.');
    process.exit(1);
  }

  console.log('Contract simulation PASSED.');
  process.exit(0);
}

module.exports = {
  TOOLCHAIN_VERSION,
  runSimulations,
  runDepositSimulation,
  runReleaseSimulation,
  runDisputeSimulation,
  runUsdcDepositSimulation,
  runPausedContractSimulation,
};
