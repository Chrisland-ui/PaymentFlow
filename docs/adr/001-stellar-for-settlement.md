# ADR-001: Use Stellar Network for Payment Settlement

**Status:** Accepted
**Date:** 2024-01-15
**Authors:** PaymentFlow Core Team

---

## Context

StellarEduPay needs a payment settlement layer for school fee collections from parents. Requirements include:

- Payments must be confirmed quickly (parents expect proof within seconds, not days)
- Transaction fees must be negligible (schools in emerging markets cannot absorb 2–3% payment processor fees on every transaction)
- Every payment must have an immutable, publicly verifiable audit trail
- The platform must work in countries where traditional banking rails are unreliable or inaccessible
- The system must support both a native currency asset (for crypto-native users) and a stablecoin (for fee-stable amounts)
- The backend must not be required to hold private keys — schools should retain custody of their own funds

The initial user base is schools in Africa and the Pacific Islands (Papua New Guinea), where SWIFT/ACH coverage is thin, mobile wallet penetration is high, and local currency volatility makes USD-pegged stablecoins desirable.

### Alternatives Evaluated

| Option | Transaction Finality | Cost | Custody Model | Verdict |
|--------|---------------------|------|---------------|---------|
| **Stellar** | 3–5 seconds | ~$0.000001 | School-controlled wallet; backend read-only | **Chosen** |
| Ethereum (ERC-20 USDC) | 12 sec–5 min | $1–50 gas | Same read-only model possible | Too expensive, variable gas |
| Solana | ~400 ms | ~$0.00025 | Same | Viable but tooling less mature for NGO/education integrations |
| Traditional bank transfer | 1–3 business days | 0.1–1.5% | Third-party custody | Too slow; no real-time confirmation |
| Stripe / Flutterwave | Instant (UI) | 2.9% + $0.30 | Stripe holds funds | Fees prohibitive; no blockchain audit trail |
| Celo | 5 seconds | Low | Same | Smaller ecosystem; fewer hardware wallets supported |

### Stellar-Specific Advantages

- **Memo field (28 chars):** Enables embedding the student ID directly in every transaction, making auto-reconciliation zero-touch. No equivalent in bank transfers.
- **Horizon API:** Free, public REST API for reading blockchain state — no node operation required.
- **USDC on Stellar:** Circle issues native USDC on Stellar (not a bridge), giving a USD-pegged asset without smart contract risk.
- **Non-custodial design:** The Stellar SDK supports read-only account monitoring (`accounts/{address}/transactions`). StellarEduPay never needs to sign transactions.
- **Established NGO/aid sector usage:** USAID, Mercy Corps, and others already distribute aid payments over Stellar, giving confidence in the network's stability for the target user base.

## Decision

Use the **Stellar Network** (mainnet for production, testnet for development/staging) as the settlement layer for all school fee payments.

Architecture constraints imposed by this decision:
- Each school controls its own Stellar wallet (`G…` public key); StellarEduPay only reads from it via Horizon.
- The `memo` field carries the student ID; memo must not exceed 28 characters.
- Payment confirmation requires a Horizon API poll (every `POLL_INTERVAL_MS`, default 30 s) — not a direct push from the blockchain.
- The system must tolerate Horizon API outages gracefully (circuit breaker, exponential backoff, fallback to the retry queue).

## Consequences

**Positive:**
- Eliminates reconciliation latency — payments auto-match via memo within one poll cycle (~30 s).
- Transaction fee is negligible regardless of payment volume.
- Immutable blockchain audit trail supplements the internal `AuditLog` collection.
- No private key management burden on the backend.

**Negative:**
- Parents must use a Stellar-compatible wallet (Lobstr, SEAT, XUMM, or exchange withdrawal). This is a significant UX friction for non-crypto-native parents.
- Stellar network downtime (historically rare, < 0.01% per year) would block new payments. Mitigated by the stuck-payment reconciliation scheduler.
- USDC on Stellar requires schools to establish trustlines — one-time setup, but adds onboarding friction.
- XLM price volatility affects the "effective fee amount" in local currency unless USDC is used.

**Risks accepted:**
- Horizon API rate limits require client-side throttling (`stellarRateLimitedClient.js`, Bottleneck). See `docs/horizon-rate-limits.md`.
- A compromised school private key cannot be remediated by StellarEduPay — it is an incident for the school's wallet provider. See `docs/runbooks/wallet-rotation.md`.

---

## References

- Horizon API documentation: https://developers.stellar.org/api/horizon
- USDC on Stellar: https://www.circle.com/en/usdc-multichain/stellar
- Stellar circuit breaker implementation: [`backend/src/services/stellarRateLimitedClient.js`](../../backend/src/services/stellarRateLimitedClient.js)
- Stellar integration deep-dive: [`docs/stellar-integration.md`](../stellar-integration.md)
