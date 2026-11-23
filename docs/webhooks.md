# Webhook Integration Guide

Complete reference for integrating with PaymentFlow's webhook system — event catalog, payload schemas, signature verification, retry policy, idempotency, and local testing.

> **Related documents**: [Payment Lifecycle](payment-lifecycle.md) · [WEBHOOK_INTEGRATION.md](WEBHOOK_INTEGRATION.md) (legacy reference) · [Authorization Matrix](authorization-matrix.md)

---

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Event Catalog](#event-catalog)
- [Payload Schema](#payload-schema)
- [Signature Verification](#signature-verification)
  - [V2 (recommended)](#v2-signature-recommended)
  - [V1 (deprecated)](#v1-signature-deprecated)
  - [Node.js example](#nodejs-verification-v2)
  - [Python example](#python-verification-v2)
  - [PHP example](#php-verification-v2)
- [Delivery Headers](#delivery-headers)
- [Retry Policy](#retry-policy)
- [Idempotency & Replay Protection](#idempotency--replay-protection)
- [PII Field Controls](#pii-field-controls)
- [Multiple Endpoints & Event Subscriptions](#multiple-endpoints--event-subscriptions)
- [Delivery History & Replay](#delivery-history--replay)
- [SSRF Protections](#ssrf-protections)
- [Local Testing with ngrok or smee.io](#local-testing-with-ngrok-or-smeeio)
- [Admin Replay Endpoint](#admin-replay-endpoint)
- [Troubleshooting](#troubleshooting)

---

## Overview

PaymentFlow delivers **signed HTTP POST** requests to your HTTPS endpoint when payment lifecycle events occur. Key properties:

- Payloads are signed with **HMAC-SHA256** using a per-school secret.
- Delivery is **at-least-once**: the same event may be delivered more than once on retries.
- **3 delivery attempts** with exponential backoff before moving to dead-letter.
- Delivery IDs enable idempotent processing.
- Both V1 (body-only) and V2 (timestamp + delivery-ID + body) signatures are provided during the migration window; V1 will be removed on **2027-02-28**.

---

## Quick Start

### 1. Register a webhook endpoint

```
POST /api/webhook-endpoints
Authorization: Bearer <school-token>
X-School-ID: SCH-1
Content-Type: application/json

{
  "url": "https://your-server.com/webhook",
  "subscribedEvents": ["payment.confirmed", "payment.failed"],
  "description": "ERP integration"
}
```

Response includes the **`secret`** — shown only once. Store it securely; it cannot be retrieved again.

```json
{
  "id": "ep_abc123",
  "url": "https://your-server.com/webhook",
  "subscribedEvents": ["payment.confirmed", "payment.failed"],
  "secret": "whsec_a1b2c3d4...",
  "isActive": true
}
```

### 2. Receive and verify events

```js
const crypto = require('crypto');

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const result = verifyWebhookV2(req.body, req.headers, process.env.WEBHOOK_SECRET);
  if (!result.valid) return res.status(401).end();

  const event = JSON.parse(req.body);
  console.log('Event:', event.event, event.data);

  res.status(200).end(); // Acknowledge quickly (<10s)
});
```

---

## Event Catalog

| Event | Trigger | Business Status Transition |
|-------|---------|---------------------------|
| `payment.pending` | Payment detected on-chain, awaiting confirmation | `PENDING` → `SUBMITTED` |
| `payment.confirmed` | Payment verified and ledger-confirmed | `SUBMITTED` → `SUCCESS` |
| `payment.failed` | Payment failed (bad destination, wrong asset, missing memo, etc.) | Any → `FAILED` |
| `payment.suspicious` | Payment flagged by fraud detection or moved to disputed | `SUCCESS` → `DISPUTED` |
| `payment.refunded` | Payment has been refunded | Any → `REFUNDED` |

---

## Payload Schema

All events share the same outer envelope:

```json
{
  "event": "payment.confirmed",
  "timestamp": "2026-03-27T10:30:00.000Z",
  "data": { ... }
}
```

### Default payload fields (no PII)

```json
{
  "event": "payment.confirmed",
  "timestamp": "2026-03-27T10:30:00.000Z",
  "data": {
    "txHash": "abc123def456...",
    "transactionHash": "abc123def456...",
    "amount": 250.0,
    "assetCode": "XLM",
    "asset": "XLM",
    "status": "confirmed",
    "schoolId": "SCH-1",
    "ts": "2026-03-27T10:30:00.000Z",
    "correlationId": "corr_xyz789",
    "referenceCode": "REF-001",
    "finalFee": 0.00001,
    "feeValidationStatus": "valid",
    "confirmedAt": "2026-03-27T10:30:00.000Z",
    "ledgerSequence": 48123456,
    "isSuspicious": false
  }
}
```

### `payment.failed` additional fields

```json
{
  "data": {
    "txHash": "abc123...",
    "reason": "MISSING_MEMO",
    "status": "failed"
  }
}
```

### `payment.suspicious` additional fields

```json
{
  "data": {
    "txHash": "abc123...",
    "isSuspicious": true,
    "reason": "Amount 10× above expected fee"
  }
}
```

### `payment.refunded` additional fields

```json
{
  "data": {
    "txHash": "abc123...",
    "originalTxHash": "abc123...",
    "refundTxHash": "refund456...",
    "refundedAt": "2026-03-27T11:00:00.000Z"
  }
}
```

### Field reference

| Field | Type | Present on | Meaning |
|-------|------|-----------|---------|
| `txHash` | string | All | Transaction hash on Stellar |
| `transactionHash` | string | All | Alias for `txHash` |
| `amount` | number | All | Payment amount in asset units |
| `assetCode` | string | All | `XLM`, `USDC`, etc. |
| `asset` | string | All | Alias for `assetCode` |
| `status` | string | All | On-chain status: `confirmed`, `failed`, `pending` |
| `schoolId` | string | All | School tenant identifier |
| `ts` / `timestamp` | string | All | ISO 8601 event time |
| `correlationId` | string | All | Distributed trace ID |
| `referenceCode` | string | All | Human-readable reference |
| `finalFee` | number | confirmed | Stellar network fee paid (in XLM) |
| `feeValidationStatus` | string | confirmed | `valid`, `underpaid`, `overpaid`, `partial` |
| `confirmedAt` | string | confirmed | ISO 8601 on-chain confirmation time |
| `ledgerSequence` | number | confirmed | Stellar ledger number |
| `isSuspicious` | boolean | All | Fraud flag |
| `reason` | string | failed, suspicious | Error or flag reason code |
| `originalTxHash` | string | refunded | Hash of original payment |
| `refundTxHash` | string | refunded | Hash of the refund transaction |
| `refundedAt` | string | refunded | ISO 8601 refund time |
| `studentId` | string | *opt-in* | Student identifier (**PII** — requires opt-in) |
| `senderAddress` | string | *opt-in* | Payer's Stellar address (**PII** — requires opt-in) |

---

## Signature Verification

### Delivery Headers

Every delivery includes these headers:

| Header | Example | Purpose |
|--------|---------|---------|
| `X-StellarEduPay-Signature-V2` | `sha256=a1b2c3...` | **V2 HMAC-SHA256** (recommended) |
| `X-StellarEduPay-Signature` | `sha256=d4e5f6...` | V1 HMAC-SHA256 (deprecated — body only) |
| `X-StellarEduPay-Timestamp` | `1711532400` | Unix timestamp (seconds) of delivery |
| `X-StellarEduPay-Delivery-ID` | `550e8400-...` | Unique delivery UUID |

### V2 Signature (recommended)

The V2 signature covers the timestamp, delivery-ID, **and** body in one signed string, preventing replay attacks.

```
signing_base = timestamp + "." + deliveryId + "." + rawBody
signature    = HMAC-SHA256(secret, signing_base)
header_value = "sha256=" + hex(signature)
```

**Important**: use the **raw request body bytes** — do not re-serialize a parsed object.

#### Node.js Verification (V2)

```js
const crypto = require('crypto');

const TOLERANCE_S = 300; // 5 minutes

function verifyWebhookV2(rawBody, headers, secret) {
  // 1. Parse and range-check the timestamp
  const ts = parseInt(headers['x-stellaredupay-timestamp'], 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_S) {
    return { valid: false, reason: 'timestamp out of tolerance' };
  }

  // 2. Extract the V2 signature
  const deliveryId = headers['x-stellaredupay-delivery-id'] || '';
  const [, provided] = (headers['x-stellaredupay-signature-v2'] || '').split('sha256=');
  if (!provided) return { valid: false, reason: 'missing V2 signature' };

  // 3. Recompute over timestamp.deliveryId.rawBody
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString();
  const signingBase = `${ts}.${deliveryId}.${body}`;
  const expected = crypto.createHmac('sha256', secret).update(signingBase).digest('hex');

  // 4. Constant-time comparison
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');
  if (expectedBuf.length !== providedBuf.length) {
    return { valid: false, reason: 'signature length mismatch' };
  }
  if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    return { valid: false, reason: 'signature mismatch' };
  }

  return { valid: true };
}

// Express usage — must read raw body BEFORE JSON parsing
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const { valid, reason } = verifyWebhookV2(req.body, req.headers, process.env.WEBHOOK_SECRET);
  if (!valid) {
    console.error('Webhook verification failed:', reason);
    return res.status(401).end();
  }
  const event = JSON.parse(req.body);
  // handle event...
  res.status(200).end();
});
```

#### Python Verification (V2)

```python
import hashlib
import hmac
import time
from flask import Flask, request

WEBHOOK_SECRET = 'your-webhook-secret'
TOLERANCE_S = 300  # 5 minutes

def verify_webhook_v2(raw_body: bytes, headers: dict, secret: str) -> bool:
    # 1. Parse and range-check the timestamp
    try:
        ts = int(headers.get('X-StellarEduPay-Timestamp', '0'))
    except ValueError:
        return False
    if abs(time.time() - ts) > TOLERANCE_S:
        return False

    # 2. Extract the V2 signature
    delivery_id = headers.get('X-StellarEduPay-Delivery-ID', '')
    sig_header = headers.get('X-StellarEduPay-Signature-V2', '')
    if not sig_header.startswith('sha256='):
        return False
    provided = sig_header[len('sha256='):]

    # 3. Recompute over timestamp.deliveryId.rawBody
    body_str = raw_body.decode('utf-8') if isinstance(raw_body, bytes) else raw_body
    signing_base = f'{ts}.{delivery_id}.{body_str}'.encode('utf-8')
    expected = hmac.new(secret.encode('utf-8'), signing_base, hashlib.sha256).hexdigest()

    # 4. Constant-time comparison
    return hmac.compare_digest(expected, provided)


app = Flask(__name__)

@app.route('/webhook', methods=['POST'])
def webhook():
    if not verify_webhook_v2(request.data, request.headers, WEBHOOK_SECRET):
        return '', 401
    event = request.get_json(force=True)
    print('Event:', event['event'])
    return '', 200
```

#### PHP Verification (V2)

```php
<?php
define('WEBHOOK_SECRET', 'your-webhook-secret');
define('TOLERANCE_S', 300);

function verifyWebhookV2(string $rawBody, array $headers, string $secret): bool {
    // 1. Parse and range-check the timestamp
    $ts = intval($headers['x-stellaredupay-timestamp'] ?? 0);
    if (abs(time() - $ts) > TOLERANCE_S) {
        return false;
    }

    // 2. Extract the V2 signature
    $deliveryId = $headers['x-stellaredupay-delivery-id'] ?? '';
    $sigHeader  = $headers['x-stellaredupay-signature-v2'] ?? '';
    if (!str_starts_with($sigHeader, 'sha256=')) return false;
    $provided = substr($sigHeader, strlen('sha256='));

    // 3. Recompute over timestamp.deliveryId.rawBody
    $signingBase = "{$ts}.{$deliveryId}.{$rawBody}";
    $expected    = hash_hmac('sha256', $signingBase, $secret);

    // 4. Constant-time comparison
    return hash_equals($expected, $provided);
}

// Read raw body before any parsing
$rawBody = file_get_contents('php://input');
$headers = array_change_key_case(getallheaders(), CASE_LOWER);

if (!verifyWebhookV2($rawBody, $headers, WEBHOOK_SECRET)) {
    http_response_code(401);
    exit;
}

$event = json_decode($rawBody, true);
error_log('Event: ' . $event['event']);
http_response_code(200);
```

---

### V1 Signature (deprecated)

> ⚠️ V1 signs only the JSON body. An attacker can replay a captured delivery by rewriting the timestamp header. **Migrate to V2 before 2027-02-28.**

```
signature_v1 = HMAC-SHA256(secret, JSON.stringify(payload))
header_value = "sha256=" + hex(signature_v1)
```

---

## Retry Policy

Failed deliveries (non-2xx response, timeout >10s, connection error) are retried with exponential backoff:

| Attempt | Delay after failure | Total elapsed |
|---------|---------------------|---------------|
| Initial delivery | — | 0 |
| 1st retry | 1 minute | ~1 min |
| 2nd retry | 5 minutes | ~6 min |
| 3rd retry | 15 minutes | ~21 min |
| Dead-letter | — | After 3rd retry |

After all retries are exhausted, the delivery is moved to the **dead-letter queue** (DLQ). Admins can view and retry DLQ entries:

```
GET  /api/admin/webhooks/dlq
POST /api/admin/webhooks/dlq/:id/retry
```

### Acknowledge quickly

Respond with **HTTP 2xx within 10 seconds**. If processing takes longer, acknowledge immediately and handle asynchronously:

```js
app.post('/webhook', (req, res) => {
  res.status(200).end(); // Acknowledge immediately

  setImmediate(async () => {
    await processEvent(req.body); // Handle asynchronously
  });
});
```

---

## Idempotency & Replay Protection

Webhook delivery is **at-least-once** — the same event may arrive multiple times (network retry, admin replay). Use the `X-StellarEduPay-Delivery-ID` header as an idempotency key.

```js
// Use Redis or a database for durability across restarts and replicas
const seen = new Set(); // replace with Redis/DB in production

app.post('/webhook', (req, res) => {
  const deliveryId = req.headers['x-stellaredupay-delivery-id'];

  if (seen.has(deliveryId)) {
    return res.status(200).json({ status: 'duplicate, ignored' });
  }
  seen.add(deliveryId);

  // Process the event
  handleEvent(req.body);
  res.status(200).end();
});
```

**Durable idempotency**: store delivery IDs in Redis or a database. An in-process `Set` is lost on restart.

### Server-side replay protection

The PaymentFlow server also has its own replay protection window (`WEBHOOK_REPLAY_WINDOW_S`, default 300 seconds). The V2 signature binds the timestamp and delivery-ID to the HMAC, so rewriting either header invalidates the signature.

---

## PII Field Controls

By default, webhook payloads contain **no PII**. The fields `studentId` and `senderAddress` are excluded unless explicitly opted in.

### Opt-in to PII fields

Update the school's webhook payload configuration:

```
PUT /api/schools/:id
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "webhookPayloadConfig": {
    "allowedFields": [
      "event", "txHash", "amount", "assetCode", "status", "schoolId",
      "confirmedAt", "referenceCode", "studentId", "senderAddress"
    ]
  }
}
```

### Complete list of available fields

```
event, txHash, transactionHash, amount, asset, assetCode, status, schoolId,
ts, timestamp, correlationId, referenceCode, finalFee, feeValidationStatus,
confirmedAt, ledgerSequence, reason, isSuspicious, originalTxHash,
refundTxHash, refundedAt,
studentId   ← PII: opt-in only
senderAddress ← PII: opt-in only
```

---

## Multiple Endpoints & Event Subscriptions

Each school can register multiple webhook endpoints, each subscribing to a different subset of events.

```
POST /api/webhook-endpoints
Authorization: Bearer <school-token>
X-School-ID: SCH-1
Content-Type: application/json

{
  "url": "https://erp.school.com/payments",
  "subscribedEvents": ["payment.confirmed"],
  "description": "ERP payment sync"
}
```

### Manage endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/webhook-endpoints` | Create endpoint |
| `GET` | `/api/webhook-endpoints` | List all endpoints for the school |
| `GET` | `/api/webhook-endpoints/:id` | Get a single endpoint |
| `PUT` | `/api/webhook-endpoints/:id` | Update URL, events, or `isActive` |
| `DELETE` | `/api/webhook-endpoints/:id` | Delete endpoint |

Set `isActive: false` to pause an endpoint without deleting it.

---

## Delivery History & Replay

Every delivery attempt is logged with status code, response body (truncated to 1 KB), duration, and error details. Logs are retained for **30 days** by default (configurable via `WEBHOOK_DELIVERY_RETENTION_DAYS`).

```
GET  /api/webhook-deliveries?endpointId=<id>&page=1&limit=20
POST /api/webhook-deliveries/:id/replay
```

---

## SSRF Protections

All webhook URLs are validated at registration and before every delivery:

- Only `https://` URLs are accepted.
- Private IP ranges (RFC 1918, loopback, link-local, CGNAT, metadata endpoints) are blocked.
- IPv6 ULA, IPv4-mapped private addresses, and NAT64 prefixes are blocked.
- **Redirects are disabled** — a 3xx response is treated as a delivery failure.
- Response bodies are capped at 64 KB.
- DNS is re-resolved immediately before each delivery (DNS-rebinding defence).

---

## Local Testing with ngrok or smee.io

### Option A: ngrok

1. Install ngrok: https://ngrok.com/download

2. Start a tunnel to your local server:

   ```bash
   ngrok http 3001
   ```

   ngrok outputs a public HTTPS URL, e.g., `https://abc123.ngrok.io`.

3. Register that URL as a webhook endpoint:

   ```bash
   curl -X POST http://localhost:5000/api/webhook-endpoints \
     -H "Authorization: Bearer $TOKEN" \
     -H "X-School-ID: SCH-1" \
     -H "Content-Type: application/json" \
     -d '{
       "url": "https://abc123.ngrok.io/webhook",
       "subscribedEvents": ["payment.confirmed", "payment.failed"],
       "description": "local dev"
     }'
   ```

4. Trigger a test payment and watch the ngrok dashboard at `http://localhost:4040`.

### Option B: smee.io

1. Visit https://smee.io and create a new channel. Copy the channel URL.

2. Install the smee client:

   ```bash
   npm install --global smee-client
   ```

3. Forward events to your local server:

   ```bash
   smee --url https://smee.io/your-channel-id --target http://localhost:3001/webhook
   ```

4. Register the smee URL as a webhook endpoint (same as ngrok step 3).

### Verifying signatures locally

When testing, export your endpoint's secret:

```bash
export WEBHOOK_SECRET=whsec_a1b2c3d4...
```

The Node.js `verifyWebhookV2` function above will work as-is with this secret.

---

## Admin Replay Endpoint

To re-deliver a failed or past delivery without re-triggering the payment:

```
POST /api/webhook-deliveries/:id/replay
Authorization: Bearer <admin-token>
```

To replay from the DLQ:

```
POST /api/admin/webhooks/dlq/:id/retry
Authorization: Bearer <admin-token>
```

To replay a webhook for a specific payment event:

```
POST /api/admin/webhooks/:paymentId/replay
Authorization: Bearer <admin-token>
```

---

## Troubleshooting

| Problem | Likely Cause | Solution |
|---------|-------------|----------|
| `401` response from your endpoint | Signature verification failed | Verify you are reading the **raw body bytes** before JSON parsing; check the secret is correct |
| `timestamp out of tolerance` | Server clock skew | Ensure your server clock is synchronized (NTP); tolerance is ±5 minutes |
| Duplicate events received | At-least-once delivery + admin replay | Use `X-StellarEduPay-Delivery-ID` as idempotency key |
| Webhook not firing | Endpoint `isActive: false`, or event not in `subscribedEvents` | Check endpoint configuration via `GET /api/webhook-endpoints` |
| URL rejected at registration | Private IP range or HTTP scheme | Use a public HTTPS URL; ngrok/smee for local testing |
| DLQ accumulating | Endpoint returning non-2xx or timing out | Check your endpoint logs; increase response time or move processing async |
| V1 signature works but V2 fails | Signing base construction error | Ensure the signing base is `timestamp + "." + deliveryId + "." + rawBodyString` |

---

## Implementation References

| Component | File |
|-----------|------|
| Webhook service (signing, delivery, retry) | `backend/src/services/webhookService.js` |
| Payload builder (field filtering) | `backend/src/utils/buildWebhookPayload.js` |
| Webhook endpoint management | `backend/src/controllers/webhookEndpointsController.js` |
| SSRF URL validation | `backend/src/utils/validateWebhookUrl.js` |
| Delivery model | `backend/src/models/webhookDeliveryModel.js` |
| Webhook metrics | `backend/src/metrics/webhookMetrics.js` |
| Signature verification tests | `tests/webhookSignatureVerification.test.js` |
| Replay protection tests | `tests/issue-799-webhook-replay-protection.test.js` |
| HMAC signing tests | `tests/issue-1177-webhook-hmac-signing.test.js` |
