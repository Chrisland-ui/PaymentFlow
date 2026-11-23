'use strict';

const mongoose = require('mongoose');

/**
 * TTL for processed outbox events: auto-expire after 30 days.
 * Dead-lettered events are NOT expired automatically so they remain
 * observable and replayable by the admin.
 */
const PROCESSED_TTL_SECONDS = parseInt(process.env.OUTBOX_PROCESSED_TTL_SECONDS, 10) || 2592000; // 30 days

const outboxSchema = new mongoose.Schema(
  {
    eventId:        { type: String, required: true, unique: true, index: true },
    eventType:      { type: String, required: true, index: true },
    aggregateId:    { type: String, required: true, index: true },
    aggregateType:  { type: String, required: true },
    payload:        { type: mongoose.Schema.Types.Mixed, required: true },

    processed:      { type: Boolean, default: false, index: true },
    processedAt:    { type: Date, default: null },

    retryCount:     { type: Number, default: 0 },
    lastError:      { type: String, default: null },

    deadLettered:       { type: Boolean, default: false, index: true },
    deadLetteredAt:     { type: Date, default: null },
    deadLetterReason:   { type: String, default: null },

    /**
     * Dispatch lock: set to a future Date while a dispatcher worker is
     * processing this event.  Another worker seeing lockedUntil > now will
     * skip the event, preventing concurrent double-delivery.
     * Automatically expires so a crashed worker cannot lock an event forever.
     */
    lockedUntil:    { type: Date, default: null, index: true },

    /**
     * Delayed retry: dispatcher skips events where scheduledAfter > now,
     * enabling exponential-backoff without external queues.
     */
    scheduledAfter: { type: Date, default: null, index: true },
  },
  {
    timestamps: true,
  }
);

outboxSchema.index({ processed: 1, deadLettered: 1, createdAt: 1 });
outboxSchema.index({ eventType: 1, processed: 1 });
// Compound index used by the dispatcher's claim query.
outboxSchema.index({ processed: 1, deadLettered: 1, lockedUntil: 1, scheduledAfter: 1, createdAt: 1 });

// TTL index: auto-expire processed (but not dead-lettered) events after 30 days.
// The TTL daemon only fires when processedAt is set; unprocessed events are never
// expired, so nothing is silently discarded before delivery.
outboxSchema.index(
  { processedAt: 1 },
  { expireAfterSeconds: PROCESSED_TTL_SECONDS, partialFilterExpression: { deadLettered: false } },
);

module.exports = mongoose.model('Outbox', outboxSchema);
