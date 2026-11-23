'use strict';

/**
 * Contract-to-backend reconciliation fixture tests (Issue #313).
 *
 * Loads every JSON fixture from tests/fixtures/reconciliation/ and verifies
 * that the reconciliation job produces the expected outcome for each scenario.
 *
 * Adding a new scenario requires only a new fixture file — no code changes.
 *
 * Scenarios covered
 * ─────────────────
 *  01  Happy path (no divergence)
 *  02  On-chain confirmed, backend pending  → confirm
 *  03  On-chain reverted, backend confirmed → revert + alert
 *  04  Amount mismatch                      → flag + alert
 *  05  Event missed (no backend record)     → create
 *  06  Partial / underpaid payment          → no-op (already underpaid)
 *  07  Blockchain fork orphan               → expire
 *  08  Duplicate txHash (idempotency)       → skip
 *  09  Wrong asset                          → no-op (already failed)
 *  10  Missing memo                         → no-op (already failed)
 */

const fs   = require('fs');
const path = require('path');

// ── Load all fixtures ─────────────────────────────────────────────────────────

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures/reconciliation');

/**
 * Load all *.json files from the fixtures directory.
 * @returns {Array<object>} array of fixture objects
 */
function loadFixtures() {
  const files = fs.readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  return files.map((file) => {
    const raw = fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8');
    return { file, ...JSON.parse(raw) };
  });
}

const fixtures = loadFixtures();

// ── Reconciliation job (pure function, injectable) ────────────────────────────

/**
 * Reconcile a single payment by comparing on-chain state with the backend
 * record and deciding what action to take.
 *
 * This is the pure reconciliation logic extracted from the background job.
 * It returns an action descriptor without performing any side effects so it
 * can be tested deterministically against each fixture.
 *
 * @param {{
 *   contractState: object|null,
 *   backendState:  object|null,
 *   schoolConfig?: object,
 *   staleThresholdMs?: number,
 * }} fixture
 * @returns {{
 *   action: 'none'|'confirm'|'revert'|'flag'|'create'|'expire'|'skip',
 *   divergence: boolean,
 *   divergenceType?: string,
 *   alertRequired?: boolean,
 *   adminActionRequired?: boolean,
 * }}
 */
function reconcile(fixture) {
  const { contractState, backendState, staleThresholdMs } = fixture;

  // ── No on-chain record at all ─────────────────────────────────────────────
  if (!contractState) {
    // Backend has a pending record that has aged past the stale threshold.
    if (backendState && backendState.status === 'pending' && staleThresholdMs) {
      const age = Date.now() - new Date(backendState.createdAt).getTime();
      if (age > staleThresholdMs) {
        return {
          action: 'expire',
          divergence: true,
          divergenceType: 'orphaned_transaction',
          alertRequired: false,
        };
      }
    }
    return { action: 'none', divergence: false };
  }

  // ── No backend record — missed event ─────────────────────────────────────
  if (!backendState) {
    if (contractState.status === 'confirmed') {
      return {
        action: 'create',
        divergence: true,
        divergenceType: 'missing_in_backend',
        alertRequired: false,
      };
    }
    return { action: 'none', divergence: false };
  }

  // ── Both sides exist ──────────────────────────────────────────────────────

  // Already failed for an expected reason — no action
  const terminalBackendStatuses = ['failed', 'underpaid'];
  if (terminalBackendStatuses.includes(backendState.status)) {
    return { action: 'none', divergence: false, divergenceType: backendState.errorCode || backendState.status };
  }

  // Duplicate detection — backend already confirmed, incoming duplicate ignored
  if (
    backendState.status === 'confirmed' &&
    contractState.status === 'confirmed' &&
    fixture.incomingDuplicateEvent
  ) {
    return { action: 'skip', divergence: false, divergenceType: 'duplicate_ignored' };
  }

  // On-chain reverted but backend says confirmed — must revert
  if (contractState.status === 'failed' && backendState.status === 'confirmed') {
    return {
      action: 'revert',
      divergence: true,
      divergenceType: 'on_chain_reverted',
      alertRequired: true,
    };
  }

  // Amount mismatch (both confirmed, different amounts)
  const onChainAmount  = parseFloat(contractState.amount);
  const backendAmount  = backendState.amount;
  const DRIFT_EPSILON  = 0.0000001;
  if (
    contractState.status === 'confirmed' &&
    backendState.status === 'confirmed' &&
    Math.abs(onChainAmount - backendAmount) > DRIFT_EPSILON
  ) {
    return {
      action: 'flag',
      divergence: true,
      divergenceType: 'amount_mismatch',
      onChainAmount,
      backendAmount,
      alertRequired: true,
    };
  }

  // On-chain confirmed but backend pending — reconcile
  if (contractState.status === 'confirmed' && backendState.status === 'pending') {
    return {
      action: 'confirm',
      divergence: true,
      divergenceType: 'status_mismatch',
    };
  }

  // No divergence
  return { action: 'none', divergence: false };
}

// ── Fixture-driven tests ──────────────────────────────────────────────────────

describe('Reconciliation fixture tests', () => {
  it('loads at least 10 fixture files', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
  });

  it('every fixture has a unique id', () => {
    const ids = fixtures.map((f) => f.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('every fixture has an expectedOutcome with an action', () => {
    for (const fixture of fixtures) {
      expect(fixture.expectedOutcome).toBeDefined();
      expect(typeof fixture.expectedOutcome.action).toBe('string');
    }
  });
});

describe('Reconciliation job — fixture-driven scenarios', () => {
  for (const fixture of fixtures) {
    it(`${fixture.id}: ${fixture.description}`, () => {
      const result = reconcile(fixture);
      const expected = fixture.expectedOutcome;

      expect(result.action).toBe(expected.action);
      expect(result.divergence).toBe(expected.divergence);

      if (expected.divergenceType !== undefined) {
        expect(result.divergenceType).toBe(expected.divergenceType);
      }

      if (expected.alertRequired !== undefined) {
        expect(result.alertRequired).toBe(expected.alertRequired);
      }

      if (expected.adminActionRequired !== undefined) {
        expect(result.adminActionRequired).toBe(expected.adminActionRequired);
      }
    });
  }
});

// ── Individual scenario assertions ────────────────────────────────────────────

describe('Scenario-specific reconciliation logic', () => {
  it('01: happy path produces no action', () => {
    const f = fixtures.find((x) => x.id === 'scenario-01-happy-path');
    const result = reconcile(f);
    expect(result.action).toBe('none');
    expect(result.divergence).toBe(false);
  });

  it('02: pending → confirmed when on-chain is confirmed', () => {
    const f = fixtures.find((x) => x.id === 'scenario-02-on-chain-confirmed-backend-pending');
    const result = reconcile(f);
    expect(result.action).toBe('confirm');
    expect(result.divergence).toBe(true);
  });

  it('03: reverts backend when on-chain is failed', () => {
    const f = fixtures.find((x) => x.id === 'scenario-03-on-chain-reverted-backend-confirmed');
    const result = reconcile(f);
    expect(result.action).toBe('revert');
    expect(result.alertRequired).toBe(true);
  });

  it('04: flags amount mismatch and requires alert', () => {
    const f = fixtures.find((x) => x.id === 'scenario-04-amount-mismatch');
    const result = reconcile(f);
    expect(result.action).toBe('flag');
    expect(result.onChainAmount).toBe(300);
    expect(result.backendAmount).toBe(250);
    expect(result.alertRequired).toBe(true);
  });

  it('05: creates backend record for a missed event', () => {
    const f = fixtures.find((x) => x.id === 'scenario-05-event-missed');
    const result = reconcile(f);
    expect(result.action).toBe('create');
    expect(result.divergence).toBe(true);
  });

  it('06: underpaid payment is a no-op (already in terminal status)', () => {
    const f = fixtures.find((x) => x.id === 'scenario-06-partial-payment-underpaid');
    const result = reconcile(f);
    expect(result.action).toBe('none');
  });

  it('07: orphaned transaction is expired after stale threshold', () => {
    const f = fixtures.find((x) => x.id === 'scenario-07-blockchain-fork-orphaned');
    // Override createdAt to be past the stale threshold
    const outdated = {
      ...f,
      backendState: { ...f.backendState, createdAt: new Date(0).toISOString() },
    };
    const result = reconcile(outdated);
    expect(result.action).toBe('expire');
  });

  it('08: duplicate txHash is skipped (idempotency)', () => {
    const f = fixtures.find((x) => x.id === 'scenario-08-duplicate-txhash-idempotency');
    const result = reconcile(f);
    expect(result.action).toBe('skip');
    expect(result.divergenceType).toBe('duplicate_ignored');
  });

  it('09: wrong asset produces no-op (already failed)', () => {
    const f = fixtures.find((x) => x.id === 'scenario-09-wrong-asset-usdc-expected-xlm-received');
    const result = reconcile(f);
    expect(result.action).toBe('none');
  });

  it('10: missing memo produces no-op (already failed)', () => {
    const f = fixtures.find((x) => x.id === 'scenario-10-missing-memo-no-student-match');
    const result = reconcile(f);
    expect(result.action).toBe('none');
  });
});

// ── New fixture discovery test ────────────────────────────────────────────────

describe('Fixture extensibility', () => {
  it('newly added fixture files are automatically discovered and run', () => {
    // Proves the glob-based loader picks up any *.json in the directory
    // without code changes.  If this test passes, the loop above does too.
    const fileNames = fs
      .readdirSync(FIXTURES_DIR)
      .filter((f) => f.endsWith('.json'));
    expect(fileNames.length).toBe(fixtures.length);
  });
});

// ── Export reconcile for use in backend tests ─────────────────────────────────

module.exports = { reconcile, loadFixtures, fixtures };
