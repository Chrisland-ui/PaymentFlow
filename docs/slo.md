# Service Level Objectives (#370)

## Overview

PaymentFlow defines three Service Level Objectives (SLOs) covering availability
and latency for the most critical user journeys. Each SLO has an error budget,
a Grafana dashboard, and Prometheus alerting rules that fire when the budget
is consumed faster than acceptable.

## SLO Definitions

| SLO | Indicator | Target | Error Budget | Window |
|-----|-----------|--------|-------------|--------|
| **API Availability** | % of HTTP responses that are NOT 5xx | 99.9% | 43.8 min/month | 30-day rolling |
| **Payment Creation Latency** | P95 of POST /api/payments/verify duration | < 2s | 5% of requests may exceed 2s | 30-day rolling |
| **Payment Polling Latency** | P95 of GET /api/payments/*, /api/students/* duration | < 500ms | 5% of requests may exceed 500ms | 30-day rolling |

## Error Budget

For the 99.9% availability SLO:
- **Monthly budget**: 43.8 minutes of allowed downtime (0.1% of 43,200 min/month)
- **Budget consumption**: every 5xx response consumes budget; every non-5xx response adds it back
- **Budget remaining** is computed as a 30-day rolling ratio and displayed on the dashboard

When the budget is low (< 25% remaining), reliability work should be prioritised
over new feature development until the budget recovers.

## Burn Rate Alerting

Burn rate = how fast the error budget is being consumed relative to the
sustainable pace (1x = budget lasts exactly 30 days).

| Alert | Threshold | Window | Severity |
|-------|-----------|--------|----------|
| `AvailabilitySLOFastBurn` | > 5x | 5 min | critical |
| `AvailabilitySLOSlowBurn` | > 2x | 1 hour | warning |
| `AvailabilityErrorBudgetLow` | < 5% remaining | 30-day | warning |
| `PaymentCreationLatencySLOBreach` | P95 > 2s | 1 hour | warning |
| `PaymentPollingLatencySLOBreach` | P95 > 500ms | 1 hour | warning |

## Grafana Dashboard

The SLO dashboard (`monitoring/grafana/dashboards/slo.json`) shows:
- Current 30-day availability percentage (stat panel)
- Error budget remaining (gauge)
- Burn rate for 1-hour and 5-minute windows (stat panels)
- Rolling availability time series with SLO target line
- Error budget burn-down chart
- Payment creation P95 latency with SLO target
- Payment polling P95 latency with SLO target
- SLO compliance table (MET / BREACH indicators)

## Recording Rules

All SLO computations use Prometheus recording rules (defined in
`monitoring/alerts/slo.yml`) to pre-compute rolling ratios at 5m, 1h, 6h,
1d, and 30d windows. This keeps alert evaluation fast and dashboard queries
cheap.

## Monthly SLO Review

As part of the reliability process, schedule a monthly review to:
1. Check whether all SLOs were met for the previous month
2. Review error budget consumption patterns
3. Decide whether to tighten or loosen SLO targets
4. Prioritise reliability improvements if budget was repeatedly exhausted
5. Document any incidents that consumed significant budget
