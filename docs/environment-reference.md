# Environment Variable Reference

This is the source-of-truth classification for environment variables used by PaymentFlow. The executable example values remain in [`.env.example`](../.env.example), [`backend/.env.example`](../backend/.env.example), and [`frontend/.env.local.example`](../frontend/.env.local.example); this document deliberately contains no credential values.

## How To Read This

- **Default** describes startup behavior when the variable is absent. `required` means startup or the named operation fails; `unset` means the feature is disabled or an application fallback is used; `example` means the non-secret development value is in the linked example file.
- **Sensitivity** is `secret` for credentials, signing/encryption material, or bearer tokens; `restricted` for identifiers or addresses that should not be broadly exposed; `public` for values safe to ship to a browser; and `internal` for non-secret service configuration.
- **Owner** is the team or role responsible for generating, changing, and rotating the value.
- **Scope** identifies where the variable is consumed: backend, frontend build/runtime, Docker, monitoring, tests, or deployment.

Never copy secret values into this document, source control, logs, fixtures, screenshots, or issue comments. Secret rotation procedures are in [`docs/security.md`](security.md) and the wallet/key runbooks.

## Required And Missing-Variable Behavior

The backend fails during configuration loading when `MONGO_URI` or `JWT_SECRET` is missing. `JWT_SECRET` must be at least 32 characters. Production also requires a valid absolute `APP_URL`; invalid URLs, invalid Stellar addresses, and invalid proxy-hop values fail configuration loading. The exact validation is covered by [`tests/jwtSecretValidation.test.js`](../tests/jwtSecretValidation.test.js) and the environment-reference completeness test.

All other backend variables are optional at startup unless a feature explicitly requires them. Optional integrations fall back to disabled, console, in-process, MongoDB-backed, or documented application defaults. Compose fails before startup when its `:?` variables are absent, notably Mongo root credentials and the monitoring Grafana password.

## Backend And Operations

| Variable(s) | Default | Sensitivity | Owner | Scope |
| --- | --- | --- | --- | --- |
| `MONGO_URI` | required | secret | Platform / database | backend, migrations |
| `MONGO_ROOT_USERNAME`, `MONGO_ROOT_PASSWORD` | Compose required; example only | secret | Platform / database | Docker |
| `MONGODB_POOL_SIZE`, `DB_MAX_POOL_SIZE`, `DB_MIN_POOL_SIZE`, `DB_MAX_IDLE_TIME_MS`, `DB_CONNECT_TIMEOUT_MS`, `DB_SOCKET_TIMEOUT_MS`, `DB_SERVER_SELECTION_TIMEOUT_MS`, `DB_MAX_CONCURRENT`, `DB_READ_CONCERN`, `DB_WRITE_CONCERN`, `DB_JOURNAL`, `DB_TRANSACTION_TIMEOUT_MS`, `DB_MAX_RETRIES`, `DB_INITIAL_RETRY_DELAY_MS`, `DB_MAX_RETRY_DELAY_MS`, `MONGODB_CONNECT_RETRIES`, `MONGODB_CONNECT_DELAY_MS`, `DB_REPORT_AGGREGATION_MAX_TIME_MS` | application defaults; example | internal | Platform / database | backend |
| `NODE_ENV` | development | internal | Application | backend |
| `PORT` | 5000 | internal | Application | backend, Docker |
| `API_URL`, `APP_URL` | `API_URL` example; `APP_URL` unset except required in production | public / restricted | Application / platform | backend |
| `ALLOWED_ORIGIN` | example local origin | public | Platform | backend |
| `TRUSTED_PROXY_HOPS` | 1 | internal | Platform | backend |
| `BACKEND_CPUS`, `BACKEND_MEM_LIMIT`, `FRONTEND_CPUS`, `FRONTEND_MEM_LIMIT`, `MONGO_CPUS`, `MONGO_MEM_LIMIT`, `REDIS_MEM_LIMIT` | Compose resource defaults | internal | Platform | Docker |
| `JWT_SECRET` | required; generated | secret | Security / platform | backend, tests |
| `JWT_EXPIRES_IN`, `JWT_ACCESS_TOKEN_TTL`, `JWT_REFRESH_TOKEN_TTL` | 8h, 8h, 30d | internal | Security | backend |
| `ADMIN_USERNAME` | example local username | restricted | Application operator | backend, Docker |
| `ADMIN_PASSWORD`, `ADMIN_PASSWORD_HASH` | unset; hash preferred | secret | Application operator | backend, Docker |
| `REQUIRE_MFA` | unset / false | internal | Security | backend |
| `SCHOOL_ADMIN_PASSWORD`, `SCHOOL_ADMIN_PASSWORD_HASH` | unset | secret | Application operator | backend |
| `SIGNER_KEY_SOURCE`, `SIGNER_MASTER_KEY`, `SIGNER_MASTER_KEY_OLD`, `SIGNER_MASTER_KEY_HTTP_URL`, `SIGNER_MASTER_KEY_HTTP_TOKEN`, `SIGNER_MASTER_KEY_SECRET_ID` | local source / unset | secret | Security / platform | backend |
| `STUDENT_PII_ENCRYPTION_KEY` | unset; generated when PII encryption is enabled | secret | Security / platform | backend |
| `AUDIT_HMAC_KEY`, `RECEIPT_SIGNATURE_SECRET` | fallback or unset; generated for managed deployments | secret | Security | backend |
| `LOG_LEVEL`, `LOG_MAX_SIZE`, `LOG_MAX_FILES`, `LOG_REDACT_FIELDS`, `LOG_REQUEST_HEADERS` | info, 100m, 14d, application redaction defaults, disabled | internal | Operations | backend |
| `SHUTDOWN_TIMEOUT_MS`, `DRAIN_TIMEOUT_MS`, `WEB_CONCURRENCY`, `INSTANCE_COUNT`, `NUMBER_OF_REPLICAS`, `REPLICA_COUNT` | application/orchestrator defaults | internal | Platform | backend, deployment |

## Stellar And Payment Processing

| Variable(s) | Default | Sensitivity | Owner | Scope |
| --- | --- | --- | --- | --- |
| `STELLAR_NETWORK` | testnet | public | Application operator | backend, frontend, Docker |
| `STELLAR_HORIZON_URL`, `HORIZON_URL`, `STELLAR_HORIZON_URLS` | network Horizon; failover unset | public | Platform | backend |
| `SCHOOL_WALLET_ADDRESS` | unset; school record is authoritative | restricted | School operator | backend, migrations, seed |
| `USDC_ISSUER` | network-specific well-known issuer | public | Application operator | backend |
| `ACCEPTED_ASSET` | XLM | public | Application operator | backend |
| `CONFIRMATION_THRESHOLD`, `FINALIZATION_THRESHOLD` | 2, five times confirmation threshold | internal | Payments operator | backend |
| `POLL_INTERVAL_MS`, `SYNC_INTERVAL_MS`, `SYNC_LOCK_TTL_MS`, `POLL_MAX_BACKOFF_MS`, `SYNC_MAX_PAGES_PER_POLL`, `SYNC_MAX_CONCURRENT_SCHOOLS` | application defaults | internal | Payments operator | backend |
| `HORIZON_RATE_LIMIT_PER_HOUR`, `HORIZON_RATE_LIMIT_HEADER`, `HORIZON_RATE_LIMIT_WINDOW_MS`, `HORIZON_POLL_BUDGET_SAFETY_FACTOR`, `HORIZON_POLL_REPLICA_COUNT`, `HORIZON_POLL_MIN_BUDGET`, `HORIZON_POLL_RECENT_ACTIVITY_WINDOW_MS` | Horizon/application defaults | internal | Platform / payments | backend |
| `STELLAR_TIMEOUT_MS`, `STELLAR_NETWORK_TIMEOUT_MS`, `STELLAR_CALL_RETRY_ATTEMPTS`, `STELLAR_CALL_RETRY_DELAY_MS`, `STELLAR_RETRY_MAX_ATTEMPTS`, `STELLAR_RETRY_INITIAL_DELAY`, `STELLAR_RETRY_MAX_DELAY`, `STELLAR_RETRY_FACTOR` | application defaults | internal | Payments operator | backend |
| `STELLAR_RATE_LIMIT_MIN_TIME`, `STELLAR_RATE_LIMIT_MAX_CONCURRENT`, `STELLAR_RATE_LIMIT_HIGH_WATER`, `STELLAR_RATE_LIMIT_STRATEGY`, `STELLAR_BURST_ALLOWANCE`, `STELLAR_BURST_WINDOW` | application defaults | internal | Platform / payments | backend |
| `STELLAR_TX_TIMEOUT_SECONDS`, `STELLAR_TX_BASE_FEE`, `STELLAR_TX_FEE_MULTIPLIER` | application defaults | internal | Payments operator | backend |
| `CB_FAILURE_THRESHOLD`, `CB_RESET_TIMEOUT_MS`, `CB_HALF_OPEN_SUCCESS_THRESHOLD`, `CIRCUIT_FAILURE_THRESHOLD`, `CIRCUIT_RESET_TIMEOUT_MS`, `CIRCUIT_HALF_OPEN_SUCCESS_THRESHOLD`, `CURRENCY_CB_FAILURE_THRESHOLD`, `CURRENCY_CB_RESET_TIMEOUT_MS`, `CURRENCY_CB_SUCCESS_THRESHOLD` | application defaults | internal | Payments operator | backend |
| `MIN_PAYMENT_AMOUNT`, `MAX_PAYMENT_AMOUNT`, `MIN_TRANSACTION_AMOUNT`, `MAX_TRANSACTION_AMOUNT`, `AMOUNT_STRICT_VALIDATION`, `DECIMAL_PRECISION`, `MAX_DISPLAY_DECIMALS` | application/payment defaults | internal | Payments operator | backend |
| `VERIFY_RATE_LIMIT`, `VERIFY_LOCK_TTL_MS`, `IDEMPOTENCY_KEY_TTL_SECONDS`, `IDEMPOTENCY_IN_FLIGHT_TTL_MS`, `PAYMENT_INTENT_TTL_SECONDS`, `PAYMENT_INTENT_TTL_MS` | application defaults | internal | Payments operator | backend |
| `PAYMENT_WEBHOOK_URL`, `WEBHOOK_URL`, `WEBHOOK_MAX_ATTEMPTS`, `WEBHOOK_RETRY_INTERVAL_MS`, `WEBHOOK_DELIVERY_TTL_SECONDS`, `WEBHOOK_DELIVERY_RETENTION_DAYS`, `WEBHOOK_LEASE_TIMEOUT_MS`, `WEBHOOK_REPLAY_WINDOW_S`, `WEBHOOK_NONCE_TTL_SECONDS`, `WEBHOOK_REPLAY_NONCES_LOCAL`, `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` | unset or application defaults | restricted | Integrations / payments | backend |
| `WEBHOOK_SECRET_ENCRYPTION_KEY`, `WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS` | unset; generated | secret | Security / platform | backend |
| `MAX_QUEUE_DEPTH`, `QUEUE_BACKPRESSURE_HIGH_WATER`, `QUEUE_BACKPRESSURE_LOW_WATER`, `QUEUE_MAX_CONCURRENT`, `QUEUE_MAX_SIZE`, `QUEUE_DEFAULT_TIMEOUT_MS` | application defaults | internal | Payments operator | backend |
| `RETRIES_ENABLED`, `RETRY_INTERVAL_MS`, `RETRY_MAX_ATTEMPTS`, `MAX_RETRY_ATTEMPTS`, `INITIAL_RETRY_DELAY_MS`, `MAX_RETRY_DELAY_MS`, `RETRY_BACKOFF_MULTIPLIER`, `RETRY_JITTER_RATIO`, `DLQ_ENABLED`, `DLQ_MAX_AGE_MS` | enabled and application defaults | internal | Platform / payments | backend |
| `QUEUE_CONCURRENCY`, `TX_QUEUE_CONCURRENCY`, `TX_QUEUE_HEARTBEAT_INTERVAL_MS`, `QUEUE_LOCK_DURATION_MS`, `QUEUE_STALLED_INTERVAL_MS`, `QUEUE_MAX_STALLED_COUNT`, `JOB_RECOVERY_BASE_DELAY_MS`, `JOB_RECOVERY_INTERVAL_MS`, `JOB_RECOVERY_MAX_DELAY_MS`, `JOB_RECOVERY_MAX_RETRIES` | application defaults | internal | Platform | backend |

## Redis, Scheduling, And Data Retention

| Variable(s) | Default | Sensitivity | Owner | Scope |
| --- | --- | --- | --- | --- |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | unset, 6379, unset | restricted / secret | Platform | backend, Docker |
| `REDIS_LOG_THROTTLE_MS`, `REDIS_RECONNECT_MAX_ATTEMPTS`, `REDIS_RECONNECT_BASE_DELAY_MS`, `REDIS_RECONNECT_MAX_DELAY_MS` | application defaults | internal | Platform | backend |
| `SSE_HEARTBEAT_MS`, `SSE_MAX_CONNECTIONS_PER_SCHOOL` | 15000, 100 | internal | Platform | backend |
| `LEADER_LOCK_TTL_MS`, `LEADER_RENEW_INTERVAL_MS`, `LEADER_ACQUIRE_INTERVAL_MS` | application defaults | internal | Platform | backend |
| `CONSISTENCY_CHECK_INTERVAL_MS`, `RECONCILIATION_INTERVAL_MS`, `RECONCILIATION_REPORT_INTERVAL_MS`, `METRICS_RECONCILE_INTERVAL_MS`, `OUTBOX_DISPATCH_INTERVAL_MS`, `OUTBOX_MAX_RETRIES`, `SESSION_CLEANUP_INTERVAL_MS` | application defaults | internal | Operations | backend |
| `REMINDER_INTERVAL_MS`, `REMINDER_COOLDOWN_HOURS`, `REMINDER_MAX_COUNT` | application defaults | internal | Operations | backend |
| `RECONCILIATION_BATCH_SIZE`, `RECONCILIATION_DRIFT_THRESHOLD`, `RECONCILIATION_CHAIN_LOOKBACK_DAYS`, `RECONCILIATION_CHAIN_TOTAL_TTL_SEC` | 500, 0.5, 90, 300 | internal | Payments operator | backend |
| `STUCK_PAYMENT_THRESHOLD_MS`, `STUCK_PAYMENT_RECONCILIATION_INTERVAL_MS`, `STUCK_PAYMENT_RECONCILIATION_MAX_BATCH` | application defaults | internal | Payments operator | backend |
| `STUDENT_FEE_HISTORY_CAP`, `STUDENT_BALANCE_LOCK_TTL_MS` | 100, application default | internal | Compliance / payments | backend |
| `STUDENT_PII_RETENTION_DAYS`, `PAYMENT_MEMO_RETENTION_DAYS`, `AUDIT_LOG_RETENTION_DAYS` | 2555 days, 1825 days, 90 days | internal | Compliance | backend |
| `DATA_RETENTION_INTERVAL_MS`, `DATA_RETENTION_AUTO_PURGE` | 86400000, false | internal | Compliance / Operations | backend |
| `REMINDER_LOG_TTL_SECONDS` | 90 days | internal | Compliance | backend |
| `WORKER_HEARTBEAT_GRACE_MS` | application default | internal | Operations | backend |
| `DEFAULT_SCHOOL_ID`, `SEED_SCHOOL_ID`, `SEED_SCHOOL_SLUG`, `SEED_SCHOOL_NAME` | migration/seed defaults | restricted | Application operator | migrations, seed |

## Reports, Currency, And Input Limits

| Variable(s) | Default | Sensitivity | Owner | Scope |
| --- | --- | --- | --- | --- |
| `DEFAULT_FIAT_CURRENCY`, `ALLOWED_FIAT_CURRENCIES` | USD; unset means application allowlist | public | Product / payments | backend |
| `PRICE_CACHE_TTL_MS`, `PRICE_STALE_THRESHOLD_MS`, `SUPPORTED_CURRENCIES_TTL_MS`, `CURRENCY_LRU_MAX_SIZE` | application defaults | internal | Payments operator | backend |
| `COINGECKO_API_KEY` | unset | secret | Integrations owner | backend |
| `REPORT_MAX_RANGE_DAYS`, `LARGE_REPORT_THRESHOLD_DAYS`, `REPORT_JOB_TTL_MS`, `REPORT_QUEUE_CONCURRENCY` | application defaults | internal | Operations | backend |
| `PAYMENT_LIMITS_CACHE_TTL_MS`, `PAYMENT_LIMITS_READ_TIMEOUT_MS` | application defaults | internal | Payments operator | backend |
| `MAX_BODY_SIZE`, `JSON_MAX_DEPTH`, `JSON_MAX_ARRAY_LENGTH`, `CSV_MAX_SIZE_BYTES`, `CSV_MAX_ROWS`, `CSV_MAX_COLUMNS` | application/input defaults | internal | Application | backend |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS`, `BULK_IMPORT_RATE_LIMIT`, `BULK_IMPORT_MAX_FAILURES`, `BULK_PAYMENT_STATUS_LIMIT` | application defaults | internal | Application | backend |
| `REQUEST_TIMEOUT_MS` | 30000 | internal | Platform | backend |
| `DISPUTE_SLA_HOURS` | 72 | internal | Operations | backend |

## Email, SMS, And External Integrations

| Variable(s) | Default | Sensitivity | Owner | Scope |
| --- | --- | --- | --- | --- |
| `EMAIL_PROVIDER` | console when no provider is configured | internal | Integrations owner | backend |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_FROM_EMAIL` | unset, 587, false, unset, unset, application sender default, unset | secret where applicable | Integrations owner | backend |
| `SENDGRID_API_KEY` | unset | secret | Integrations owner | backend |
| `AWS_REGION` | unset | public | Integrations owner | backend |
| `EMAIL_PROVIDER_WEBHOOK_SECRET`, `EMAIL_WEBHOOK_SECRET` | unset | secret | Integrations owner | backend |
| `EMAIL_MAX_RETRIES`, `EMAIL_RETRY_BASE_MS`, `EMAIL_RETRY_MAX_MS` | application defaults | internal | Integrations owner | backend |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_WHATSAPP_FROM` | unset; console fallback | secret where applicable | Integrations owner | backend |
| `ADMIN_ALERT_EMAIL`, `ADMIN_ALERT_WEBHOOK_URL` | unset | restricted | Operations | backend |

## Observability, Backups, And Monitoring

| Variable(s) | Default | Sensitivity | Owner | Scope |
| --- | --- | --- | --- | --- |
| `METRICS_TOKEN`, `METRICS_BEARER_TOKEN` | unset; metrics auth disabled or provider-specific | secret | Security / operations | backend, monitoring |
| `DAILY_METRICS_TTL_SECONDS` | application default | internal | Operations | backend |
| `SWAGGER_ENABLED` | enabled outside production; unset in production | public | Operations | backend |
| `BACKUP_DIR`, `RETAIN_DAYS`, `MIN_BACKUP_SIZE` | `./backups`, 7 days, 1024 bytes | internal | Platform / database | Docker, backup scripts |
| `BACKUP_NOTIFY_TOKEN` | unset | secret | Platform / database | backend, Docker |
| `GRAFANA_PASSWORD` | Compose required; generated | secret | Operations | monitoring |
| `LOG_REDACT_FIELDS`, `LOG_REQUEST_HEADERS` | application redaction defaults | internal | Security / operations | backend |

## Frontend And Test Scope

| Variable(s) | Default | Sensitivity | Owner | Scope |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `/api` | public | Frontend / platform | frontend build/runtime |
| `NEXT_PUBLIC_STELLAR_NETWORK` | testnet | public | Frontend / application operator | frontend build/runtime |
| `NEXT_PUBLIC_REQUEST_TIMEOUT_MS`, `REACT_APP_API_BASE` | frontend fallback / unset | public | Frontend | frontend build/runtime |
| `BACKEND_PROXY_TARGET` | `http://localhost:5000` | internal | Frontend / platform | frontend development |
| `JEST_WORKER_ID` | provided by Jest | internal | Test runner | tests |

## Docker And Deployment-Only Variables

| Variable(s) | Default | Sensitivity | Owner | Scope |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_API_URL`, `STELLAR_NETWORK` | Compose build defaults | public | Platform | Docker frontend build |
| `BACKUP_DIR`, `WEBHOOK_URL`, `RETAIN_DAYS`, `MIN_BACKUP_SIZE` | Compose/backup defaults | restricted where URL contains credentials | Platform / database | Docker backup |
| `BACKEND_CPUS`, `BACKEND_MEM_LIMIT`, `FRONTEND_CPUS`, `FRONTEND_MEM_LIMIT`, `MONGO_CPUS`, `MONGO_MEM_LIMIT`, `REDIS_MEM_LIMIT` | Compose resource defaults | internal | Platform | Docker |
| `GRAFANA_PASSWORD` | required | secret | Operations | monitoring |

## Ownership And Rotation

- **Security / platform** generates and rotates JWT, encryption, signing, admin, database, Redis, monitoring, and provider credentials. Rotate dependent services together and never print old or new values.
- **Database / platform** owns MongoDB credentials, connection policy, backups, and restore-test settings.
- **Payments / integrations** owns Horizon, Stellar asset, payment-limit, webhook, email, SMS, and retry settings. Wallet addresses are public identifiers; private keys must never be configured here.
- **Operations** owns alerting, metrics, retention, resource, and log settings.
- **Frontend / platform** owns browser-visible API and network settings. Anything named `NEXT_PUBLIC_*` is public after the frontend build and must never contain a secret.

When a variable is absent, start with the application fallback described above and consult the owning runbook before adding a value. For production, prefer the deployment secret manager or Kubernetes secret provisioning over `.env` files.
