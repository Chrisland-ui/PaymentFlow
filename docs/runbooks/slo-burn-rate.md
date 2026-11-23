# Runbook: SLO burn rate

The SLO dashboard is `paymentflow-slos` in Grafana. Every SLO has a 30-day
rolling window, an owner, and an alert in `monitoring/alerts/slo.yml`.

## Targets

| SLO | Target | Signal | Owner |
| --- | --- | --- | --- |
| API availability | 99.9% | HTTP requests without 5xx | API |
| API latency | 95% under 1s | `http_request_duration_seconds` | API |
| Queue age | 99% under 60s | `transaction_queue_oldest_age_seconds` | Payments |
| Webhook success | 99.5% | Delivered webhook attempts | Integrations |
| Reconciliation lag | 99% under 15m | `reconciliation_lag_seconds` | Finance |
| Payment availability | 99.9% | Payment route requests without 5xx | Payments |

## Response

1. Open the dashboard and select the affected SLO and 30-day window.
2. Follow the linked service runbook and compare the short-window burn with
   the error-budget panel before taking a risky deployment action.
3. Page the owner in the alert labels. Protect the error budget by pausing
   nonessential work or rolling back the triggering change.
4. Record the incident, affected SLO, customer impact, and recovery time.

`transaction_queue_oldest_age_seconds` and `reconciliation_lag_seconds` are
required instrumentation contracts. Alerts remain inactive until the matching
exporters are deployed; adding a dashboard panel makes missing instrumentation
visible instead of presenting a false green signal.