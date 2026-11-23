# ADR-003: Webhook Ownership and HMAC Signing

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2024-05-10 |
| **Review date** | 2027-05-10 |
| **Authors** | Payment Platform Team |
| **Code references** | `backend/src/services/webhookService.js`, `backend/src/models/webhookEndpointModel.js`, `backend/src/models/webhookRetryModel.js`, `backend/src/utils/buildWebhookPayload.js`, `docs/WEBHOOK_INTEGRATION.md`, `docs/webhook-replay-and-integration-guide.md` |

---

## Context

When a payment event occurs (confirmed, failed, suspicious, disputed), external
systems — school ERPs, notification services, reconciliation engines — need to
receive a real-time notification. The notification system must answer three
questions:

1. **Who owns the endpoint?** Schools are multi-tenant; a webhook registered by
   School A must not receive events from School B.
2. **How does the receiver verify the delivery is authentic?** Any system that
   knows the webhook URL could send forged events.
3. **How does the receiver detect replays?** An attacker who captures a valid
   delivery could replay it to trigger duplicate payment confirmations.

---

## Decision

**Per-school, per-endpoint webhook delivery with V2 HMAC-SHA256 signatures.**

Key decisions:

- Each school owns one or more `WebhookEndpoint` documents, scoped by `schoolId`.
- Each endpoint has an independent `secret` (HMAC key), generated at creation
  and encrypted at rest (`WEBHOOK_SECRET_ENCRYPTION_KEY`).
- The V2 signature covers `timestamp.deliveryId.rawBody`, binding the timestamp
  and a per-delivery UUID to the HMAC. This makes timestamp rewriting and
  delivery-ID substitution detectable.
- V1 (body-only HMAC) is retained during a migration window and will be removed
  on 2027-02-28.
- Replay protection on the sending side uses Redis `SET NX` with a 5-minute TTL
  (`WEBHOOK_REPLAY_WINDOW_S`). Falls back to in-process Map only when
  `WEBHOOK_REPLAY_NONCES_LOCAL=true` (single-process dev/test only).
- PII fields (`studentId`, `senderAddress`) are excluded from webhook payloads
  by default; schools must explicitly opt in via `webhookPayloadConfig.allowedFields`.
- SSRF protection: all webhook URLs are validated at registration and re-validated
  at every delivery (DNS-rebinding defence). Redirects are blocked.

---

## Alternatives considered

### 1. Shared secret per school (not per endpoint)

**Rejected.** A school with multiple endpoints (ERP + notification service +
accounting system) would share one secret across all integrations. Rotating the
secret for one integration would break others. Per-endpoint secrets allow
independent rotation.

### 2. Asymmetric signatures (RSA or ECDSA)

**Rejected.** RSA/ECDSA require key pair management, certificate infrastructure,
and are significantly more complex to implement and verify. HMAC-SHA256 with a
shared secret is the de facto standard for webhook authentication (GitHub,
Stripe, Twilio all use it) and is sufficient when the secret is properly
protected at rest.

### 3. V1-only (body HMAC, no timestamp binding)

**Rejected.** V1 signs only the JSON body. An attacker who captures a legitimate
delivery can replay it indefinitely by rewriting `X-StellarEduPay-Timestamp` to
a fresh value, bypassing the tolerance window. V2 closes this by including the
timestamp in the signed string. V1 was the initial implementation; V2 was added
in issue #1287.

### 4. No replay protection — rely solely on receiver idempotency

**Rejected.** Idempotency on the receiver side requires the receiver to implement
a durable dedup store. Many integrators will not do this correctly. Defence in
depth: the sender enforces replay protection; the receiver is also expected to
implement idempotency (documented in `docs/webhook-replay-and-integration-guide.md`).

### 5. Include PII in all payloads by default

**Rejected.** Data minimisation: webhook payloads transit over the public internet
to third-party systems. Student PII sent to an ERP integration is appropriate;
the same PII sent to a notification-only endpoint is unnecessary exposure.
Opt-in PII fields put the control with the school administrator.

---

## Consequences

**Positive:**
- Tenant isolation is enforced at the delivery layer — School A's events cannot
  reach School B's endpoint even if the endpoint URLs are identical.
- Per-endpoint secrets limit blast radius of a secret compromise to one
  integration, not an entire school.
- V2 signatures prevent replay attacks without requiring the receiver to implement
  a nonce store (though they should still deduplicate on `deliveryId`).
- PII opt-in reduces the risk of inadvertent data exposure to third-party systems.

**Negative:**
- Integrators must migrate from V1 to V2 before 2027-02-28. The dual-signature
  transition window adds header overhead (two signatures per delivery).
- The Redis dependency for replay protection means a Redis outage causes all
  webhook deliveries to be treated as replays unless
  `WEBHOOK_REPLAY_NONCES_LOCAL=true` (which degrades multi-replica safety).
- Per-endpoint secrets increase operational complexity: each endpoint has its own
  secret to manage. The webhook secret rotation script
  (`scripts/rotate-webhook-encryption-key.js`) automates re-encryption.

**Security properties:**
- Webhook secrets are encrypted at rest (migration 021).
- The encryption key is rotated via `scripts/rotate-webhook-encryption-key.js`
  with a dual-key grace period.
- Webhook URLs are SSRF-protected: private/loopback/link-local IPs are blocked;
  DNS is re-resolved before every delivery to detect DNS-rebinding attacks.

---

## Review criteria

Revisit this ADR if:
- V1 removal date (2027-02-28) approaches and integrators have not migrated.
- Redis is replaced as the replay-nonce store.
- A new SSRF bypass technique is identified that the current validation does not cover.
- Regulatory requirements mandate different signature algorithms (e.g. FIPS 140-2
  environments that require ECDSA over HMAC-SHA256).
