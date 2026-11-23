# Dependency Compatibility Matrix

## Supported Runtime and Core Dependency Matrix

This matrix documents verified, tested combinations of runtime environments, database engines, and core libraries used in PaymentFlow.

| Component | Minimum Supported | Recommended / Tested | End of Life / Deprecated |
|---|---|---|---|
| **Node.js** | `>=20.0.0` (LTS) | `v20.18.0` / `v22.x` | `<20.0.0` |
| **MongoDB** | `6.0` (Replica Set) | `7.0` (Single/Multi-node Replica Set) | `<5.0` |
| **Mongoose** | `8.0.0` | `8.0.0` | `<7.0.0` |
| **Redis** | `7.0` | `7.2` | `<6.2` |
| **BullMQ** | `5.0.0` | `5.1.0` | `<4.0.0` |
| **Stellar SDK** | `@stellar/stellar-sdk 12.0.0` | `12.0.0` | `<11.0.0` |
| **Express** | `4.18.2` | `4.18.2` | `<4.17.0` |
| **Next.js** | `14.0.0` | `14.2.0` | `<13.0.0` |
| **React** | `18.0.0` | `18.3.1` | `<18.0.0` |

---

## Upgrade Verification Guidelines

1. **Stellar SDK Updates**: Stellar Horizon endpoints and contract interface XDR encodings must be validated against testnet and integration test suites before upgrading major SDK versions.
2. **MongoDB / Mongoose Updates**: Mongoose major version bumps require review of index definitions, transaction semantics (`withTransaction`), and partial filter expression compatibility.
3. **BullMQ / Redis Updates**: Ensure Redis connection options (`maxRetriesPerRequest: null`) remain compliant with BullMQ expectations across versions.
