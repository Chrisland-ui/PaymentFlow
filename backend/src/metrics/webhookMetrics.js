'use strict';

/**
 * webhookMetrics.js — Prometheus metrics for outbound webhook delivery.
 *
 * Exported metrics (all registered on the shared registry from metrics/index.js):
 *
 *   webhook_deliveries_total{event, outcome}
 *     Counter. Incremented after every delivery attempt.
 *     outcome: 'success' | 'failure'
 *
 *   webhook_delivery_duration_ms{event}
 *     Histogram. Round-trip time in milliseconds for each delivery attempt.
 *     Buckets chosen to cover the 10 s timeout with useful granularity.
 *
 *   webhook_dead_letter_total{schoolId}
 *     Gauge. Number of failed final deliveries (all retries exhausted) per school.
 *     Refreshed on startup and after each delivery write via refreshDeadLetterGauge().
 */

const { registry, webhookDeliveryTotal } = require('./index');
const client = require('prom-client');

// ── webhook_deliveries_total ──────────────────────────────────────────────────
const webhookDeliveriesTotal = new client.Counter({
  name: 'webhook_deliveries_total',
  help: 'Total webhook delivery attempts by event type and outcome',
  labelNames: ['event', 'outcome'],
  registers: [registry],
});

// ── webhook_delivery_duration_ms ──────────────────────────────────────────────
const webhookDeliveryDurationMs = new client.Histogram({
  name: 'webhook_delivery_duration_ms',
  help: 'Webhook delivery round-trip time in milliseconds',
  labelNames: ['event'],
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [registry],
});

const webhookDeliveryDurationSeconds = new client.Histogram({
  name: 'webhook_delivery_duration_seconds',
  help: 'Webhook delivery round-trip time in seconds',
  labelNames: ['event'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// ── webhook_dead_letter_total ─────────────────────────────────────────────────
// Gauge instead of counter so it can go down when retries succeed or records
// are cleaned up by TTL expiry.
const webhookDeadLetterTotal = new client.Gauge({
  name: 'webhook_dead_letter_total',
  help: 'Number of webhook deliveries that exhausted all retries, per school',
  labelNames: ['schoolId'],
  registers: [registry],
});

/**
 * Refresh the webhook_dead_letter_total gauge by querying the WebhookDelivery
 * collection. Called on startup and after each delivery that hits max retries.
 *
 * @returns {Promise<void>}
 */
async function refreshDeadLetterGauge() {
  try {
    const WebhookDelivery = require('../models/webhookDeliveryModel');
    const MAX_ATTEMPTS = parseInt(process.env.WEBHOOK_MAX_ATTEMPTS, 10) || 3;

    // Group failed deliveries by schoolId where attemptCount >= MAX_ATTEMPTS
    const counts = await WebhookDelivery.aggregate([
      { $match: { success: false, attemptCount: { $gte: MAX_ATTEMPTS } } },
      { $group: { _id: '$schoolId', count: { $sum: 1 } } },
    ]);

    webhookDeadLetterTotal.reset();
    for (const { _id, count } of counts) {
      if (_id) webhookDeadLetterTotal.set({ schoolId: _id }, count);
    }
  } catch (_) {
    // DB may not be ready yet; scrape still succeeds with last-known values
  }
}

/**
 * Record a successful delivery.
 *
 * @param {string} event       Webhook event type (e.g. 'payment.confirmed')
 * @param {number} durationMs  Round-trip time in ms
 */
function recordDeliverySuccess(event, durationMs) {
  webhookDeliveryTotal.inc({ status: 'success' });
  webhookDeliveriesTotal.inc({ event, outcome: 'success' });
  webhookDeliveryDurationMs.observe({ event }, durationMs);
  webhookDeliveryDurationSeconds.observe({ event }, durationMs / 1000);
}

/**
 * Record a failed delivery attempt.
 *
 * @param {string}  event        Webhook event type
 * @param {number}  durationMs   Round-trip time in ms
 * @param {boolean} [isDeadLetter=false]  True when all retries have been exhausted
 * @param {string}  [schoolId]   Required when isDeadLetter is true
 */
function recordDeliveryFailure(event, durationMs, isDeadLetter = false, schoolId = null) {
  webhookDeliveryTotal.inc({ status: 'failure' });
  webhookDeliveriesTotal.inc({ event, outcome: 'failure' });
  webhookDeliveryDurationMs.observe({ event }, durationMs);
  webhookDeliveryDurationSeconds.observe({ event }, durationMs / 1000);

  if (isDeadLetter && schoolId) {
    webhookDeadLetterTotal.inc({ schoolId });
  }
}

function recordDeadLetter(schoolId) {
  if (schoolId) webhookDeadLetterTotal.inc({ schoolId });
}

// ── webhook_inbound_verification_failures_total ─────────────────────────────
const webhookInboundVerificationFailuresTotal = new client.Counter({
  name: 'webhook_inbound_verification_failures_total',
  help: 'Total inbound webhook verification failures by provider and reason',
  labelNames: ['provider', 'reason'],
  registers: [registry],
});

/**
 * Record an inbound webhook verification failure.
 *
 * @param {string} provider Provider identifier
 * @param {string} reason Reason code (e.g. INVALID_SIGNATURE, TIMESTAMP_SKEW)
 */
function recordInboundVerificationFailure(provider = 'stellaredupay', reason = 'UNKNOWN') {
  webhookInboundVerificationFailuresTotal.inc({ provider, reason });
}

module.exports = {
  webhookDeliveriesTotal,
  webhookDeliveryDurationMs,
  webhookDeliveryDurationSeconds,
  webhookDeadLetterTotal,
  webhookInboundVerificationFailuresTotal,
  refreshDeadLetterGauge,
  recordDeliverySuccess,
  recordDeliveryFailure,
  recordDeadLetter,
  recordInboundVerificationFailure,
};
