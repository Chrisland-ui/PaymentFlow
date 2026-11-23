# Circuit Breakers

> Issue #279 — Add circuit breakers around all payment provider integrations.

PaymentFlow wraps every external provider call with a circuit breaker to prevent
a single slow or unavailable provider from exhausting the Node.js event loop and
causing cascading failures across all school tenants.

---

## 1. Overview

When a payment provider (Stellar Horizon, price feeds, email providers) is slow
or returning errors, requests that normally complete in milliseconds can stall
for the full TCP timeout — typically 30–90 seconds.  Without protection, a burst
of stalled requests will:

- Block the Node.js event loop (single-threaded)
- Exhaust the connection pool
- Cause every tenant to experience timeouts, not just those using the failing provider

Circuit breakers solve this by **failing fast** once a threshold of consecutive
failures is reached.  Open-circuit requests are rejected immediately (< 1 ms)
with a clear error code (`ERR_PROVIDER_CIRCUIT_OPEN`) rather than waiting for a
timeout.

---

## 2. Covered Providers

| Provider Name | Description |
|---------------|-------------|
| `stellar_horizon` | Primary Stellar Horizon API (transaction reads/writes) |
| `coingecko` | CoinGecko cryptocurrency price feed |
| `coinbase` | Coinbase price feed (fallback) |
| `email_smtp` | SMTP email delivery |
| `email_ses` | AWS SES email delivery |
| `email_sendgrid` | SendGrid email delivery |

Additional providers can be registered at runtime via
`registerBreaker(providerName, opts)`.

---

## 3. State Machine

```
           ┌─────────────────────────────────────────────────┐
           │                                                 │
           ▼                                                 │
  ┌──────────────┐   ≥ failureThreshold failures   ┌────────┴─────┐
  │    CLOSED    │ ──────────────────────────────▶ │     OPEN     │
  │  (normal)    │                                 │  (fast-fail) │
  └──────────────┘                                 └──────┬───────┘
           ▲                                              │
           │                                              │ after resetTimeoutMs
           │                                              ▼
           │   ≥ successThreshold successes      ┌───────────────┐
           └────────────────────────────────────  │  HALF_OPEN    │
                                                  │  (probing)    │
                                                  └───────┬───────┘
                                                          │ any failure
                                                          └──────▶ OPEN
```

### State descriptions

| State | Behaviour |
|-------|-----------|
| **CLOSED** | Normal operation. Requests pass through. Failure counter increments on errors. |
| **OPEN** | Fast-fail. All requests immediately throw `ERR_PROVIDER_CIRCUIT_OPEN`. |
| **HALF_OPEN** | Probing. A limited number of requests pass through to test recovery. One failure re-opens; enough successes close it. |

---

## 4. Configuration

Thresholds are configurable via environment variables and apply to all providers
unless overridden per-provider via `registerBreaker(name, opts)`.

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CB_FAILURE_THRESHOLD` | `5` | Consecutive failures before opening |
| `CB_RESET_TIMEOUT_MS` | `30000` | Milliseconds the circuit stays open before probing |
| `CB_SUCCESS_THRESHOLD` | `2` | Successes in HALF_OPEN before closing |

The issue specification calls for:
- Opens after **5 consecutive failures** within a **30-second window** ✓
- In open state, requests **immediately fail** with `ERR_PROVIDER_CIRCUIT_OPEN` ✓
- Circuit **half-opens after 60 seconds** to test recovery with a single probe ✓

To match the spec's 60-second half-open window in production:

```bash
CB_RESET_TIMEOUT_MS=60000
```

---

## 5. /health Endpoint Exposure

Circuit breaker state per provider is visible in the `/health` response under
`checks.providerCircuitBreakers`:

```json
{
  "status": "degraded",
  "checks": {
    "providerCircuitBreakers": {
      "allHealthy": false,
      "openCount": 1,
      "halfOpenCount": 0,
      "providers": [
        { "provider": "stellar_horizon", "state": "open",   "failures": 5, "timeUntilRetryMs": 42000 },
        { "provider": "coingecko",       "state": "closed", "failures": 0, "timeUntilRetryMs": 0 },
        { "provider": "coinbase",        "state": "closed", "failures": 0, "timeUntilRetryMs": 0 },
        { "provider": "email_smtp",      "state": "closed", "failures": 0, "timeUntilRetryMs": 0 },
        { "provider": "email_ses",       "state": "closed", "failures": 0, "timeUntilRetryMs": 0 },
        { "provider": "email_sendgrid",  "state": "closed", "failures": 0, "timeUntilRetryMs": 0 }
      ]
    }
  }
}
```

When `openCount > 0`, the overall health status is set to `"degraded"`.

---

## 6. Multi-Tenant Isolation

Each provider has **one** circuit breaker shared across all school tenants that
use it.  This is by design:

- A provider outage is a global infrastructure event — it affects all callers
  regardless of tenant.
- A single shared breaker trips faster (fewer total requests needed to reach the
  threshold) than per-tenant breakers.

**Tenant isolation is preserved because different providers have independent
breakers.**  If school A uses Stellar Horizon and school B only uses email
providers, an email provider outage will open `email_smtp` but leave
`stellar_horizon` closed — school A's payment processing is unaffected.

---

## 7. Error Behavior

When a circuit is open, `withBreaker()` throws immediately:

```js
const err = new Error('stellar_horizon circuit breaker is open — failing fast');
err.code     = 'ERR_PROVIDER_CIRCUIT_OPEN';
err.provider = 'stellar_horizon';
```

Callers should translate this to an appropriate HTTP error:

```js
try {
  await withBreaker('stellar_horizon', () => horizonClient.getAccount(address));
} catch (err) {
  if (err.code === 'ERR_PROVIDER_CIRCUIT_OPEN') {
    return res.status(503).json({
      error: 'Payment provider temporarily unavailable. Please try again shortly.',
      code: 'PROVIDER_CIRCUIT_OPEN',
      provider: err.provider,
    });
  }
  throw err;
}
```

---

## 8. Prometheus Metrics

Three metrics are exported per provider:

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `provider_circuit_breaker_state` | Gauge | `provider` | Current state: `0`=closed, `1`=open, `2`=half_open |
| `provider_circuit_breaker_failures` | Gauge | `provider` | Current consecutive failure count |
| `provider_circuit_breaker_transitions_total` | Counter | `provider`, `from_state`, `to_state` | State transition events |

### Example alert rules

```promql
# Provider circuit breaker opened
provider_circuit_breaker_state{provider="stellar_horizon"} == 1

# Any provider has been open for > 5 minutes
(time() - provider_circuit_breaker_transitions_total{to_state="open"} > 300)
  and provider_circuit_breaker_state == 1

# High failure rate before circuit opens
rate(provider_circuit_breaker_failures[5m]) > 0
```

---

## 9. Implementation

| Component | File |
|-----------|------|
| CircuitBreaker class | `backend/src/utils/circuitBreaker.js` |
| Provider registry | `backend/src/services/providerCircuitBreakerRegistry.js` |
| Per-operation policies | `backend/src/config/providerPolicyRegistry.js` |
| Health endpoint | `backend/src/controllers/healthController.js` |

### Wrapping a new provider call

```js
const { withBreaker } = require('../services/providerCircuitBreakerRegistry');

// Simple wrap
const result = await withBreaker('coingecko', () => fetchPrice('XLM'));

// Custom error code
const result = await withBreaker('email_smtp', () => sendEmail(msg), {
  errorCode: 'ERR_PROVIDER_CIRCUIT_OPEN',
});
```

---

## 10. Runbook: Circuit Opened

When `provider_circuit_breaker_state{provider="X"} == 1` fires:

1. **Check `/health`** — confirm which provider is open and `timeUntilRetryMs`.
2. **Check provider status page** (e.g., Stellar Status, email provider dashboard).
3. **Review recent logs** for the failure messages that tripped the breaker.
4. **Wait for auto-recovery** — the circuit half-opens after `CB_RESET_TIMEOUT_MS`
   and probes the provider.  If the provider recovers, the circuit closes
   automatically.
5. **Manual reset** (only if you are certain the provider is back):
   ```js
   const { getBreaker } = require('./backend/src/services/providerCircuitBreakerRegistry');
   getBreaker('stellar_horizon').reset(); // forces CLOSED state
   ```
6. **Post-incident**: review `provider_circuit_breaker_transitions_total` in
   Grafana to understand the failure timeline.
