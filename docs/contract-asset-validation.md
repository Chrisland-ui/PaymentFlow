# Contract Asset and Decimal Validation Specification

This specification documents the asset identity and decimal arithmetic rules enforced by PaymentFlow contracts and their off-chain integration layer.

---

## 1. Background & Scope

Asset identity and precision mismatches can lead to:
- Accepting illegitimate or spoofed credit tokens (financial loss).
- Off-by-one or sub-stroop precision truncation errors (locked or unreconciled balances).
- Underflow (zero or dust transactions creating spam/orphan state) or overflow (integer truncation or contract reverts).

To prevent state corruption, all money-moving operations must execute strict asset identity and amount boundary validation **prior** to state mutation.

---

## 2. Accepted Asset Identifiers & Issuer Rules

### 2.1 Native Asset (XLM)
- **Identifier**: `XLM:native` (or `native`, `XLM`)
- **Type**: `native`
- **Issuer**: Must be `null` / empty. Any transaction specifying an issuer for native XLM is strictly rejected with `ISSUER_NOT_ALLOWED`.
- **Decimals**: 7 (1 XLM = 10,000,000 stroops).

### 2.2 Credit Assets (USDC)
- **Identifier**: `USDC:<canonical_issuer>`
- **Type**: `credit_alphanum4`
- **Issuer**: Must be explicitly present and match the canonical issuer configured for the network (e.g. Circle testnet or mainnet issuer).
- **Security Rule**: Any non-matching issuer is rejected with `INVALID_ISSUER` before processing.
- **Decimals**: 7 (1 USDC = 10,000,000 stroops).

---

## 3. Decimal Conversion & Amount Boundaries

Stellar and Soroban contracts operate with exact integer stroop amounts (7 decimal places).

| Boundary | Value in Stroops | Value in Decimal Units | Rule |
|---|---|---|---|
| **Minimum (Dust/Underflow)** | `1` stroop | `0.0000001` | Non-zero amounts below 1 stroop reject with `AMOUNT_UNDERFLOW`. Zero rejects with `AMOUNT_ZERO`. |
| **Negative Amounts** | `< 0` | `< 0.0000000` | Rejects with `AMOUNT_NEGATIVE`. |
| **Standard Maximum (Int64)** | `9,223,372,036,854,775,807` | `922,337,203,685.4775807` | Amounts exceeding int64 bound reject with `AMOUNT_OVERFLOW`. |
| **Contract Bound (Int128)** | `170,141,183,460,469,231,731,687,303,715,884,105,727` | N/A | Absolute upper ceiling for multi-contract storage. |

---

## 4. Off-Chain Parity Guarantee

Off-chain services (`stellarConfig.js`, `stellarAmount.js`, and Horizon ingestion) must enforce the exact same criteria as on-chain contracts:
1. `isAcceptedAsset(code, type, issuer)` enforces code, type, and issuer match.
2. `toStroops(amount)` converts string/number amounts to exact BigInt integer stroops using round-half-up for sub-stroop precision.
3. `validateContractAssetAndAmount` acts as the authoritative gatekeeper before state mutation.
