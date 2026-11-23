# Webhook Integration & Replay Handling Guide

This guide is the companion to [`docs/WEBHOOK_INTEGRATION.md`](./WEBHOOK_INTEGRATION.md).
It covers the practical concerns that webhook consumers encounter after the initial
setup: correctly verifying signatures, handling duplicate deliveries, meeting
response-time requirements, and reasoning about retry semantics.

**Read this if you are:**
- Implementing a new webhook receiver
- Debugging failed or repeated deliveries
- Auditing an existing integration for correctness

---

## Table of contents

1. [How deliveries work end-to-end](#1-how-deliveries-work-end-to-end)
2. [Timestamp tolerance](#2-timestamp-tolerance)
3. [Signature verification (V2)](#3-signature-verification-v2)
4. [Why you must verify the signature](#4-why-you-must-verify-the-signature)
5. [Idempotency: handling duplicate deliveries](#5-idempotency-handling-duplicate-deliveries)
6. [Response requirements](#6-response-requirements)
7. [Retry schedule and delivery guarantees](#7-retry-schedule-and-delivery-guarantees)
8. [Replay-safe processing checklist](#8-replay-safe-processing-checklist)
9. [Common mistakes and how to avoid them](#9-common-mistakes-and-how-to-avoid-them)
10. [Testing your receiver locally](#10-testing-your-receiver-locally)

---

## 1. How deliveries work end-to-end

```
StellarEduPay backend                    Your webhook receiver
        │
        │  POST /your-endpoint
        │  Content-Type: application/json
        │  X-StellarEduPay-Timestamp: <unix-seconds>
        │  X-StellarEduPay-Delivery-ID: <uuid>
        │  X-StellarEduPay-Signature-V2: sha256=<hex>
        │  X-StellarEduPay-Signature: sha256=<hex>   ← V1 (deprecated, present during transition)
        │  X-Webhook-Event: payment.confirmed
        │  Body: { "event": "...", "timestamp": "...", "data": { … } }
        │──────────────────────────────────────────────────────────►│
        │                                                           │
        │                                   HTTP 2xx within 10 s   │
        │◄──────────────────────────────────────────────────────────│
        │
        │  (on non-2xx or timeout)
        │  Retry after 1 min → 5 min → 15 min   (up to 3 attempts)
        │  Max-attempts exhausted → dead-letter queue
```

Each delivery attempt carries a **stable delivery ID** (`X-StellarEduPay-Delivery-ID`).
The same UUID is re-used across all retry attempts for the same logical event, so
you can use it as an idempotency key to detect and safely ignore duplicates.

---

## 2. Timestamp tolerance

Every delivery includes `X-StellarEduPay-Timestamp` — the Unix epoch second at
which the delivery was initiated. Your receiver **must** reject deliveries where
the timestamp is outside a ±5-minute window of your server clock:

```
|server_now_seconds − delivery_timestamp_seconds| ≤ 300
```

This prevents an attacker who captured a legitimate delivery from replaying it
hours or days later.

**Clock skew:** a tolerance of 300 seconds (5 minutes) is intentionally wide to
accommodate minor NTP drift. If your server clock is severely out of sync, fix
NTP rather than widening the tolerance.

**Implementation note:** check the timestamp against your server clock *before*
doing any database work. It is cheap, and it short-circuits expensive processing
on stale/replayed requests.

---

## 3. Signature verification (V2)

### What the V2 signature covers

The V2 signature signs:

```
signing_base = timestamp + "." + deliveryId + "." + rawBody
signature    = HMAC-SHA256(webhookSecret, signing_base)
```

Because the timestamp and delivery-ID are **inside** the signed string, an
attacker cannot alter `X-StellarEduPay-Timestamp` or `X-StellarEduPay-Delivery-ID`
without invalidating the signature. This closes the replay window present in V1.

### Step-by-step verification

1. Read `X-StellarEduPay-Timestamp` and reject if outside tolerance (§2).
2. Read `X-StellarEduPay-Delivery-ID`.
3. Read `X-StellarEduPay-Signature-V2`, strip the `sha256=` prefix.
4. Take the **raw body bytes** — the exact bytes received on the wire. Do **not**
   re-serialize a parsed object; JSON key ordering differences will break the check.
5. Compute `HMAC-SHA256(secret, timestamp + "." + deliveryId + "." + rawBody)`.
6. Compare using a constant-time function to prevent timing-oracle attacks.

### Node.js

```js
const crypto = require('crypto');

// WEBHOOK_SECRET: the signing secret for your endpoint.
// Never log or expose this value.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const TOLERANCE_S = 300;

/**
 * Returns { valid: true } or { valid: false, reason: string }.
 * rawBody must be the unmodified Buffer/string as received.
 */
function verifyV2(rawBody, headers) {
  // 1. Timestamp range check
  const ts = parseInt(headers['x-stellaredupay-timestamp'], 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_S) {
    return { valid: false, reason: 'timestamp out of tolerance' };
  }

  // 2. Extract signature components
  const deliveryId = headers['x-stellaredupay-delivery-id'] || '';
  const sigHeader = headers['x-stellaredupay-signature-v2'] || '';
  const [prefix, provided] = sigHeader.split('=');
  if (prefix !== 'sha256' || !provided) {
    return { valid: false, reason: 'missing or malformed V2 signature' };
  }

  // 3. Recompute — use raw bytes, not a re-serialised object
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const signingBase = `${ts}.${deliveryId}.${body}`;
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(signingBase)
    .digest('hex');

  // 4. Constant-time comparison
  try {
    const exp = Buffer.from(expected, 'hex');
    const got = Buffer.from(provided, 'hex');
    if (exp.length !== got.length) return { valid: false, reason: 'length mismatch' };
    if (!crypto.timingSafeEqual(exp, got)) return { valid: false, reason: 'signature mismatch' };
  } catch {
    return { valid: false, reason: 'invalid hex in signature' };
  }

  return { valid: true };
}
```

### Express integration (preserve raw body)

Express parses JSON by default and discards the raw bytes. Use the `verify`
callback to capture them before parsing:

```js
const express = require('express');
const app = express();

// Attach rawBody to req before any parsing occurs
app.use(
  express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
  })
);

app.post('/webhook', (req, res) => {
  const { valid, reason } = verifyV2(req.rawBody, req.headers);
  if (!valid) {
    console.warn('Webhook rejected:', reason);
    return res.status(401).end();
  }
  // … handle event …
  res.status(200).end();
});
```

### Python (Flask)

```python
import hashlib
import hmac
import time
from flask import Flask, request, abort

app = Flask(__name__)

WEBHOOK_SECRET = os.environ['WEBHOOK_SECRET']  # never hard-code
TOLERANCE_S = 300

def verify_v2(raw_body: bytes, headers: dict) -> bool:
    try:
        ts = int(headers.get('X-StellarEduPay-Timestamp', '0'))
    except ValueError:
        return False
    if abs(time.time() - ts) > TOLERANCE_S:
        return False

    delivery_id = headers.get('X-StellarEduPay-Delivery-ID', '')
    sig_header  = headers.get('X-StellarEduPay-Signature-V2', '')
    if not sig_header.startswith('sha256='):
        return False
    provided = sig_header.removeprefix('sha256=')

    body_str     = raw_body.decode('utf-8')
    signing_base = f'{ts}.{delivery_id}.{body_str}'.encode('utf-8')
    expected     = hmac.new(
        WEBHOOK_SECRET.encode('utf-8'), signing_base, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, provided)

@app.route('/webhook', methods=['POST'])
def webhook():
    if not verify_v2(request.get_data(), dict(request.headers)):
        abort(401)
    event = request.json
    # … handle event …
    return '', 200
```

---

## 4. Why you must verify the signature

Skipping signature verification means:

- **Anyone** who knows your endpoint URL can inject fake payment events.
- A student's fee could be marked paid without any actual Stellar transaction.
- Dispute and refund events could be forged.

Always verify. Always use constant-time comparison. Never accept a delivery
whose signature does not match or whose timestamp is stale.

---

## 5. Idempotency: handling duplicate deliveries

The same logical event can arrive more than once:

- Your server returned a non-2xx response on the first attempt and StellarEduPay retried.
- A network failure caused a timeout; StellarEduPay assumed failure and retried
  even though your server did receive and process the delivery.
- A manual replay was triggered from the admin DLQ.

The `X-StellarEduPay-Delivery-ID` header is a stable UUID that is **the same**
across all retry attempts for one logical event. Store it as a primary key and
skip processing when you see it again.

### Idempotent receiver pattern

```js
// Durable store — Redis, Postgres, or any database.
// Do NOT use a process-local Set; it resets on restart and does not
// work across multiple replicas.
const redis = require('ioredis');
const client = new redis(process.env.REDIS_URL);

const IDEMPOTENCY_TTL_S = 7 * 24 * 3600; // keep IDs for 7 days

app.post('/webhook', async (req, res) => {
  const { valid } = verifyV2(req.rawBody, req.headers);
  if (!valid) return res.status(401).end();

  const deliveryId = req.headers['x-stellaredupay-delivery-id'];

  // Atomic set-if-not-exists: returns 1 on first sight, 0 on duplicate
  const isNew = await client.set(
    `wh:seen:${deliveryId}`, '1', 'EX', IDEMPOTENCY_TTL_S, 'NX'
  );

  if (!isNew) {
    // Already processed — acknowledge without re-processing
    return res.status(200).json({ status: 'duplicate, already processed' });
  }

  // First delivery — process the event
  const { event, data } = req.body;
  await handleEvent(event, data);

  res.status(200).end();
});
```

**Retention note:** StellarEduPay keeps delivery IDs in its own replay-protection
store for `WEBHOOK_REPLAY_WINDOW_S` (default 300 s / 5 minutes). Your own
idempotency store should be longer-lived (7 days recommended) to guard against
manual replays triggered from the admin UI.

---

## 6. Response requirements

| Requirement | Detail |
|-------------|--------|
| **Status code** | Return any **2xx** status (200, 201, 202 all accepted) |
| **Timeout** | Respond within **10 seconds**. After 10 s the connection is closed and StellarEduPay counts it as a failure. |
| **Body** | The response body is recorded (truncated to 1 KB) but is not interpreted. An empty body is fine. |
| **Redirects** | Do not redirect webhook traffic. StellarEduPay blocks 3xx responses as an SSRF defence (`SSRF_REDIRECT_BLOCKED`). |

### Async processing pattern (when your handler takes > 10 s)

```js
app.post('/webhook', async (req, res) => {
  const { valid } = verifyV2(req.rawBody, req.headers);
  if (!valid) return res.status(401).end();

  // Acknowledge immediately — before any slow processing
  res.status(202).json({ status: 'accepted' });

  // Process asynchronously after the response has been sent
  const deliveryId = req.headers['x-stellaredupay-delivery-id'];
  setImmediate(() => processEventAsync(req.body, deliveryId).catch(console.error));
});
```

If you return a non-2xx response (or no response before the 10-second timeout),
StellarEduPay will retry. Design your handler to be idempotent before enabling
async processing, otherwise a retry arriving while the first async job is still
running could double-process the event.

---

## 7. Retry schedule and delivery guarantees

### Retry schedule

| Attempt | When |
|---------|------|
| Initial | Immediately on event |
| 1st retry | 1 minute after failure |
| 2nd retry | 5 minutes after 1st retry |
| 3rd retry | 15 minutes after 2nd retry |
| Dead-letter | After all retries exhausted |

**Total window:** roughly 21 minutes from the first attempt to dead-letter.

### Delivery guarantee

StellarEduPay provides **at-least-once** delivery:

- A delivery may arrive **more than once** (retries, manual replays).
- A delivery will **not be silently dropped** — if all attempts fail, the
  delivery is moved to the dead-letter queue and an admin can manually re-trigger it.
- Delivery order is **not guaranteed** across different events. A `payment.failed`
  may arrive before `payment.confirmed` for separate payments if one was delayed
  by a retry. Design your receiver to handle events in any order.

### Dead-letter queue

Failed deliveries beyond the retry limit are accessible to admins at:

```
GET  /api/admin/webhooks/dlq
POST /api/admin/webhooks/dlq/:id/retry
```

Dead-letter events are re-delivered with the **same delivery ID**, so your
idempotency store must be populated for recent delivery IDs if you want to
prevent duplicate processing after a manual replay.

---

## 8. Replay-safe processing checklist

Use this checklist when implementing or auditing a webhook receiver.

**Verification**
- [ ] Signature is verified on every request before any business logic runs
- [ ] Timestamp is checked against a ±5-minute window before signature computation
- [ ] Verification uses a constant-time comparison function (not `===` or `==`)
- [ ] Raw body bytes are used for HMAC, not a re-serialised parsed object
- [ ] `V2` header (`X-StellarEduPay-Signature-V2`) is verified, not V1

**Idempotency**
- [ ] `X-StellarEduPay-Delivery-ID` is stored in a durable, shared store (not process memory)
- [ ] Duplicate delivery IDs are acknowledged with 2xx but not re-processed
- [ ] Idempotency keys are retained for at least 7 days (longer than StellarEduPay's retry window)

**Response**
- [ ] 2xx is returned within 10 seconds
- [ ] Slow handlers respond immediately with 202 and process asynchronously
- [ ] No redirects are issued for the webhook endpoint

**Ordering and state**
- [ ] Business logic does not assume events arrive in a specific order
- [ ] State transitions are idempotent (applying the same event twice has the same result)

**Security**
- [ ] The webhook secret is stored in an environment variable or secrets manager — not in source code
- [ ] The webhook secret is never logged, included in error responses, or returned to the client
- [ ] The endpoint is only accessible over HTTPS

---

## 9. Common mistakes and how to avoid them

### Verifying V1 instead of V2

V1 signs only the JSON body. Because the timestamp is not covered by V1, an
attacker can rewrite `X-StellarEduPay-Timestamp` and defeat the tolerance check.
Always verify `X-StellarEduPay-Signature-V2`. V1 will be removed on 2027-02-28.

### Re-serialising the parsed body for HMAC

```js
// WRONG — key ordering in JSON.stringify is not guaranteed across engines
const sig = hmac.update(JSON.stringify(req.body)).digest('hex');

// RIGHT — use the raw bytes exactly as received
const sig = hmac.update(rawBody).digest('hex');
```

### Using a process-local Set for idempotency

```js
// WRONG — resets on restart, not shared across replicas
const seen = new Set();
if (seen.has(deliveryId)) return res.status(200).end();
seen.add(deliveryId);
```

Use Redis `SET ... NX` or a database upsert with a unique index on `deliveryId`.

### Returning 4xx on duplicate deliveries

Returning 4xx on a duplicate causes StellarEduPay to schedule another retry,
which defeats idempotency. Return **2xx** with a note that the event was already
processed.

### Widening the timestamp tolerance to suppress false rejections

A wider tolerance means stale replays are accepted. Fix the root cause (NTP
skew, deployment lag) rather than widening the window.

---

## 10. Testing your receiver locally

Use a tool like [ngrok](https://ngrok.com/) or [localtunnel](https://localtunnel.me/)
to expose your local server, then register the public URL as your webhook endpoint.

To generate a test delivery manually, you can construct a signed request that
matches the V2 format:

```js
// test-webhook.js — send a signed test delivery to your local endpoint
const crypto = require('crypto');
const http = require('http');

const SECRET = 'test-secret-do-not-use-in-production'; // must match your endpoint config
const TARGET_URL = 'http://localhost:3000/webhook';

const deliveryId = crypto.randomUUID();
const timestamp = Math.floor(Date.now() / 1000);
const event = {
  event: 'payment.confirmed',
  timestamp: new Date(timestamp * 1000).toISOString(),
  data: {
    txHash: 'test-tx-hash-0000000000000000000000000000000000000000000000000000000000000000',
    amount: 100,
    assetCode: 'XLM',
    status: 'confirmed',
    schoolId: 'SCH-TEST',
    confirmedAt: new Date().toISOString(),
    referenceCode: 'REF-TEST-001',
  },
};

const rawBody = JSON.stringify(event);
const signingBase = `${timestamp}.${deliveryId}.${rawBody}`;
const sigV2 = crypto
  .createHmac('sha256', SECRET)
  .update(signingBase)
  .digest('hex');

const url = new URL(TARGET_URL);
const options = {
  hostname: url.hostname,
  port: url.port || 3000,
  path: url.pathname,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-StellarEduPay-Timestamp': String(timestamp),
    'X-StellarEduPay-Delivery-ID': deliveryId,
    'X-StellarEduPay-Signature-V2': `sha256=${sigV2}`,
    'X-Webhook-Event': event.event,
    'Content-Length': Buffer.byteLength(rawBody),
  },
};

const req = http.request(options, (res) => {
  console.log(`Status: ${res.statusCode}`);
});
req.write(rawBody);
req.end();
```

Run with `node test-webhook.js`. Verify that:
- A fresh request is accepted (2xx).
- Re-sending the same `deliveryId` is acknowledged but not re-processed (2xx, logged as duplicate).
- Altering `rawBody` or any header causes a 401.
- Setting the timestamp more than 5 minutes in the past causes a 401.

---

## Related documentation

- [`docs/WEBHOOK_INTEGRATION.md`](./WEBHOOK_INTEGRATION.md) — endpoint registration, event types, PII controls, SSRF mitigations, delivery history retention
- [`docs/security.md`](./security.md) — full threat model and HMAC signing design decisions
- [`docs/idempotency-payment-verification.md`](./idempotency-payment-verification.md) — how idempotency works on the server side
- [`docs/retry-backends.md`](./retry-backends.md) — BullMQ vs MongoDB retry backend guarantee matrix
