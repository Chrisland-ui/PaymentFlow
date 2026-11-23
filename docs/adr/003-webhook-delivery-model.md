# ADR-003: Webhook Delivery Model

**Status:** Accepted
**Date:** 2024-03-05
**Authors:** PaymentFlow Core Team

---

## Context

Schools need to be notified when a payment is confirmed so they can update their own student management systems (SMS, student portals, accounting software) without polling the StellarEduPay API. We need an event notification mechanism that is:

- Reliable: delivery is guaranteed even if the recipient is temporarily down.
- Verifiable: the recipient can confirm the payload originated from StellarEduPay.
- Operable: failed deliveries are visible and retried automatically.
- Safe: delivery URLs cannot be used to probe internal network resources (SSRF).

### Alternatives Evaluated

| Approach | Reliability | Recipient verification | School control | Verdict |
|----------|-------------|----------------------|----------------|---------|
| **HMAC-signed HTTP webhooks with retry** | Yes (retry queue) | HMAC-SHA256 signature | School registers URL | **Chosen** |
| Server-Sent Events (SSE) only | No (ephemeral) | Session auth | Requires persistent connection | Insufficient for server-to-server |
| Pub/Sub (Google Pub/Sub, AWS SNS) | Yes | Subscription IAM | Platform-specific | Too much external coupling |
| Message broker (RabbitMQ, Kafka) | Yes | Yes | Requires school to run a consumer | Too complex for small schools |
| Polling (`GET /api/payments/pending`) | N/A (pull model) | JWT auth | Simple | Latency depends on poll frequency; no push |

### Webhook vs SSE

StellarEduPay ships both mechanisms for different consumer types:

- **SSE (`/api/payments/sse`):** Real-time in-browser push for the admin dashboard. Ephemeral — reconnects on load, no persistence needed.
- **Webhooks:** Durable server-to-server integration for external SIS/ERP systems. Persisted with retry.

This ADR covers the webhook model only.

### Signature Scheme Options

| Scheme | Security | Implementation Complexity | Standard? |
|--------|----------|--------------------------|-----------|
| **HMAC-SHA256 over payload + timestamp** | Strong; timestamp prevents replay | Low | Yes (GitHub, Stripe, Twilio) |
| RSA signature | Stronger | Higher | Less common in webhooks |
| Shared secret in header | Weak (header sniffing) | Very low | No (deprecated) |
| No signature | None | Zero | Not acceptable |

HMAC-SHA256 with a timestamp was chosen because it matches the industry standard (GitHub webhooks, Stripe events) — recipients are familiar with it and existing libraries can be reused.

### Replay Protection

A timestamp is embedded in the `X-StellarEduPay-Timestamp` header. Recipients should reject payloads with a timestamp older than 5 minutes. In addition, webhook delivery IDs are stored in an `inboundWebhookNonces` collection with TTL so that replay of a valid signed payload within the acceptance window is detected and rejected.

## Decision

Implement **HMAC-SHA256-signed HTTP POST webhooks** with:

1. Per-school webhook URL and secret (stored encrypted at rest using `webhookSecretEncryption.js`).
2. Signature in `X-StellarEduPay-Signature: sha256=<hex>` header, computed over `timestamp + "." + body`.
3. Timestamp in `X-StellarEduPay-Timestamp` header.
4. Delivery retry via the `webhookDeliveries` collection with exponential backoff (BullMQ or MongoDB fallback).
5. SSRF protection: delivery URLs are validated on registration — RFC 1918, loopback, and link-local addresses are rejected.
6. Per-school `webhookPayloadConfig.allowedFields` whitelist to prevent PII leakage in webhook payloads by default.

## Consequences

**Positive:**
- Schools can build real-time integrations without polling.
- HMAC verification provides cryptographic proof of origin; recipients cannot be spoofed.
- Failed deliveries are automatically retried and visible in `webhookDeliveries` collection.
- Replay protection prevents an intercepted webhook from being re-delivered maliciously.

**Negative:**
- Schools must implement the HMAC verification on their receiver. This is documented in `docs/WEBHOOK_INTEGRATION.md`.
- The webhook secret must be rotated if compromised. Currently there is no self-service secret rotation endpoint — it requires admin action via `PUT /api/schools/:id`.
- Delivery is best-effort within the retry window (`webhookDeliveryTTL` index, default 7 days). After the TTL, undelivered webhooks are dropped without further attempt.

**Security constraints imposed:**
- `webhookSecret` is encrypted at rest (migration 017). Never logged.
- Webhook URLs must pass SSRF validation before first use.
- `allowedFields` defaults to a safe minimal set; `studentId` and `senderAddress` are excluded unless the school explicitly opts in.

---

## References

- Webhook service: [`backend/src/services/webhookService.js`](../../backend/src/services/webhookService.js)
- Webhook secret encryption: [`backend/src/services/webhookSecretEncryption.js`](../../backend/src/services/webhookSecretEncryption.js)
- SSRF validation: [`backend/src/utils/validateWebhookUrl.js`](../../backend/src/utils/validateWebhookUrl.js)
- Integration guide: [`docs/WEBHOOK_INTEGRATION.md`](../WEBHOOK_INTEGRATION.md)
- Replay protection migration: [`backend/migrations/028_add_webhook_delivery_ttl_index.js`](../../backend/migrations/028_add_webhook_delivery_ttl_index.js)
