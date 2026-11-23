# Environment Variables Reference

Complete reference for every environment variable used by PaymentFlow across all services. This document covers purpose, example values, sensitivity classification, rotation owner, and rotation frequency.

> **Source of truth for operational classifications**: see also [`docs/environment-reference.md`](environment-reference.md) for the complementary ownership and sensitivity matrix.
> **Executable example values**: [`backend/.env.example`](../backend/.env.example) and [`frontend/.env.local.example`](../frontend/.env.local.example).

---

## Sensitivity Classification

| Level | Meaning | Must never appear in… |
|-------|---------|----------------------|
| `CRITICAL` | Cryptographic key, private credential, signing secret | Logs, commits, screenshots, issue comments, chat |
| `SECRET` | Password, token, API key, bearer credential | Logs, commits, screenshots, issue comments |
| `RESTRICTED` | Identifier, address, or internal URL not for public broadcast | Public repositories, client-side code |
| `INTERNAL` | Non-secret service configuration | Only avoid in public documentation with real values |
| `PUBLIC` | Safe to ship to a browser or public repository | — |

---

## Required Variables

The backend process **fails to start** when these are absent or invalid.

| Variable | Service | Purpose | Example | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|------------|----------------|-------------------|
| `MONGO_URI` | Backend | MongoDB connection string including replica-set parameter | `mongodb://localhost:27017/stellaredupay?replicaSet=rs0` | `CRITICAL` | Platform / database team | On credential compromise; rotate with DB password changes |
| `JWT_SECRET` | Backend | HMAC-SHA256 key for signing and verifying all JWTs. Must be ≥ 32 characters. | *(generate: `openssl rand -hex 32`)* | `CRITICAL` | Security / platform | Every 90 days; immediately on suspected compromise |

---

## Authentication & JWT

| Variable | Service | Purpose | Default | Example | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|---------|------------|----------------|-------------------|
| `JWT_SECRET` | Backend | Signs all access tokens | required | *(64-char hex)* | `CRITICAL` | Security | 90 days |
| `JWT_EXPIRES_IN` | Backend | Access token lifetime | `8h` | `8h` | `INTERNAL` | Security | With JWT_SECRET rotation |
| `JWT_ACCESS_TOKEN_TTL` | Backend | Access token TTL (alias) | `8h` | `8h` | `INTERNAL` | Security | With JWT_SECRET rotation |
| `JWT_REFRESH_TOKEN_TTL` | Backend | Refresh token lifetime | `30d` | `30d` | `INTERNAL` | Security | With JWT_SECRET rotation |
| `ADMIN_USERNAME` | Backend | Break-glass super-admin username | `admin` | `admin` | `RESTRICTED` | App operator | With credential rotation |
| `ADMIN_PASSWORD` | Backend | Plaintext admin password (**dev only** — use hash in production) | unset | *(never use in prod)* | `CRITICAL` | App operator | Immediately after setting |
| `ADMIN_PASSWORD_HASH` | Backend | Bcrypt hash of admin password (preferred over `ADMIN_PASSWORD`) | unset | `$2a$12$...` | `SECRET` | App operator | Every 90 days |
| `REQUIRE_MFA` | Backend | Force MFA setup for all admins before accessing protected endpoints | `false` | `true` | `INTERNAL` | Security | N/A (config flag) |

---

## Signing & Encryption Keys

> ⚠️ These are the most sensitive variables in the system. A compromise of `SIGNER_MASTER_KEY` exposes all school wallet secret keys.

| Variable | Service | Purpose | Default | Example | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|---------|------------|----------------|-------------------|
| `SIGNER_MASTER_KEY` | Backend | AES-256-GCM master key encrypting all school wallet secrets. Must be 64-char hex. | required if wallets held | *(generate: `openssl rand -hex 32`)* | `CRITICAL` | Security / platform | Every 180 days; see `scripts/rotate-signer-master-key.js` |
| `SIGNER_MASTER_KEY_OLD` | Backend | Previous master key — used only during key rotation, then removed | unset | *(previous key)* | `CRITICAL` | Security / platform | Remove immediately after rotation |
| `SIGNER_KEY_SOURCE` | Backend | Key source: `env`, `aws_secrets_manager`, or `http` | `env` | `aws_secrets_manager` | `INTERNAL` | Security | N/A |
| `SIGNER_MASTER_KEY_SECRET_ID` | Backend | AWS Secrets Manager secret ID for the master key | unset | `stellaredupay/signer-master-key` | `RESTRICTED` | Security | N/A |
| `SIGNER_MASTER_KEY_HTTP_URL` | Backend | HTTP URL to fetch master key (for Vault/GCP sidecars) | unset | `https://vault.internal/v1/key` | `RESTRICTED` | Security | N/A |
| `SIGNER_MASTER_KEY_HTTP_TOKEN` | Backend | Bearer token for the HTTP key source | unset | *(bearer token)* | `SECRET` | Security | With key rotation |
| `STUDENT_PII_ENCRYPTION_KEY` | Backend | AES-256-GCM key for encrypting student PII fields | unset; generated | *(64-char hex)* | `CRITICAL` | Security / platform | Every 180 days |
| `AUDIT_HMAC_KEY` | Backend | HMAC key for signing audit log pagination cursors | falls back to `JWT_SECRET` | *(32-char hex)* | `CRITICAL` | Security | With JWT_SECRET rotation |
| `AUDIT_CURSOR_HMAC_KEY` | Backend | Alias for `AUDIT_HMAC_KEY` | falls back to `JWT_SECRET` | *(32-char hex)* | `CRITICAL` | Security | With JWT_SECRET rotation |
| `RECEIPT_SIGNATURE_SECRET` | Backend | Signs payment receipt documents | unset | *(32-char hex)* | `CRITICAL` | Security | Every 90 days |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | Backend | Encrypts per-school webhook HMAC secrets at rest | unset; generated | *(32-char hex)* | `CRITICAL` | Security | Every 90 days; see `scripts/rotate-webhook-encryption-key.js` |
| `WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS` | Backend | Previous webhook encryption key (rotation window) | unset | *(previous key)* | `CRITICAL` | Security | Remove after rotation |

---

## Database

| Variable | Service | Purpose | Default | Example | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|---------|------------|----------------|-------------------|
| `MONGO_URI` | Backend | Full MongoDB connection URI | required | `mongodb://localhost:27017/stellaredupay?replicaSet=rs0` | `CRITICAL` | Platform | On password change |
| `MONGO_ROOT_USERNAME` | Docker | MongoDB root username for Docker Compose | `root` | `root` | `SECRET` | Platform | On credential rotation |
| `MONGO_ROOT_PASSWORD` | Docker | MongoDB root password for Docker Compose | `change_me_to_a_secure_password` | *(strong password)* | `CRITICAL` | Platform | Every 90 days |
| `MONGODB_POOL_SIZE` / `DB_MAX_POOL_SIZE` | Backend | Max connections in pool | `20` | `20` | `INTERNAL` | Platform | N/A |
| `DB_MIN_POOL_SIZE` | Backend | Min idle connections | `10` | `10` | `INTERNAL` | Platform | N/A |
| `DB_MAX_IDLE_TIME_MS` | Backend | Max socket idle time (ms) | `30000` | `30000` | `INTERNAL` | Platform | N/A |
| `DB_CONNECT_TIMEOUT_MS` | Backend | Connection timeout (ms) | `10000` | `10000` | `INTERNAL` | Platform | N/A |
| `DB_SOCKET_TIMEOUT_MS` | Backend | Socket timeout (ms) | `45000` | `45000` | `INTERNAL` | Platform | N/A |
| `DB_MAX_CONCURRENT` | Backend | Max concurrent DB operations | `50` | `50` | `INTERNAL` | Platform | N/A |
| `DB_READ_CONCERN` | Backend | MongoDB read concern | `majority` | `majority` | `INTERNAL` | Platform | N/A |
| `DB_WRITE_CONCERN` | Backend | MongoDB write concern | `1` | `majority` | `INTERNAL` | Platform | N/A |
| `DB_TRANSACTION_TIMEOUT_MS` | Backend | Multi-document transaction timeout | `30000` | `30000` | `INTERNAL` | Platform | N/A |
| `MONGODB_CONNECT_RETRIES` | Backend | Startup connection retry attempts | `5` | `5` | `INTERNAL` | Platform | N/A |
| `MONGODB_CONNECT_DELAY_MS` | Backend | Initial startup retry delay (ms, doubles each attempt) | `2000` | `2000` | `INTERNAL` | Platform | N/A |

---

## Redis

| Variable | Service | Purpose | Default | Example | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|---------|------------|----------------|-------------------|
| `REDIS_HOST` | Backend | Redis hostname. When unset, falls back to MongoDB retry backend and in-process rate limiting. | unset | `localhost` | `RESTRICTED` | Platform | N/A |
| `REDIS_PORT` | Backend | Redis port | `6379` | `6379` | `INTERNAL` | Platform | N/A |
| `REDIS_PASSWORD` | Backend | Redis AUTH password | unset | *(strong password)* | `SECRET` | Platform | Every 90 days |
| `REDIS_MEM_LIMIT` | Docker | Redis container memory limit | `128m` | `256m` | `INTERNAL` | Platform | N/A |

---

## Stellar & Blockchain

| Variable | Service | Purpose | Default | Example | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|---------|------------|----------------|-------------------|
| `SCHOOL_WALLET_ADDRESS` | Backend | Public key of the school's Stellar wallet (starts with `G`). Never the secret key. | unset (school record authoritative) | `GXXXXXXX...` | `RESTRICTED` | School operator | On wallet migration |
| `STELLAR_NETWORK` | Backend / Frontend | `testnet` or `mainnet` | `testnet` | `mainnet` | `PUBLIC` | App operator | On environment promotion |
| `STELLAR_HORIZON_URL` | Backend | Horizon API endpoint | network default | `https://horizon.stellar.org` | `PUBLIC` | Platform | N/A |
| `STELLAR_HORIZON_URLS` | Backend | Comma-separated HA failover Horizon URLs | unset | `https://horizon.stellar.org,https://...` | `PUBLIC` | Platform | N/A |
| `ACCEPTED_ASSET` | Backend | Asset accepted for fee payments: `XLM` or `USDC` | `XLM` | `USDC` | `PUBLIC` | App operator | On asset change |
| `USDC_ISSUER` | Backend | USDC issuer account on Stellar | network well-known default | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` | `PUBLIC` | App operator | On issuer change |
| `STELLAR_TX_TIMEOUT_SECONDS` | Backend | Max time (s) for a Stellar transaction to be included | `300` | `300` | `INTERNAL` | Payments operator | N/A |
| `STELLAR_TX_FEE_MULTIPLIER` | Backend | Fee multiplier over Horizon p80 fee | `1.5` | `2.0` | `INTERNAL` | Payments operator | N/A |
| `STELLAR_TX_BASE_FEE` | Backend | Fallback base fee in stroops | `100` | `100` | `INTERNAL` | Payments operator | N/A |
| `STELLAR_FEE_SOURCE_SECRET` | Backend | Secret key for fee-bump fee-source account | unset | `S...` | `CRITICAL` | School operator | Every 180 days |
| `STELLAR_NETWORK_TIMEOUT_MS` | Backend | Horizon API call timeout (ms) | `10000` | `10000` | `INTERNAL` | Payments operator | N/A |

---

## Rate Limiting & Security

| Variable | Service | Purpose | Default | Example | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|---------|------------|----------------|-------------------|
| `TRUSTED_PROXY_HOPS` | Backend | Reverse-proxy hops for real IP extraction from `X-Forwarded-For` | `1` | `1` | `INTERNAL` | Platform | On infrastructure change |
| `RATE_LIMIT_WINDOW_MS` | Backend | Global rate-limit window (ms) | `60000` | `60000` | `INTERNAL` | App operator | N/A |
| `RATE_LIMIT_MAX_REQUESTS` | Backend | Max requests per IP per window | `100` | `100` | `INTERNAL` | App operator | N/A |
| `VERIFY_RATE_LIMIT` | Backend | Max `/api/payments/verify` requests per minute per IP | `10` | `10` | `INTERNAL` | App operator | N/A |
| `BULK_IMPORT_RATE_LIMIT` | Backend | Max bulk-import requests per hour per IP | `5` | `5` | `INTERNAL` | App operator | N/A |
| `ALLOWED_ORIGIN` | Backend | CORS allowed origin(s), comma-separated | `http://localhost:3000` | `https://app.school.com` | `PUBLIC` | Platform | On domain change |
| `APP_URL` | Backend | Base URL (required in production for links in emails, etc.) | unset | `https://stellaredupay.example.com` | `PUBLIC` | Platform | On domain change |

---

## Server

| Variable | Service | Purpose | Default | Example | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|---------|------------|----------------|-------------------|
| `PORT` | Backend | HTTP server port | `5000` | `5000` | `INTERNAL` | Platform | N/A |
| `NODE_ENV` | Backend | Runtime environment. Set to `production` to disable Swagger UI. | development | `production` | `INTERNAL` | Platform | N/A |
| `REQUEST_TIMEOUT_MS` | Backend | Inbound HTTP request timeout (ms) | `30000` | `30000` | `INTERNAL` | Platform | N/A |
| `SHUTDOWN_TIMEOUT_MS` | Backend | Graceful shutdown deadline (ms) | `30000` | `30000` | `INTERNAL` | Platform | N/A |
| `MAX_BODY_SIZE` | Backend | Max JSON body size | `10kb` | `10kb` | `INTERNAL` | App operator | N/A |
| `JSON_MAX_DEPTH` | Backend | Max JSON nesting depth | `10` | `10` | `INTERNAL` | App operator | N/A |
| `JSON_MAX_ARRAY_LENGTH` | Backend | Max array length in JSON body | `100` | `100` | `INTERNAL` | App operator | N/A |

---

## Logging

| Variable | Service | Purpose | Default | Example | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|---------|------------|----------------|-------------------|
| `LOG_LEVEL` | Backend | Log verbosity: `error`, `warn`, `info`, `debug` | `info` | `warn` | `INTERNAL` | Ops | N/A |
| `LOG_MAX_SIZE` | Backend | Log file rotation size | `100m` | `500m` | `INTERNAL` | Ops | N/A |
| `LOG_MAX_FILES` | Backend | Log file retention period | `14d` | `30d` | `INTERNAL` | Ops / compliance | N/A |
| `LOG_REDACT_FIELDS` | Backend | Comma-separated request fields to redact in logs | `txHash,studentId,memo,senderAddress` | `txHash,studentId,memo` | `INTERNAL` | Security | N/A |

---

## Webhooks (outbound)

| Variable | Service | Purpose | Default | Example | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|---------|------------|----------------|-------------------|
| `PAYMENT_WEBHOOK_URL` | Backend | Legacy single-school outbound webhook URL | unset | `https://erp.school.com/webhook` | `RESTRICTED` | Integrations | On URL change |
| `WEBHOOK_MAX_ATTEMPTS` | Backend | Max delivery attempts per webhook event | `3` | `3` | `INTERNAL` | Ops | N/A |
| `WEBHOOK_DELIVERY_RETENTION_DAYS` | Backend | Days to retain delivery history | `30` | `30` | `INTERNAL` | Compliance | N/A |
| `WEBHOOK_REPLAY_WINDOW_S` | Backend | Replay protection nonce TTL (seconds) | `300` | `300` | `INTERNAL` | Security | N/A |
| `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` | Backend | Max age of inbound webhook timestamp | `300` | `300` | `INTERNAL` | Security | N/A |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | Backend | Key that encrypts per-school HMAC secrets at rest | generated | *(32-char hex)* | `CRITICAL` | Security | Every 90 days |
| `WEBHOOK_URL` | Docker / backup | Webhook URL for backup failure alerts | unset | `https://hooks.slack.com/...` | `RESTRICTED` | Ops | On URL change |

---

## Polling & Sync

| Variable | Service | Purpose | Default | Example | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|---------|------------|----------------|-------------------|
| `SYNC_INTERVAL_MS` | Backend | Blockchain polling interval (ms); set to `0` to disable | `60000` | `60000` | `INTERNAL` | Payments operator | N/A |
| `POLL_INTERVAL_MS` | Backend | Legacy polling interval alias | `30000` | `30000` | `INTERNAL` | Payments operator | N/A |
| `POLL_MAX_BACKOFF_MS` | Backend | Max backoff during Horizon errors (ms) | `300000` | `300000` | `INTERNAL` | Payments operator | N/A |
| `HORIZON_RATE_LIMIT_PER_HOUR` | Backend | Horizon API allowance per hour | `3600` | `3600` | `INTERNAL` | Payments operator | N/A |
| `HORIZON_POLL_BUDGET_SAFETY_FACTOR` | Backend | Fraction of rate limit reserved for polling (0–1) | `0.6` | `0.6` | `INTERNAL` | Payments operator | N/A |
| `HORIZON_POLL_REPLICA_COUNT` | Backend | Number of backend replicas (divides poll budget) | `1` | `2` | `INTERNAL` | Platform | On scaling change |
| `SYNC_MAX_CONCURRENT_SCHOOLS` | Backend | Max schools polled simultaneously | `4` | `4` | `INTERNAL` | Payments operator | N/A |

---

## Retry Queue (BullMQ / MongoDB)

| Variable | Service | Purpose | Default | Example | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|---------|------------|----------------|-------------------|
| `RETRIES_ENABLED` | Backend | Enable/disable retry queue | `true` | `true` | `INTERNAL` | Ops | N/A |
| `MAX_RETRY_ATTEMPTS` | Backend | Max retry attempts per failed transaction | `10` | `10` | `INTERNAL` | Payments operator | N/A |
| `INITIAL_RETRY_DELAY_MS` | Backend | Initial retry delay (ms) | `60000` | `60000` | `INTERNAL` | Payments operator | N/A |
| `MAX_RETRY_DELAY_MS` | Backend | Max retry delay cap (ms) | `3600000` | `3600000` | `INTERNAL` | Payments operator | N/A |
| `RETRY_BACKOFF_MULTIPLIER` | Backend | Exponential backoff factor | `2` | `2` | `INTERNAL` | Payments operator | N/A |
| `DLQ_ENABLED` | Backend | Enable dead-letter queue | `true` | `true` | `INTERNAL` | Ops | N/A |
| `DLQ_MAX_AGE_MS` | Backend | Max age of DLQ entries (ms) | `604800000` (7 days) | `604800000` | `INTERNAL` | Ops | N/A |
| `QUEUE_CONCURRENCY` | Backend | BullMQ retry worker concurrency | `5` | `5` | `INTERNAL` | Platform | N/A |
| `TX_QUEUE_CONCURRENCY` | Backend | Transaction processing queue concurrency | `5` | `5` | `INTERNAL` | Platform | N/A |

---

## Payment Limits

| Variable | Service | Purpose | Default | Example | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|---------|------------|----------------|-------------------|
| `MIN_PAYMENT_AMOUNT` | Backend | Minimum payment amount (XLM/USDC) | `0.01` | `0.01` | `INTERNAL` | Payments operator | N/A |
| `MAX_PAYMENT_AMOUNT` | Backend | Maximum payment amount (XLM/USDC) | `100000` | `100000` | `INTERNAL` | Payments operator | N/A |
| `MAX_QUEUE_DEPTH` | Backend | Max in-flight concurrent payments | `1000` | `1000` | `INTERNAL` | Payments operator | N/A |
| `IDEMPOTENCY_KEY_TTL_SECONDS` | Backend | Idempotency key retention (seconds) | `86400` | `86400` | `INTERNAL` | Payments operator | N/A |
| `PAYMENT_INTENT_TTL_SECONDS` | Backend | Abandoned payment intent TTL (seconds) | `86400` | `86400` | `INTERNAL` | Payments operator | N/A |

---

## Monitoring & Observability

| Variable | Service | Purpose | Default | Example | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|---------|------------|----------------|-------------------|
| `METRICS_TOKEN` | Backend | Bearer token for `GET /metrics` (Prometheus scrape) | unset | *(random hex)* | `SECRET` | Security / ops | Every 90 days |
| `SWAGGER_ENABLED` | Backend | Enable Swagger UI; auto-disabled in production | enabled outside prod | `true` | `INTERNAL` | Ops | N/A |
| `GRAFANA_PASSWORD` | Monitoring | Grafana admin password (Docker Compose) | required in monitoring stack | *(strong password)* | `SECRET` | Ops | Every 90 days |

---

## Email & Reminders

| Variable | Service | Purpose | Default | Example | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|---------|------------|----------------|-------------------|
| `SMTP_HOST` | Backend | SMTP server hostname | unset | `smtp.example.com` | `RESTRICTED` | Integrations | On provider change |
| `SMTP_PORT` | Backend | SMTP port | `587` | `587` | `INTERNAL` | Integrations | N/A |
| `SMTP_SECURE` | Backend | Use TLS | `false` | `true` | `INTERNAL` | Integrations | N/A |
| `SMTP_USER` | Backend | SMTP username | unset | `noreply@school.com` | `SECRET` | Integrations | Every 90 days |
| `SMTP_PASS` | Backend | SMTP password or app-password | unset | *(app password)* | `CRITICAL` | Integrations | Every 90 days |
| `SMTP_FROM` | Backend | Sender address | application default | `noreply@school.com` | `INTERNAL` | Integrations | On domain change |
| `SENDGRID_API_KEY` | Backend | SendGrid API key (alternative to SMTP) | unset | `SG.xxxx` | `CRITICAL` | Integrations | Every 90 days |
| `ADMIN_ALERT_EMAIL` | Backend | Email for admin alerts | unset | `finance@school.com` | `RESTRICTED` | Ops | On team change |
| `ADMIN_ALERT_WEBHOOK_URL` | Backend | Webhook URL for critical alerts | unset | `https://hooks.slack.com/...` | `RESTRICTED` | Ops | On change |
| `REMINDER_INTERVAL_MS` | Backend | Reminder scheduler run interval (ms) | `3600000` | `3600000` | `INTERNAL` | Ops | N/A |
| `REMINDER_COOLDOWN_HOURS` | Backend | Min hours between reminders per student | `48` | `48` | `INTERNAL` | Ops | N/A |
| `REMINDER_MAX_COUNT` | Backend | Max reminders per student | `5` | `5` | `INTERNAL` | Ops | N/A |

---

## SMS / WhatsApp (Twilio)

| Variable | Service | Purpose | Default | Example | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|---------|------------|----------------|-------------------|
| `TWILIO_ACCOUNT_SID` | Backend | Twilio Account SID | unset | `ACxxxxxxxxx` | `SECRET` | Integrations | On credential rotation |
| `TWILIO_AUTH_TOKEN` | Backend | Twilio auth token | unset | *(auth token)* | `CRITICAL` | Integrations | Every 90 days |
| `TWILIO_FROM_NUMBER` | Backend | E.164 SMS sender number | unset | `+15005550006` | `RESTRICTED` | Integrations | On number change |
| `TWILIO_WHATSAPP_FROM` | Backend | WhatsApp sender (Twilio format) | unset | `whatsapp:+14155238886` | `RESTRICTED` | Integrations | On number change |

---

## Currency & Price Feed

| Variable | Service | Purpose | Default | Example | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|---------|------------|----------------|-------------------|
| `COINGECKO_API_KEY` | Backend | CoinGecko Pro API key for higher rate limits | unset (free tier) | `CG-xxxxx` | `SECRET` | Integrations | Every 90 days |
| `PRICE_CACHE_TTL_MS` | Backend | Exchange rate cache TTL (ms) | `60000` | `60000` | `INTERNAL` | Payments operator | N/A |
| `PRICE_STALE_THRESHOLD_MS` | Backend | Max age for stale rate fallback (ms) | `3600000` | `3600000` | `INTERNAL` | Payments operator | N/A |
| `DEFAULT_FIAT_CURRENCY` | Backend | Default display currency | `USD` | `USD` | `PUBLIC` | Product | N/A |
| `ALLOWED_FIAT_CURRENCIES` | Backend | Comma-separated allowlist of fiat codes | application allowlist | `USD,EUR,GBP` | `INTERNAL` | Product | N/A |

---

## Backup & Recovery

| Variable | Service | Purpose | Default | Example | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|---------|------------|----------------|-------------------|
| `BACKUP_DIR` | Docker | Host path for MongoDB backup archives | `./backups` | `/mnt/backups` | `INTERNAL` | Platform | N/A |
| `RETAIN_DAYS` | Docker | Days of backups to retain | `7` | `14` | `INTERNAL` | Platform / compliance | N/A |
| `MIN_BACKUP_SIZE` | Docker | Min expected backup size in bytes | `1024` | `1024` | `INTERNAL` | Platform | N/A |

---

## Docker Compose Resource Limits

| Variable | Service | Purpose | Default | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|------------|----------------|-------------------|
| `BACKEND_MEM_LIMIT` | Docker | Backend container memory limit | `512m` | `INTERNAL` | Platform | On capacity change |
| `FRONTEND_MEM_LIMIT` | Docker | Frontend container memory limit | `256m` | `INTERNAL` | Platform | On capacity change |
| `REDIS_MEM_LIMIT` | Docker | Redis container memory limit | `128m` | `INTERNAL` | Platform | On capacity change |
| `MONGO_MEM_LIMIT` | Docker | MongoDB container memory limit | `1g` | `INTERNAL` | Platform | On capacity change |

---

## Frontend (Next.js)

> All `NEXT_PUBLIC_*` variables are embedded into the client bundle at build time. **They must never contain secrets.**

| Variable | Service | Purpose | Default | Example | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|---------|------------|----------------|-------------------|
| `NEXT_PUBLIC_API_URL` | Frontend | API base URL. `/api` uses same-origin proxy; direct URL bypasses proxy | `/api` | `/api` | `PUBLIC` | Frontend / platform | On API endpoint change |
| `NEXT_PUBLIC_STELLAR_NETWORK` | Frontend | Stellar network indicator shown in UI | `testnet` | `mainnet` | `PUBLIC` | App operator | On environment promotion |
| `NEXT_PUBLIC_FEATURE_PAYMENT_PLANS` | Frontend | Enable payment plan feature | `false` | `true` | `PUBLIC` | Product | On feature launch |
| `NEXT_PUBLIC_FEATURE_FEE_ADJUSTMENTS` | Frontend | Enable fee adjustments feature | `false` | `true` | `PUBLIC` | Product | On feature launch |
| `NEXT_PUBLIC_FEATURE_DISPUTES` | Frontend | Enable dispute management feature | `false` | `true` | `PUBLIC` | Product | On feature launch |
| `NEXT_PUBLIC_FEATURE_REFUNDS` | Frontend | Enable refunds feature | `false` | `true` | `PUBLIC` | Product | On feature launch |
| `NEXT_PUBLIC_FEATURE_MULTI_ASSET` | Frontend | Enable multi-asset support | `false` | `true` | `PUBLIC` | Product | On feature launch |
| `NEXT_PUBLIC_FEATURE_PAYMENT_VERIFICATION` | Frontend | Enable manual payment verification | `false` | `true` | `PUBLIC` | Product | On feature launch |
| `NEXT_PUBLIC_FEATURE_BULK_STUDENT_IMPORT` | Frontend | Enable bulk CSV student import | `false` | `true` | `PUBLIC` | Product | On feature launch |
| `NEXT_PUBLIC_FEATURE_SOURCE_VALIDATION` | Frontend | Enable source wallet validation rules | `false` | `true` | `PUBLIC` | Product | On feature launch |
| `BACKEND_PROXY_TARGET` | Frontend (dev) | Upstream backend for Next.js API proxy rewrites | `http://localhost:5000` | `http://backend:5000` | `INTERNAL` | Frontend / platform | N/A |

---

## Data Retention & Compliance

| Variable | Service | Purpose | Default | Sensitivity | Rotation Owner | Rotation Frequency |
|----------|---------|---------|---------|------------|----------------|-------------------|
| `AUDIT_LOG_TTL_DAYS` | Backend | Audit log document retention (days) | `730` (2 years) | `INTERNAL` | Compliance | On policy change |
| `STUDENT_PII_RETENTION_DAYS` | Backend | Days before PII anonymization is eligible | `90` | `INTERNAL` | Compliance | On policy change |
| `STUDENT_FEE_HISTORY_CAP` | Backend | Max fee entries in student document before archiving | `100` | `INTERNAL` | Compliance | N/A |
| `DISPUTE_SLA_HOURS` | Backend | Hours before open dispute auto-escalates | `72` | `INTERNAL` | Ops | On SLA change |

---

## Variables That Must Never Appear in Logs or Commits

The following variables are classified `CRITICAL` or `SECRET`. Treat any accidental exposure as an immediate security incident:

- `JWT_SECRET`
- `MONGO_URI` (contains embedded credentials)
- `MONGO_ROOT_PASSWORD`
- `REDIS_PASSWORD`
- `SIGNER_MASTER_KEY`, `SIGNER_MASTER_KEY_OLD`
- `STUDENT_PII_ENCRYPTION_KEY`
- `WEBHOOK_SECRET_ENCRYPTION_KEY`
- `AUDIT_HMAC_KEY` / `AUDIT_CURSOR_HMAC_KEY`
- `RECEIPT_SIGNATURE_SECRET`
- `ADMIN_PASSWORD`, `ADMIN_PASSWORD_HASH`
- `SMTP_PASS`, `SENDGRID_API_KEY`
- `TWILIO_AUTH_TOKEN`
- `COINGECKO_API_KEY`
- `METRICS_TOKEN`
- `GRAFANA_PASSWORD`
- Any `*_SECRET_KEY` or `*_SIGNING_KEY` variable

The `requestLogger` middleware automatically redacts `LOG_REDACT_FIELDS` from request logs. The `redactConfig` utility removes known secrets from configuration dumps.

---

## Secret Rotation Runbooks

| Secret | Runbook |
|--------|---------|
| JWT secret | `scripts/rotate-jwt-secret.js` + `docs/security.md` |
| Signer master key | `scripts/rotate-signer-master-key.js` + `docs/runbooks/signer-key-rotation.md` |
| Webhook encryption key | `scripts/rotate-webhook-encryption-key.js` |
| School wallet | `docs/runbooks/wallet-rotation.md` |
| Secret rotation rollback | `docs/runbooks/secret-rotation-rollback.md` |

---

## Adding a New Environment Variable

When adding a new env var to the codebase:

1. Add the variable and example value to `backend/.env.example` or `frontend/.env.local.example`.
2. Add an entry to **this document** (`docs/environment-variables.md`) with all columns populated.
3. Add an entry to `docs/environment-reference.md` classification table.
4. If the variable is a secret, document it in the relevant runbook.
5. The CI check (`tests/environmentReference.test.js`) validates that all `.env.example` variables have a corresponding documentation entry.
