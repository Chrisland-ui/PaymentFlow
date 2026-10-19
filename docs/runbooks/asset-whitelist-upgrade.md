# Asset Whitelist Upgrade Runbook

**Issue:** #306 — Define and validate asset type and decimal precision on-chain  
**Component:** `backend/src/config/assetRegistry.js`

---

## Overview

The asset registry enforces three on-chain guards for every contract operation:

1. **Whitelist** — only registered assets may fund an escrow.  
2. **Type validation** — `native` vs `credit_alphanum4` must match the registered type.  
3. **Decimal precision** — amounts with more decimal places than the asset supports are rejected before broadcasting.

Default whitelist: **XLM** (7 d.p., native) and **USDC** (7 d.p., credit_alphanum4).

---

## Adding a New Asset

### Prerequisites

- The asset issuer address must be known and pinned in the environment before deployment.
- The maximum decimal places supported by the asset on Stellar must be confirmed (typically 7).
- A contract admin JWT must be available for the HTTP call.

### Steps

1. **Add the issuer to the environment**

   ```bash
   # In backend/.env (or your secrets manager)
   NEW_ASSET_ISSUER=G<issuer-address>
   ```

2. **Deploy the new environment variable** and restart the backend.

3. **Call the add-asset admin endpoint** (to be wired up when the admin API is extended):

   ```javascript
   const { addWhitelistedAsset } = require('./backend/src/config/assetRegistry');

   addWhitelistedAsset({
     code: 'EURC',
     type: 'credit_alphanum4',
     issuer: process.env.EURC_ISSUER,
     displayName: 'Euro Coin',
     decimals: 7,
   });
   ```

4. **Verify** the asset appears in the view function:

   ```javascript
   const { listWhitelistedAssets } = require('./backend/src/config/assetRegistry');
   console.log(listWhitelistedAssets());
   ```

5. **Run the test suite** to confirm no regressions:

   ```bash
   npm test tests/issue-306-asset-type-decimal-precision.test.js
   ```

6. **Update the school's `acceptedAssets` array** in MongoDB to include the new asset code.

---

## Removing an Asset

Removing an asset prevents new operations from using it. **In-flight transactions already on-chain are not affected.**

```javascript
const { removeWhitelistedAsset } = require('./backend/src/config/assetRegistry');
removeWhitelistedAsset('DEPRECATED_ASSET');
```

Coordinate with school operators before removal — any payment using the removed asset will be rejected with `ASSET_NOT_WHITELISTED`.

---

## Decimal Precision Rules

| Asset | Max Decimal Places | Smallest Unit    |
|-------|-------------------|------------------|
| XLM   | 7                 | 0.0000001 XLM (1 stroop) |
| USDC  | 7                 | 0.0000001 USDC   |

Amounts with more precision than listed above are rejected with `AMOUNT_EXCEEDS_PRECISION` before they reach the Stellar network. This prevents unresolvable on-chain states caused by rounding.

---

## Admin Address

Set `CONTRACT_ADMIN_ADDRESS` in the environment to the Stellar public key of the contract admin:

```bash
CONTRACT_ADMIN_ADDRESS=G<admin-public-key>
```

The HTTP layer verifies the caller's JWT has `role: 'admin'` via `requireAdminAuth` before any registry mutation is allowed.

---

## Querying the Whitelist

```javascript
const { getWhitelistedAssets, listWhitelistedAssets } = require('./backend/src/config/assetRegistry');

// Object (code → definition)
const assets = getWhitelistedAssets();

// Array sorted by code
const list = listWhitelistedAssets();
```

Both functions resolve issuers from environment variables at call time, so they always reflect the current configuration.
