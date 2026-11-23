# Smart-Contract Threat Model

> **Issue:** [#301 — Create comprehensive smart contract threat model](https://github.com/onlyonee1/PaymentFlow/issues/301)
> **Status:** Active — updated as new threats are identified
> **Author:** Platform Engineering
> **Last updated:** 2026-10-20

This document applies a trust-boundary analysis to PaymentFlow's Stellar on-chain
integration and the planned Soroban escrow contract. It supplements the existing
API-level threat model (`docs/threat-model.md`) with threats that are specific to
smart-contract and blockchain primitives.

---

## Table of Contents

- [Scope](#scope)
- [Trust Boundary Diagram](#trust-boundary-diagram)
- [Assumptions About Stellar Primitives](#assumptions-about-stellar-primitives)
- [Threat Catalogue](#threat-catalogue)
  - [SC-01 Signer Key Compromise](#sc-01-signer-key-compromise)
  - [SC-02 Transaction Replay](#sc-02-transaction-replay)
  - [SC-03 Memo Replay and Collision](#sc-03-memo-replay-and-collision)
  - [SC-04 Authorization Bypass (Off-Chain)](#sc-04-authorization-bypass-off-chain)
  - [SC-05 Asset Confusion and USDC Issuer Spoofing](#sc-05-asset-confusion-and-usdc-issuer-spoofing)
  - [SC-06 Confirmation Threshold Manipulation](#sc-06-confirmation-threshold-manipulation)
  - [SC-07 Denial of Service via Horizon or Queue Flooding](#sc-07-denial-of-service-via-horizon-or-queue-flooding)
  - [SC-08 Upgrade Risk (SDK and Network)](#sc-08-upgrade-risk-sdk-and-network)
  - [SC-09 Soroban Contract Authorization Bypass](#sc-09-soroban-contract-authorization-bypass)
  - [SC-10 Soroban Contract Replay (Escrow Double-Deposit)](#sc-10-soroban-contract-replay-escrow-double-deposit)
  - [SC-11 Soroban Contract Denial of Service (Storage Bloat)](#sc-11-soroban-contract-denial-of-service-storage-bloat)
  - [SC-12 Underpaid / Overpaid Exploitation](#sc-12-underpaid--overpaid-exploitation)
  - [SC-13 Source Wallet Impersonation](#sc-13-source-wallet-impersonation)
  - [SC-14 Cross-School Memo Collision](#sc-14-cross-school-memo-collision)
  - [SC-15 Finality State Machine Regression](#sc-15-finality-state-machine-regression)
- [Risk Matrix](#risk-matrix)
- [High-Risk Items to Test Mapping](#high-risk-items-to-test-mapping)
- [Incident Response Playbooks](#incident-response-playbooks)
  - [PLAY-01 Signer Key Compromise Detected](#play-01-signer-key-compromise-detected)
  - [PLAY-02 Smart Contract Authorization Exploit](#play-02-smart-contract-authorization-exploit)
  - [PLAY-03 Mass Memo Collision or Spoofing Campaign](#play-03-mass-memo-collision-or-spoofing-campaign)
  - [PLAY-04 Horizon Outage or Sustained Sync Failure](#play-04-horizon-outage-or-sustained-sync-failure)
  - [PLAY-05 Escrow Funds Frozen (Dispute Dead-Lock)](#play-05-escrow-funds-frozen-dispute-dead-lock)
  - [PLAY-06 Contract Upgrade Gone Wrong](#play-06-contract-upgrade-gone-wrong)
  - [PLAY-07 USDC Issuer Address Stale or Spoofed](#play-07-usdc-issuer-address-stale-or-spoofed)
- [Residual Risk Summary](#residual-risk-summary)

---

## Scope

**In scope:**

- Backend's read-only Stellar Horizon integration (transaction polling, verification)
- Memo-based student payment matching
- Fee validation, amount limits, cumulative balance logic
- Confirmation state machine (detected → pending → confirmed → finalized)
- Fraud detection (memo collision, abnormal amount/velocity)
- Source validation rules
- Soroban escrow contract functions (deposit, release, cancel, dispute, resolveDispute)
- Stellar signing key management (refund and setup transactions only)
- On-chain/off-chain state boundary

**Out of scope (covered in `docs/threat-model.md`):**

- JWT authentication and session management
- Webhook HMAC replay protection
- Tenant isolation and cross-tenant data access
- Admin RBAC and step-up authentication

---

## Trust Boundary Diagram

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  TRUST BOUNDARY A: Internet / Public Stellar Network                        ║
║                                                                              ║
║  ┌──────────────────┐       ┌──────────────────────────────────────────┐    ║
║  │  Parent Wallet   │──────►│  Stellar Ledger (public, immutable)       │    ║
║  │  (untrusted)     │  XLM/ │  • txHash, ledger, memo, amount, asset   │    ║
║  └──────────────────┘  USDC │  • senderAddress, successful flag        │    ║
║                        +    └────────────────────┬─────────────────────┘    ║
║                        memo                      │ Horizon API (read)       ║
╚══════════════════════════════════════════════════╪═════════════════════════╝
                                                   │
╔══════════════════════════════════════════════════╪═════════════════════════╗
║  TRUST BOUNDARY B: Backend Process               │                         ║
║                                                  │                         ║
║  ┌───────────────────────────────────────────────▼──────────────────────┐  ║
║  │  transactionPollingService / paymentController                        │  ║
║  │                                                                        │  ║
║  │  extractValidPayment()     — filters out failed/memo-less/wrong-asset  │  ║
║  │  validatePaymentAmount()   — min/max limits                            │  ║
║  │  validatePaymentAgainstFee() — fee comparison                         │  ║
║  │  detectMemoCollision()     — sender impersonation guard               │  ║
║  │  detectAbnormalPatterns()  — velocity / amount anomaly                │  ║
║  │  determineConfirmationState() — finality state machine                │  ║
║  └──────────────────────────────────────┬─────────────────────────────── ┘  ║
║                                         │ atomic session.withTransaction()  ║
╚═════════════════════════════════════════╪═══════════════════════════════════╝
                                          │
╔═════════════════════════════════════════╪═══════════════════════════════════╗
║  TRUST BOUNDARY C: Database (MongoDB)   │                                   ║
║                                         ▼                                   ║
║  Payment | Student | PaymentIntent | AuditLog | IdempotencyKey              ║
╚══════════════════════════════════════════════════════════════════════════════╝

╔══════════════════════════════════════════════════════════════════════════════╗
║  TRUST BOUNDARY D: Soroban Contract (on-chain, when deployed)               ║
║                                                                              ║
║  deposit() / release() / dispute() / resolveDispute() / cancel()           ║
║  Contract enforces: authorization, state transitions, amount transfers      ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

---

## Assumptions About Stellar Primitives

The mitigations in this document rely on the following properties of the
Stellar protocol. If these assumptions change, the mitigations must be re-evaluated.

| ID | Assumption | Source |
|---|---|---|
| P1 | Transactions are final within 3–5 seconds (one ledger close). Rollbacks do not occur after ledger close. | [Stellar Consensus Protocol](https://developers.stellar.org/docs/learn/fundamentals/stellar-consensus-protocol) |
| P2 | Transaction hashes (`txHash`) are globally unique across all time. | Stellar protocol — hash is SHA-256 of the transaction XDR |
| P3 | `MEMO_TEXT` is capped at 28 bytes. The Stellar SDK and network reject longer memos. | Stellar documentation |
| P4 | The Horizon API returns transactions in a consistent, pageable order. `cursor`-based pagination is stable. | Horizon API docs |
| P5 | Stellar account sequence numbers are monotonically increasing. A transaction with a stale sequence number is rejected with `tx_bad_seq`. | Stellar protocol |
| P6 | Time-bounded transactions (`maxTime`) are rejected by the network after the timestamp passes, even if previously submitted. | Stellar protocol |
| P7 | The USDC issuer address is controlled by Circle. A USDC token from a different issuer is a distinct asset. Stellar does not merge assets with the same code but different issuers. | [Circle USDC on Stellar](https://developers.circle.com/stablecoins/usdc-on-stellar) |
| P8 | Soroban contract invocations require a valid account signature from an authorized invoker. The contract's `require_auth()` is enforced at the protocol level. | [Soroban Auth docs](https://developers.stellar.org/docs/build/smart-contracts/example-contracts/auth) |
| P9 | Soroban contract storage (persistent, temporary, instance) has a per-entry TTL. Entries that expire are no longer accessible. | Soroban protocol |
| P10 | Ledger sequence numbers increment by exactly 1 per closed ledger. They cannot be reset or manipulated by any individual participant. | Stellar protocol |

---

## Threat Catalogue

---

### SC-01 Signer Key Compromise

**Category:** Spoofing / Tampering

**Description:** The school's Stellar private key is compromised, allowing an
attacker to submit outgoing transactions (refunds, account setup, or fund sweeps)
from the school wallet. For the polling/read-only path this risk is minimal because
the backend never holds the school's key. The risk is elevated for deployments that
use `StellarTransactionManager` for outgoing refunds.

**Attack scenario:**
- Attacker gains access to the server's environment variables or secret store.
- Extracts the encrypted signer key from the database and brute-forces or steals the
  master encryption key.
- Submits unauthorized XLM/USDC transfers out of the school wallet.

**Current mitigations:**

| Mitigation | Code location |
|---|---|
| Backend never holds school key for payment receiving | `backend/src/services/stellarService.js` — read-only |
| Signer key encrypted at rest with `SIGNER_MASTER_KEY` (AES-256-GCM) | `backend/src/utils/signerKeyManager.js` |
| Master key can be sourced from AWS Secrets Manager or HTTP vault | `backend/src/utils/signerKeyManager.js` — `SIGNER_KEY_SOURCE` |
| Staged two-phase key rotation with dual-key grace period | `scripts/rotate-signer-key-staged.js` |
| CI scans every tracked file for raw Stellar `S…` secret keys | `scripts/scan-repo-secrets.js`, `.github/workflows/ci.yml` |

**Assumptions relied upon:** P1 (finality — submitted transactions cannot be recalled).

**Residual risk:** An attacker with simultaneous access to the encrypted key in
MongoDB AND the master encryption key can submit outgoing transactions. Detection
relies on monitoring outgoing Horizon transactions not initiated by the system.

**Residual risk owner:** Platform Operator.

---

### SC-02 Transaction Replay

**Category:** Tampering / Repudiation

**Description:** An attacker attempts to replay a previously valid transaction hash
to credit a student's account a second time.

**Attack scenario:**
- A genuine payment `txHash=abc123` is recorded for student `STU-001`.
- Attacker calls `POST /api/payments/verify` again with the same `txHash`.

**Current mitigations:**

| Mitigation | Code location |
|---|---|
| `Payment.txHash` has a unique MongoDB index; duplicate inserts fail | `backend/src/models/paymentModel.js` |
| Sync loop checks `Payment.findOne({ txHash })` before processing | `backend/src/services/stellarService.js` — `syncPaymentsForSchool` |
| `IdempotencyKey` model prevents duplicate API requests within TTL | `backend/src/services/idempotencyStore.js` |
| PaymentIntent transitions to `completed` on first successful match | `backend/src/services/stellarService.js` |

**Assumptions relied upon:** P2 (unique txHash — the same Stellar transaction hash
cannot correspond to two distinct on-chain events).

**Residual risk:** Negligible at the database level. The only remaining surface is
a race condition between two concurrent sync workers on the same transaction —
mitigated by the distributed lock in `transactionPollingDistributedLock`.

**Residual risk owner:** Platform Operator.

---

### SC-03 Memo Replay and Collision

**Category:** Spoofing / Tampering

**Description:** An attacker sends a payment with a valid student ID as the memo
from a different wallet address, attempting to credit a different student or
hijack an in-flight payment intent.

**Attack scenarios:**
- Attacker observes a pending PaymentIntent for `memo=STU-001`, sends a payment
  for the same memo from their own wallet, hoping to record a fraudulent payment.
- Two payments for the same memo arrive within a short window, one from the legitimate
  parent and one from an attacker.

**Current mitigations:**

| Mitigation | Code location |
|---|---|
| `detectMemoCollision`: flags `isSuspicious=true` if same memo arrives from different sender within 24 hours | `backend/src/services/stellarService.js` |
| Suspicious payments are recorded but `feePaid` is NOT updated | `backend/src/services/stellarService.js` — `syncPaymentsForSchool` |
| Admin review required before suspicious payment takes effect | Admin dashboard + audit log |
| PaymentIntent is school-scoped: `findOne({ schoolId, memo, status: 'pending' })` | `backend/src/services/stellarService.js` |

**Assumptions relied upon:** P3 (memo uniqueness within a window is detectable
because the sender address is part of the Stellar transaction record).

**Residual risk:** A sophisticated attacker who knows the exact expected sender address
(or colludes with the parent) can avoid triggering the collision detection. The
`detectAbnormalPatterns` velocity check (`>3 payments in 10 minutes`) provides a
secondary signal.

**Residual risk owner:** School Admin (responsible for reviewing suspicious payments).

---

### SC-04 Authorization Bypass (Off-Chain)

**Category:** Elevation of Privilege

**Description:** A non-admin user attempts to call payment verification, sync, or
student update endpoints without proper authorization.

**Current mitigations:**

| Mitigation | Code location |
|---|---|
| `requireSchoolAuth` middleware gates all payment and student routes | `backend/src/middleware/auth.js` |
| Role-based access: `owner` / `finance` / `viewer` hierarchy | `backend/src/middleware/auth.js` |
| Step-up authentication for sensitive admin operations | `backend/src/middleware/stepUpAuth.js` |
| `schoolId` always derived from authenticated JWT, not request body | `backend/src/middleware/schoolContext.js` |

**Residual risk:** Stolen JWT allows full access until token expiry. Mitigated by
short TTL access tokens and HttpOnly refresh token cookies.

**Residual risk owner:** Platform Operator.

---

### SC-05 Asset Confusion and USDC Issuer Spoofing

**Category:** Tampering

**Description:** An attacker creates a token with asset code `USDC` but issued
from a different account, and sends it as payment, hoping the backend records it
as legitimate USDC.

**Attack scenarios:**
- Attacker issues a custom `USDC` token from a self-controlled account and sends it.
- Attacker sends XLM when the school only accepts USDC, or vice versa.
- Attacker sends a path-payment that converts an arbitrary asset to USDC mid-path,
  but the on-chain operation type is `path_payment_strict_receive`.

**Current mitigations:**

| Mitigation | Code location |
|---|---|
| `isAcceptedAsset` checks `asset_code` AND `asset_type` AND `asset_issuer` | `backend/src/config/stellarConfig.js` |
| USDC issuer pinned per network (testnet/mainnet addresses hard-coded) | `backend/src/config/index.js` |
| `extractValidPayment` only considers `type === 'payment'` operations (not path payments) | `backend/src/services/stellarService.js` |
| Transactions using any other asset are silently skipped | `backend/src/services/stellarService.js` |

**Assumptions relied upon:** P7 (issuer identity — Stellar distinguishes USDC from
`GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` from any other USDC-code token).

**Residual risk:** If the pinned USDC issuer address is ever replaced by Circle
(mainnet), the `USDC_ISSUER` env var must be updated. Stale configuration would
reject legitimate USDC payments.

**Residual risk owner:** Platform Operator (must track Circle USDC issuer changes).

---

### SC-06 Confirmation Threshold Manipulation

**Category:** Tampering

**Description:** An attacker attempts to game the confirmation state machine by
exploiting re-poll idempotency or triggering state regression.

**Attack scenarios:**
- Attacker triggers rapid re-polls hoping to regress a `confirmed` payment back to `pending`.
- Attacker exploits a race condition between two workers processing the same transaction.

**Current mitigations:**

| Mitigation | Code location |
|---|---|
| `resolveNextState`: terminal states (`finalized`, `failed`) have no outgoing transitions | `backend/src/services/paymentConfirmationStateMachine.js` |
| A target state that does not outrank the current state is a no-op | `paymentConfirmationStateMachine.js` — `resolveNextState` |
| `computeTargetState` is a pure function — same inputs always yield same output | `paymentConfirmationStateMachine.js` |
| Distributed lock on sync prevents concurrent workers on same school | `backend/src/services/transactionPollingDistributedLock.js` (tested in `tests/transactionPollingDistributedLock.test.js`) |

**Assumptions relied upon:** P1 (finality — ledger sequence numbers only increase,
so computed confirmation depth is monotonically non-decreasing for any given transaction).

**Residual risk:** Negligible for confirmed/finalized states. A `pending` payment
that has not yet crossed `CONFIRMATION_THRESHOLD` remains vulnerable to being
observed as suspicious on re-poll (which is the intended behaviour, not a vulnerability).

**Residual risk owner:** Platform Operator.

---

### SC-07 Denial of Service via Horizon or Queue Flooding

**Category:** Denial of Service

**Description:** Horizon becomes unavailable or the transaction queue is flooded,
preventing legitimate payments from being processed.

**Attack scenarios:**
- Stellar network congestion causes Horizon to return 429 or 5xx responses.
- An attacker sends thousands of spam transactions to the school wallet with random
  memos, flooding the sync loop with transactions that all fail the PaymentIntent
  lookup.
- Redis becomes unavailable, causing the BullMQ retry queue to stop functioning.

**Current mitigations:**

| Mitigation | Code location |
|---|---|
| `withStellarRetry`: exponential backoff + jitter on transient Horizon errors | `backend/src/utils/withStellarRetry.js` |
| `stellarRateLimitedClient`: Bottleneck rate limiter respects Horizon quotas | `backend/src/services/stellarRateLimitedClient.js` |
| Circuit breaker on Horizon client; degrades gracefully on sustained outage | `backend/src/services/horizonFailoverClient.js` |
| Horizon failover to secondary URLs | `backend/src/services/horizonFailoverClient.js` |
| BullMQ gracefully degrades to MongoDB retry backend when Redis unavailable | `backend/src/services/retryServiceSelector.js` |
| Spam transactions with unknown memos are silently skipped (no DB write) | `backend/src/services/stellarService.js` — PaymentIntent lookup |
| `horizonPollBudget` limits maximum time spent per poll cycle | `backend/src/services/horizonPollBudget.js` |

**Residual risk:** A sustained Horizon outage of >15 minutes triggers a degraded
health check. Payments during the outage are re-queued for retry but may be delayed.
Spam transaction flooding increases CPU usage of the sync loop proportionally to
the number of spam transactions on the school wallet.

**Residual risk owner:** Platform Operator (Horizon availability), School Admin
(wallet spam — mitigated by rate limiting at the Stellar protocol level).

---

### SC-08 Upgrade Risk (SDK and Network)

**Category:** Tampering / Denial of Service

**Description:** A Stellar SDK upgrade, Horizon API change, or network protocol
upgrade (e.g. testnet → mainnet migration, CAP rollout) introduces breaking changes.

**Attack scenarios:**
- Stellar SDK v12 → v13 changes transaction parsing, causing `extractValidPayment`
  to silently skip all transactions.
- A network upgrade changes the finality model, invalidating `CONFIRMATION_THRESHOLD`.
- A Horizon API deprecation removes an endpoint or changes pagination semantics.

**Current mitigations:**

| Mitigation | Code location |
|---|---|
| `STELLAR_NETWORK` env var controls all network-specific config (issuer, Horizon URL) | `backend/src/config/index.js` |
| SDK version pinned in `package.json` (`@stellar/stellar-sdk`) | `backend/package.json` |
| CI dependency audit catches known vulnerabilities | `scripts/check-dependency-audit.js` |
| Integration tests validate transaction parsing against a live testnet | `tests/stellar.integration.test.js` |
| Horizon poll budget test validates poll loop timing assumptions | `tests/issue-1124-horizon-poll-budget.test.js` |

**Assumptions relied upon:** P4 (Horizon pagination stability — if Horizon changes
its pagination contract, the sync loop's early-termination logic may break).

**Residual risk:** A silent breaking change in Horizon's response schema could cause
transactions to be skipped without errors. Monitoring `lastSyncAt` staleness (alert
threshold: 5 minutes) would detect this within one poll cycle.

**Residual risk owner:** Platform Operator (must track Stellar SDK changelogs and
Horizon API deprecation notices).

**Upgrade and pause controls (Issue #61):** Explicit, least-privilege upgrade and
pause controls are now defined in `backend/src/services/contractUpgradeControls.js`:
- Only OWNER may propose or execute an upgrade; OPERATOR may pause but not unpause.
- Upgrades require a multi-sig quorum (`UPGRADE_QUORUM = 2`) to prevent single-key unilateral deployment.
- All upgrade proposals, approvals, and rollbacks are recorded for audit purposes.
- Recovery procedures for upgrade failures and key loss are documented in
  `docs/runbooks/contract-upgrade-failure.md`.

---

### SC-09 Soroban Contract Authorization Bypass

**Category:** Elevation of Privilege

**Description:** An unauthorized account calls a restricted Soroban escrow function
(e.g. `release()` as a non-beneficiary, `resolveDispute()` as a non-arbiter).

**Attack scenarios:**
- Attacker calls `release(escrow_id)` from an arbitrary account, hoping to trigger
  fund release to themselves.
- Attacker calls `resolveDispute(escrow_id, "refund")` claiming to be the arbiter.

**Current mitigations:**

| Mitigation | Code location / requirement |
|---|---|
| Contract enforces `require_auth(beneficiary)` on `release()` | `docs/soroban-escrow-requirements.md` — SC-09 |
| Contract enforces `require_auth(arbiter)` on `resolveDispute()` | `docs/soroban-escrow-requirements.md` |
| Stellar protocol enforces `require_auth()` at the VM level (P8) | Soroban protocol |
| All addresses are set at deposit time and immutable for the escrow's lifetime | Contract storage |

**Assumptions relied upon:** P8 (Soroban `require_auth()` is enforced at the
protocol level and cannot be bypassed by any caller).

**Residual risk:** If the arbiter account's key is compromised, the attacker can
resolve disputes arbitrarily. Mitigated by requiring multi-sig on the arbiter account
(recommendation, not yet enforced in v1).

**Residual risk owner:** Platform Operator (arbiter key management).

---

### SC-10 Soroban Contract Replay (Escrow Double-Deposit)

**Category:** Tampering

**Description:** An attacker attempts to deposit funds twice for the same
`(schoolId, memo)` combination, creating two active escrows for the same student.

**Current mitigations:**

| Mitigation | Code location / requirement |
|---|---|
| Contract checks for existing non-terminal escrow with same `(schoolId, memo)` before accepting `deposit()` | `docs/soroban-escrow-requirements.md` — deduplication |
| Returns `EscrowAlreadyExists` error on duplicate | Contract function spec |
| Backend `PaymentIntent` is also checked for `status: 'pending'` | `backend/src/services/stellarService.js` |

**Assumptions relied upon:** P9 (contract persistent storage TTL — old completed
escrow records must not expire before the deduplication window closes).

**Residual risk:** If a completed escrow's storage entry expires from Soroban
persistent storage before the corresponding PaymentIntent's backend TTL, a new
deposit for the same memo could be created after expiry. Mitigation: set contract
storage TTL well above the PaymentIntent TTL.

**Residual risk owner:** Platform Operator (contract storage TTL configuration).

---

### SC-11 Soroban Contract Denial of Service (Storage Bloat)

**Category:** Denial of Service

**Description:** An attacker creates many escrow deposits with random memos, bloating
the contract's persistent storage and increasing rent fees.

**Current mitigations:**

| Mitigation | Code location / requirement |
|---|---|
| `deposit()` requires valid Payer authorization (cannot be called without a funded account) | Soroban protocol (P8) |
| Stellar accounts require a minimum XLM balance (base reserve), limiting the number of disposable accounts an attacker can create | Stellar protocol |
| Contract storage TTL on completed/terminal escrows limits long-term growth | `docs/soroban-escrow-requirements.md` |

**Residual risk:** A well-funded attacker with many disposable Stellar accounts
can still create many active escrows. Rate limiting at the API level (PaymentIntent
creation rate) provides a secondary guard.

**Residual risk owner:** Platform Operator.

---

### SC-12 Underpaid / Overpaid Exploitation

**Category:** Tampering

**Description:** An attacker sends an amount just barely above the minimum payment
amount (`MIN_PAYMENT_AMOUNT`) to record a payment without covering the actual fee,
or sends a very large overpayment hoping the reconciliation marks the student as
fully paid.

**Attack scenarios:**
- Parent sends `0.01 XLM` (min amount) for a `500 XLM` fee, hoping `feePaid` is set.
- Parent sends `10,000 XLM` for a `100 XLM` fee — the excess is not automatically
  refunded and may cause an accounting discrepancy.

**Current mitigations:**

| Mitigation | Code location |
|---|---|
| `validatePaymentAgainstFee` returns `'underpaid'` status; `feePaid` is NOT set for underpaid payments until cumulative total reaches `feeAmount` | `backend/src/services/stellarService.js` |
| `feeValidationStatus: 'underpaid'` recorded; student's `remainingBalance` updated | `backend/src/services/stellarService.js` |
| Overpayment: `feePaid = true` but `excessAmount` is recorded; admin is notified | `backend/src/services/stellarService.js` |
| `detectAbnormalPatterns`: flags payments more than 3× the expected fee | `backend/src/services/stellarService.js` |
| `MAX_PAYMENT_AMOUNT` limit rejects extreme overpayments | `backend/src/services/paymentLimitsService.js` |

**Residual risk:** Underpaid payments accumulate toward the fee. A parent who sends
many tiny payments (all above `MIN_PAYMENT_AMOUNT`) will eventually reach the fee
threshold, but each individual payment is legitimate.

**Residual risk owner:** School Admin (monitors `feeValidationStatus: 'underpaid'` queue).

---

### SC-13 Source Wallet Impersonation

**Category:** Spoofing

**Description:** A payment is sent from an unexpected or blacklisted wallet address,
bypassing source validation rules.

**Current mitigations:**

| Mitigation | Code location |
|---|---|
| `sourceValidationRules` model: per-school allowlist/denylist of sender addresses | `backend/src/models/sourceValidationRuleModel.js` |
| Validation checked during sync before recording the payment | `backend/src/services/stellarService.js` |
| Source validation rules are school-scoped and admin-managed | `backend/src/routes/sourceValidationRuleRoutes.js` |

**Assumptions relied upon:** Stellar account address authenticity — `tx.source_account`
is cryptographically bound to the account that signed the transaction (P8 analog for
Classic transactions).

**Residual risk:** Source validation is opt-in per school. Schools that have not
configured any rules accept payments from any sender. Memo collision detection
provides a second layer for schools without source rules.

**Residual risk owner:** School Admin (source validation rule configuration).

---

### SC-14 Cross-School Memo Collision

**Category:** Information Disclosure / Spoofing

**Description:** Two schools assign the same student ID to different students. A
payment intended for School A's `STU-001` is potentially confused with School B's
`STU-001`.

**Current mitigations:**

| Mitigation | Code location |
|---|---|
| PaymentIntent lookup is school-scoped: `findOne({ schoolId, memo })` | `backend/src/services/stellarService.js` |
| `detectCrossSchoolMemoCollision`: flags payments where same memo was paid to a different school within 24 hours | `backend/src/services/stellarService.js` |
| Each school has a distinct wallet address; a payment must be directed to the correct school wallet | Trust boundary — school wallet scoping |

**Assumptions relied upon:** The school wallet address is always validated as the
`payOp.to` address, so a transaction directed to School A's wallet can never satisfy
a PaymentIntent for School B, regardless of memo.

**Residual risk:** Negligible for correct payment. The cross-school collision flag is
a monitoring signal rather than a security control, since the destination wallet
already provides isolation.

**Residual risk owner:** Platform Operator (cross-school memo monitoring).

---

### SC-15 Finality State Machine Regression

**Category:** Tampering

**Description:** A bug in state machine transitions or a concurrent worker race
causes a `confirmed` or `finalized` payment to regress to `pending`, causing the
student's `feePaid` flag to be incorrectly cleared.

**Current mitigations:**

| Mitigation | Code location |
|---|---|
| `resolveNextState` enforces forward-only transitions; terminal states are immutable | `backend/src/services/paymentConfirmationStateMachine.js` |
| `computeTargetState` is a pure function with no side effects | `paymentConfirmationStateMachine.js` |
| Distributed lock on the polling service prevents concurrent workers | `backend/src/services/transactionPollingDistributedLock.js` |
| `feePaid` is only cleared by an explicit admin action (not by state machine transitions) | `backend/src/services/stellarService.js` |

**Residual risk:** Negligible. The state machine's terminal-state guarantee and
forward-only transition rules make regression impossible at the code level.

**Residual risk owner:** Platform Operator.

---

## Risk Matrix

| ID | Threat | Likelihood | Impact | Risk Level |
|---|---|---|---|---|
| SC-01 | Signer Key Compromise | Low | Critical | **High** |
| SC-02 | Transaction Replay | Very Low | High | Medium |
| SC-03 | Memo Replay and Collision | Medium | High | **High** |
| SC-04 | Authorization Bypass (Off-Chain) | Low | High | Medium |
| SC-05 | Asset Confusion / USDC Issuer Spoof | Low | High | Medium |
| SC-06 | Confirmation Threshold Manipulation | Very Low | Medium | Low |
| SC-07 | DoS via Horizon / Queue Flooding | Medium | Medium | Medium |
| SC-08 | Upgrade Risk | Low | High | Medium |
| SC-09 | Soroban Contract Auth Bypass | Low | Critical | **High** |
| SC-10 | Soroban Contract Replay | Low | Medium | Medium |
| SC-11 | Soroban Contract Storage Bloat | Low | Low | Low |
| SC-12 | Underpaid / Overpaid Exploitation | Medium | Medium | Medium |
| SC-13 | Source Wallet Impersonation | Medium | Medium | Medium |
| SC-14 | Cross-School Memo Collision | Low | Low | Low |
| SC-15 | Finality State Machine Regression | Very Low | High | Low |

**Risk levels:** High (immediate attention required), Medium (address in next sprint),
Low (monitor and review annually).

---

## High-Risk Items to Test Mapping

| Risk ID | Test files |
|---|---|
| SC-01 (Signer Key Compromise) | `tests/rotateSignerStagedKey.test.js`, `tests/rotateSignerMasterKey.test.js`, `tests/scanRepoSecrets.test.js` |
| SC-03 (Memo Collision) | `tests/issue-1271-detect-memo-collision.test.js`, `tests/stellar.test.js` |
| SC-05 (Asset Confusion) | `tests/usdcIssuerValidation.test.js`, `tests/multi-asset-support.test.js`, `tests/payment-instructions-asset-validation.test.js` |
| SC-07 (DoS / Queue Flooding) | `tests/stellarRateLimitedClient.test.js`, `tests/withStellarRetryCircuitBreaker.test.js`, `tests/issue-1124-horizon-poll-budget.test.js`, `tests/transactionQueueDurability.test.js` |
| SC-09 (Soroban Auth Bypass) | To be added when contract is implemented |
| SC-12 (Underpaid/Overpaid) | `tests/issues-903-overpayment.test.js`, `tests/underpaidReconciliationPaymentPlans.test.js`, `tests/partialPaymentStatus.test.js` |
| SC-13 (Source Validation) | `tests/sourceValidationRules.test.js` |
| SC-02 (Replay) | `tests/payment-idempotency.test.js`, `tests/transactionAtomicity.test.js` |
| SC-06 (Finality Machine) | `backend/tests/paymentConfirmationStateMachine.test.js`, `backend/tests/confirmationStateRepollAndCrossSchoolCollision.test.js` |

---

---

## Incident Response Playbooks

These playbooks answer the question *"what do we do if X happens?"* for each
high-impact threat. Each playbook follows the same structure:

1. **Detection** — how we know the incident is happening
2. **Immediate containment** — actions taken within the first 15 minutes
3. **Investigation** — evidence gathering and scope determination
4. **Remediation** — permanent fix or workaround
5. **Post-incident** — review and hardening

Severity definitions:

| Severity | Definition |
|---|---|
| **P0 — Critical** | Funds at risk or already lost; student records corrupted |
| **P1 — High** | Payment processing blocked for >15 minutes; data integrity risk |
| **P2 — Medium** | Degraded functionality; no immediate fund or data risk |

---

### PLAY-01 Signer Key Compromise Detected

**Relates to:** SC-01
**Severity:** P0 — funds at risk

**Detection signals:**
- Unexpected outgoing transactions on the school wallet detected by Horizon monitoring
- Secret-scan CI alert fires on a pushed commit or secret management alert
- AWS Secrets Manager access log shows unexpected access pattern
- Admin receives Stellar network confirmation for a transaction they did not initiate

**Immediate containment (< 15 min):**
1. **Freeze the affected school account** — invoke the admin API to set the school
   to `status: 'suspended'` to stop new PaymentIntent creation.
   ```bash
   curl -X PUT https://api.paymentflow.io/api/schools/<schoolId> \
     -H "Authorization: Bearer $ADMIN_JWT" \
     -d '{"status": "suspended"}'
   ```
2. **Rotate the signer key immediately** using the staged rotation script:
   ```bash
   node scripts/rotate-signer-key-staged.js --school <schoolId> --force
   ```
3. **Revoke the compromised key** from all signers on the Stellar account using
   `setOptions` to remove it from the multisig threshold.
4. **Alert the Platform Security team** via the incident channel. Escalate to the
   school admin within 30 minutes.

**Investigation:**
- Export Horizon transaction history for the school wallet from the first suspicious
  timestamp: `GET /accounts/<address>/transactions?order=asc&cursor=<ledger>`.
- Identify all outgoing transactions not initiated by the system (cross-reference
  Payment records in MongoDB — any Horizon transaction with no matching `txHash`
  in the database is unauthorized).
- Check `AuditLog` for any signer key access or admin actions in the 24 hours
  preceding the first unauthorized transaction.
- Review AWS CloudTrail / Secrets Manager access logs for the compromised key's secret.

**Remediation:**
- Generate a new Stellar keypair; fund it with the minimum XLM reserve.
- Update the school's `stellarWalletAddress` if the account itself is abandoned.
- Re-enable the school account once the new key is confirmed working on testnet.
- File a post-mortem covering how the key was exfiltrated.

**Post-incident hardening:**
- Enable hardware-key (HSM) signing for signer keys in production.
- Add a Horizon outgoing-transaction alert rule to the monitoring stack.
- Review `SIGNER_KEY_SOURCE` configuration — prefer AWS Secrets Manager over
  environment variables.

---

### PLAY-02 Smart Contract Authorization Exploit

**Relates to:** SC-09
**Severity:** P0 — funds at risk (on-chain)

**Detection signals:**
- `Released` event observed on-chain for an escrow where the backend did NOT call
  `release()` (cross-reference `PaymentIntent.escrowState` in MongoDB).
- Unexpected `Resolved` event observed where the arbiter address does not match
  the platform's known arbiter account.
- Monitoring alert: on-chain escrow count decreasing without corresponding `Released`
  events recorded in Payment collection.

**Immediate containment (< 15 min):**
1. **Pause all new deposits** — set a contract-level pause flag if the contract
   implements the pause control from `contractUpgradeControls.js`. Otherwise,
   stop the backend's escrow invocation path:
   ```bash
   # Set env flag to disable new escrow deposit calls
   curl -X POST https://api.paymentflow.io/api/admin/log-level \
     -H "Authorization: Bearer $ADMIN_JWT" \
     -d '{"level": "debug"}'
   # Then manually disable escrow route in the running instance
   ```
2. **Freeze affected escrows** — identify all escrows currently in `FUNDED` or
   `DISPUTED` state via `getStatus()` calls and record their `escrow_id` list.
3. **Alert the arbiter key holder** to revoke or freeze arbiter signing capability.
4. **Do not submit any new contract transactions** until the exploit is understood.

**Investigation:**
- Fetch the full transaction XDR for the exploit transaction from Horizon.
- Decode the invocation payload to determine which function was called and by whom.
- Determine whether the exploit is:
  - An auth bypass in the contract code (critical — all escrows at risk).
  - A compromised arbiter or beneficiary key (scope limited to that key's escrows).
  - A Soroban protocol-level vulnerability (escalate to Stellar Development Foundation).
- Review all `Released` and `Resolved` events from the contract address from deployment
  onward; cross-reference each against Payment records in MongoDB.

**Remediation:**
- If a contract bug: deploy a patched contract (requires `contractUpgradeControls.js`
  quorum). Migrate any funds still held in the buggy contract via the arbiter's
  `cancel()` function before the old contract is deprecated.
- If a key compromise: rotate the affected key and re-examine all operations signed
  with it.
- Update all affected `PaymentIntent` and `Payment` records to reflect actual
  on-chain state, flagging records with discrepancies for manual school admin review.

**Post-incident hardening:**
- Require a security audit of the contract code before each deployment.
- Add contract event monitoring that alerts within 60 seconds of any unexpected
  `Released` or `Resolved` event.
- Move arbiter account to a hardware multi-sig wallet (2-of-3 threshold).

---

### PLAY-03 Mass Memo Collision or Spoofing Campaign

**Relates to:** SC-03, SC-13
**Severity:** P1 — payment integrity risk

**Detection signals:**
- Spike in `isSuspicious: true` payments in the `Payment` collection.
- Alert: `detectMemoCollision` flag rate > 5 per minute for any school.
- Admin reports unexpected `feePaid` status changes or students showing payments
  they did not make.
- Velocity alert: >10 unique sender addresses for the same memo within 1 hour.

**Immediate containment (< 15 min):**
1. **Enable strict source validation** for the affected school — add a deny-all
   rule except for known parent wallets:
   ```bash
   POST /api/source-validation-rules
   { "schoolId": "<id>", "type": "denylist", "pattern": "*", "priority": 1 }
   ```
2. **Suspend auto-approval** of incoming payments for the affected school — set
   `requireManualReview: true` in the school settings model so no payment
   automatically updates `feePaid`.
3. **Alert the school admin** to review the suspicious payment queue immediately.

**Investigation:**
- Query the `Payment` collection for `isSuspicious: true` in the last 24 hours,
  grouped by `memo`.
- For each affected memo/student, determine whether:
  - The legitimate parent's payment was already recorded and `feePaid` is correct.
  - A fraudulent payment has incorrectly set `feePaid = true`.
- Identify the sender addresses involved in the collision and check if they are
  related accounts (same keypair family) or a distributed attack.

**Remediation:**
- For any student where a fraudulent payment set `feePaid = true` incorrectly:
  1. Open a dispute record manually.
  2. Set `feePaid = false` via admin override.
  3. Contact the parent to resubmit via a newly created PaymentIntent with a
     rotated memo (appended nonce).
- Add attacker wallet addresses to the school's denylist source validation rules.

**Post-incident hardening:**
- Lower the collision detection window from 24 hours to 4 hours for high-risk schools.
- Add a school-level setting to require source wallet pre-registration before any
  payment is accepted.

---

### PLAY-04 Horizon Outage or Sustained Sync Failure

**Relates to:** SC-07, SC-08
**Severity:** P1 — payment processing delayed

**Detection signals:**
- Health check at `/health` returns `"status": "degraded"`.
- `lastSyncAt` staleness alert fires (>5 minutes without a successful sync).
- Prometheus alert: `payment_sync_lag_seconds > 300`.
- Log spike of `StellarNetworkError` or `503` responses from Horizon.

**Immediate containment (< 15 min):**
1. **Check Horizon status page** — `https://status.stellar.org` — to determine if
   the outage is network-wide or isolated to one Horizon provider.
2. **Verify failover is active** — check that `horizonFailoverClient` has switched
   to the secondary Horizon URL. Inspect the log for `Switching to fallback Horizon`.
3. **Notify affected school admins** that payment confirmation may be delayed.
   Payments already submitted on-chain are safe; they will be picked up on recovery.
4. **Do not restart the backend** unless the circuit breaker is stuck open — a
   restart resets in-flight retry state.

**Investigation:**
- Check `retry queue depth` via `GET /api/admin/retry-queue`.
- Determine the oldest unprocessed `PaymentIntent` to calculate the blast radius.
- Check whether the `horizonPollBudget` throttle is contributing to the lag.

**Remediation:**
- If Horizon is network-wide down: wait for Stellar network recovery. All pending
  intents will be processed on the next successful poll.
- If only the primary Horizon URL is down: update `HORIZON_URL` env var to point
  to the secondary permanently and redeploy.
- If the circuit breaker is permanently open: reset it via the admin API or by
  restarting the polling service worker.
- After recovery, run a manual sync to catch up:
  ```bash
  POST /api/payments/sync
  ```

**Post-incident hardening:**
- Add a third Horizon URL to the failover list.
- Configure a PagerDuty / Opsgenie integration on the `lastSyncAt` staleness alert.

---

### PLAY-05 Escrow Funds Frozen (Dispute Dead-Lock)

**Relates to:** SC-09 (arbiter availability), timeout design in escrow requirements
**Severity:** P1 — funds inaccessible (not lost, but frozen)

**Detection signals:**
- `DisputeModel` records with `status: 'open'` older than the configured
  `DISPUTE_RESOLUTION_SLA` (default: 5 business days) with no arbiter action.
- Parent or school admin raises a support ticket reporting funds are stuck.
- Backend alert: escrow in `DISPUTED` state with `created_at` older than 7 days.

**Immediate containment (< 15 min):**
1. **Identify the frozen escrow** — query `DisputeModel` for records where
   `status: 'open'` and `createdAt < now - SLA_DAYS`.
2. **Confirm the arbiter account is accessible** — attempt a test invocation
   (e.g. `getStatus()`) using the arbiter key to verify it is not compromised or
   lost.
3. **Alert the dispute resolution team** with the escrow ID and both parties'
   contact information.

**Investigation:**
- Retrieve the full dispute record including off-chain evidence from `DisputeModel.evidence`.
- Fetch the on-chain escrow state via `getStatus(escrow_id)` to confirm current state.
- Determine whether the deadlock is:
  - **Arbiter key inaccessible** — requires emergency key recovery procedure.
  - **Pending evidence** — arbiter is waiting for documentation from one party.
  - **Process failure** — arbiter was not notified of the dispute.

**Remediation:**
- If evidence is complete: arbiter calls `resolveDispute(escrow_id, decision)`.
- If arbiter key is inaccessible: invoke the emergency arbiter recovery procedure
  (see `docs/runbooks/contract-upgrade-failure.md`) to transfer arbiter role to a
  backup key via contract upgrade.
- If the escrow's `timeout_ledger` has already passed (FUNDED state): the payer may
  call `claimExpired()` independently to recover funds without arbiter involvement.
  Note: this is NOT available in DISPUTED state — the dispute must be resolved first.

**Post-incident hardening:**
- Implement automated escalation: after 3 business days without arbiter action,
  auto-notify a secondary arbiter.
- Store the arbiter key in a geographically distributed multi-sig (2-of-3) so no
  single point of unavailability can freeze funds.
- Add an automatic reminder webhook to the dispute resolution team when a dispute
  ages past 48 hours.

---

### PLAY-06 Contract Upgrade Gone Wrong

**Relates to:** SC-08
**Severity:** P1 — payment processing blocked

**Detection signals:**
- `POST /api/admin/contract-upgrade` returns a non-success status or times out.
- Backend logs show `ContractUpgradeError` or unexpected contract invocation failures
  after a deploy.
- `getStatus()` calls on existing escrows start returning unexpected errors.
- Health check degrades immediately after a deployment.

**Immediate containment (< 15 min):**
1. **Halt the upgrade** — if in the proposal phase (not yet executed), cancel the
   upgrade proposal via the `contractUpgradeControls` API.
2. **Roll back to the previous contract WASM hash** — the `contractUpgradeControls`
   service records the prior hash. Initiate rollback:
   ```bash
   node scripts/rollback-contract.js --to <previous_wasm_hash>
   ```
3. **Freeze new deposits** to the contract address while the rollback is in progress.
4. **Check all existing escrows** by enumerating `PaymentIntent.escrowId` values in
   `FUNDED` or `DISPUTED` state and calling `getStatus()` on each to verify they
   are unaffected.

**Investigation:**
- Compare the deployed WASM hash against the expected hash from the build artifact.
- Check whether the upgrade changed any storage key layout — a layout change can
  corrupt persistent storage of existing escrows.
- Review `contractUpgradeControls` audit log for all signers who approved the upgrade.

**Remediation:**
- Once rollback is confirmed successful, re-enable deposits.
- If storage corruption affected existing escrows: manually resolve each affected
  escrow via the arbiter (`cancel()` to return funds to payers), then ask payers to
  re-deposit once the contract is patched.
- Perform a full regression test against testnet before re-attempting the upgrade.

**Post-incident hardening:**
- Require a testnet canary deployment for 24 hours before mainnet upgrade execution.
- Enforce WASM hash signing (two independent engineers must sign off on the hash).
- Reference: `docs/runbooks/contract-upgrade-failure.md`.

---

### PLAY-07 USDC Issuer Address Stale or Spoofed

**Relates to:** SC-05
**Severity:** P1 — payments silently rejected or fraudulently accepted

**This playbook covers two opposite failure modes:**

**Mode A — Stale issuer config (legitimate USDC rejected):**

Detection signals:
- School admins report USDC payments are not being recorded despite confirmed
  on-chain transactions.
- Prometheus alert: `valid_payments_recorded / horizon_payment_events_observed` ratio
  drops below 0.8 for USDC asset type.

Immediate containment:
1. Check Circle's official Stellar USDC issuer address for the affected network
   (mainnet: `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`,
   testnet: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`).
2. Compare against `USDC_ISSUER` in the current deployment's environment config.
3. If they differ, update `USDC_ISSUER` and redeploy.
4. After redeployment, manually re-sync the affected time window to pick up the
   missed USDC payments: `POST /api/payments/sync`.

**Mode B — Fake USDC token accepted (active exploit):**

Detection signals:
- Payments recorded with `asset_issuer` ≠ Circle's official issuer address.
- `feePaid` set to `true` for payments with an unofficial USDC token.
- School admin reports revenue shortfall — funds received are worthless tokens.

Immediate containment:
1. Immediately remove the rogue issuer from the accepted assets list in `stellarConfig.js`
   and redeploy.
2. Query the `Payment` collection for records where `asset.issuer` ≠ the official
   USDC issuer and `asset.code === 'USDC'`.
3. For each affected payment: set `feePaid = false`, create a dispute record, and
   notify the school admin.

Post-incident hardening for both modes:
- Add a startup check that logs a warning if `USDC_ISSUER` does not match the
  hardcoded Circle address for the active network.
- Subscribe to Circle's official Stellar announcements for issuer change notices.

---

## Residual Risk Summary

| Risk Owner | Threats |
|---|---|
| **Platform Operator** | SC-01, SC-02, SC-06, SC-07, SC-08, SC-09, SC-10, SC-11, SC-14, SC-15 |
| **School Admin** | SC-03, SC-12, SC-13 |
| **Contract Deployer** (future) | SC-09 (arbiter key management), SC-10 (storage TTL) |

Threats owned by the Platform Operator are addressed through operational controls
(key management, monitoring, deployment hygiene). Threats owned by the School Admin
are addressed through configuration (source validation rules, suspicious payment review).
