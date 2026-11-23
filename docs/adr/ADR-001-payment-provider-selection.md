# ADR-001: Payment Provider Selection — Stellar Network

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2024-01-15 |
| **Review date** | 2027-01-15 |
| **Authors** | Payment Platform Team |
| **Code references** | `backend/src/services/stellarService.js`, `backend/src/config/stellarConfig.js`, `backend/src/services/transactionPollingService.js` |

---

## Context

PaymentFlow processes school fee payments for multiple schools and thousands of
students. The system needs a payment infrastructure that is:

- **Verifiable by third parties** — schools, parents, and auditors must be able
  to independently confirm that a payment occurred without trusting the
  application server.
- **Affordable at scale** — the user base is primarily in emerging markets where
  high per-transaction fees would make the product unviable.
- **Resistant to fraud** — paper receipts and manual reconciliation create fraud
  vectors; the system must eliminate them.
- **Multi-tenant** — each school operates an isolated wallet; the platform must
  never commingle funds.
- **Stablecoin-capable** — schools need price-stable settlement to avoid XLM
  volatility affecting fee calculations.

We evaluated four options: traditional card processors, bank transfer rails,
the Ethereum network, and the Stellar network.

---

## Decision

**Use the Stellar Network as the sole payment rail.**

Stellar was selected over all alternatives.

---

## Alternatives considered

### 1. Traditional card processors (Stripe, Flutterwave, Paystack)

**Pros:**
- Familiar UX for parents with cards
- Chargeback protection

**Cons:**
- 1.5%–3.5% per-transaction fee destroys margin at school-fee amounts
- Requires PCI-DSS compliance (significant engineering and audit cost)
- No public audit trail — only the processor and merchant can see transaction data
- Reconciliation is manual (CSV exports, delayed settlement)
- No stablecoin support

### 2. Bank transfer rails (RTGS, ACH, local mobile money)

**Pros:**
- Familiar to parents in some markets
- Low or zero consumer fees in some jurisdictions

**Cons:**
- No universal standard — different countries require different integrations
- Settlement can take 1–3 business days (manual hold period)
- No programmable memo/reference field for automatic student matching
- No public audit trail

### 3. Ethereum (ERC-20 USDC)

**Pros:**
- Large ecosystem, many wallets
- USDC stablecoin available

**Cons:**
- Gas fees are unpredictable and can exceed the payment value for small amounts
- 12–15 second finality on L1; L2 adds complexity and fragmentation
- No built-in memo field for payment matching without custom smart contracts
- Smart contract audit cost is substantial

### 4. Stellar Network (selected)

**Pros:**
- ~$0.000001 per transaction (effectively free)
- 3–5 second ledger finality
- Built-in **memo field** (up to 28 bytes) enables automatic student-ID matching
- Public ledger: any party can verify a payment on [Stellar Expert](https://stellar.expert)
  or via the Horizon API without trusting the application server
- USDC available as a native asset (Circle-issued, same issuer as Ethereum USDC)
- XLM and USDC in the same transaction model — no separate integration per asset
- Read-only integration: the backend only reads from the public Horizon API;
  it never holds school private keys (eliminates a critical attack surface)
- Horizon API is free and public; no vendor account required for reads

**Cons:**
- Smaller user base than Ethereum; parents need to onboard to a Stellar wallet
- XLM price volatility (mitigated by USDC support per school)
- Horizon API has rate limits at high volume (mitigated by
  `stellarRateLimitedClient.js` with Bottleneck + circuit breaker)

---

## Consequences

**Positive:**
- Zero transaction fees enable fee amounts as small as $0.01.
- Public ledger eliminates reconciliation disputes: any disagreement can be
  settled by checking [stellar.expert](https://stellar.expert) or Horizon.
- Read-only backend integration means a compromise of the application server
  cannot drain school wallets.
- Memo-field matching eliminates manual reconciliation entirely.

**Negative:**
- Parents must use a Stellar-compatible wallet. Onboarding friction exists for
  users unfamiliar with blockchain wallets.
- The application depends on Stellar Horizon API availability. Horizon outages
  delay payment confirmation (handled by retry queue — see ADR-002).
- XLM accounts require a minimum balance (currently 1 XLM) to be active.
  Schools and students must maintain this reserve.

**Ongoing commitments:**
- Monitor Stellar network status at https://status.stellar.org.
- Review accepted assets (`stellarConfig.js`) when new Stellar assets gain
  adoption in target markets.
- Reassess this decision if Stellar transaction fees increase materially or
  if a competing network achieves significantly better reach in target markets.

---

## Review criteria

Revisit this ADR if:
- Stellar transaction fees rise above $0.01 per transaction.
- Horizon API SLA falls below 99.5% uptime over a 90-day period.
- A competing network achieves > 50% wallet penetration in the target markets.
- Regulatory requirements in a target market prohibit blockchain-based payments.
