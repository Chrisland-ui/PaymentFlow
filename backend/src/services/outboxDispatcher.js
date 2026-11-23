'use strict';

const Outbox = require('../models/outboxModel');
const paymentEvents = require('../events/paymentEvents');
const logger = require('../utils/logger').child('OutboxDispatcher');

const BATCH_SIZE = 100;
const MAX_RETRIES = parseInt(process.env.OUTBOX_MAX_RETRIES, 10) || 3;
const DISPATCH_INTERVAL_MS = parseInt(process.env.OUTBOX_DISPATCH_INTERVAL_MS, 10) || 5000;
/**
 * How long (ms) a dispatcher worker holds the dispatch lock on an event.
 * Must exceed the expected processing time for a single event.
 * If the worker crashes the lock expires automatically so another worker
 * can reclaim the event after LOCK_TTL_MS.
 */
const LOCK_TTL_MS = parseInt(process.env.OUTBOX_LOCK_TTL_MS, 10) || 30000;

let _dispatchTimer = null;

async function deadLetterOutboxEvent(event, retryCount, errorMessage) {
  logger.error('Outbox event exceeded max retries', {
    eventId: event.eventId,
    eventType: event.eventType,
    error: errorMessage,
    retryCount,
    maxRetries: MAX_RETRIES,
  });

  await Outbox.findByIdAndUpdate(event._id, {
    retryCount,
    lastError: errorMessage,
    deadLettered: true,
    deadLetteredAt: new Date(),
    deadLetterReason: 'max_retries_exhausted',
    lockedUntil: null,
  });
}

/**
 * Try to atomically claim an outbox event for dispatch by setting its
 * lockedUntil to now + LOCK_TTL_MS.
 *
 * The findOneAndUpdate filter requires that the event is still unclaimed
 * (lockedUntil is null or already expired). This prevents two concurrent
 * dispatcher instances from double-delivering the same event.
 *
 * @param {import('mongoose').Document} event
 * @returns {Promise<boolean>} true if the lock was acquired, false otherwise
 */
async function tryClaimEvent(event) {
  const now = new Date();
  const lockExpiry = new Date(now.getTime() + LOCK_TTL_MS);

  const claimed = await Outbox.findOneAndUpdate(
    {
      _id: event._id,
      processed: false,
      deadLettered: { $ne: true },
      // Only claim if not currently locked by another worker.
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
    },
    { $set: { lockedUntil: lockExpiry } },
    { new: false },
  );

  return claimed !== null;
}

async function dispatchOutboxEvents() {
  const now = new Date();

  try {
    // Fetch candidate events:
    //   - not yet processed
    //   - not dead-lettered
    //   - lock expired or absent (so the batch query is safe)
    //   - scheduledAfter in the past or absent
    const batch = await Outbox.find({
      processed: false,
      deadLettered: { $ne: true },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
      $or: [{ scheduledAfter: null }, { scheduledAfter: { $lte: now } }], // eslint-disable-line no-dupe-keys
    })
      .limit(BATCH_SIZE)
      .sort({ createdAt: 1 });

    for (const event of batch) {
      // Idempotency guard: if the event was processed between the batch fetch
      // and now (e.g. by another dispatcher pod), skip it.
      if (event.processed && event.processedAt) {
        logger.debug('Outbox event already processed; skipping', { eventId: event.eventId });
        continue;
      }

      // Honour scheduledAfter (could have been set to a future date on a
      // previous retry attempt via the batch query we use the index, but
      // double-check in-memory to be safe).
      if (event.scheduledAfter && event.scheduledAfter > now) {
        logger.debug('Outbox event scheduled for future; skipping', {
          eventId: event.eventId,
          scheduledAfter: event.scheduledAfter,
        });
        continue;
      }

      // Attempt to acquire the dispatch lock.  If another worker beat us to
      // it, skip this event — it will be processed by that worker.
      const locked = await tryClaimEvent(event);
      if (!locked) {
        logger.debug('Outbox event already locked by another worker; skipping', { eventId: event.eventId });
        continue;
      }

      try {
        if ((event.retryCount || 0) >= MAX_RETRIES) {
          await deadLetterOutboxEvent(event, event.retryCount || 0, event.lastError || 'Retry budget exhausted');
          continue;
        }

        const results = await paymentEvents.asyncEmit(event.eventType, event.payload);

        // If any listener failed (rejected), treat the whole dispatch as
        // failed so the event gets retried or dead-lettered rather than
        // being permanently marked processed with unprocessed side-effects.
        const rejected = results.filter((r) => r.status === 'rejected');
        if (rejected.length > 0) {
          const messages = rejected.map((r) => r.reason?.message || String(r.reason));
          throw new Error(`Listener(s) rejected: ${messages.join('; ')}`);
        }

        await Outbox.findByIdAndUpdate(event._id, {
          processed: true,
          processedAt: new Date(),
          lockedUntil: null,
        });
      } catch (err) {
        const retryCount = (event.retryCount || 0) + 1;

        if (retryCount >= MAX_RETRIES) {
          await deadLetterOutboxEvent(event, retryCount, err.message);
        } else {
          // Exponential backoff: schedule the next retry attempt.
          const backoffMs = Math.min(1000 * Math.pow(2, retryCount), 60000);
          const scheduledAfter = new Date(now.getTime() + backoffMs);
          await Outbox.findByIdAndUpdate(event._id, {
            retryCount,
            lastError: err.message,
            lockedUntil: null,
            scheduledAfter,
          });
        }
      }
    }

    if (batch.length > 0) {
      logger.debug('Dispatched outbox events', { count: batch.length });
    }
  } catch (err) {
    logger.error('Outbox dispatch error', { error: err.message });
  }
}

function startOutboxDispatcher() {
  if (_dispatchTimer) return;
  // dispatchOutboxEvents already catches everything it awaits internally, but
  // passing an async function straight to setInterval is a structural trap:
  // Node never observes the returned promise, so any *future* change that adds
  // an await outside its try/catch would silently become an unhandled
  // rejection — and, per docs/error-handling.md, that crashes the whole
  // multi-tenant process over a background job affecting a single school's
  // event. This terminal .catch() is the boundary that makes that impossible
  // regardless of what dispatchOutboxEvents does internally.
  _dispatchTimer = setInterval(() => {
    dispatchOutboxEvents().catch((err) => {
      logger.error('Outbox dispatch tick failed unexpectedly', { error: err.message, stack: err.stack });
    });
  }, DISPATCH_INTERVAL_MS);
  if (_dispatchTimer.unref) _dispatchTimer.unref();
  logger.info('Outbox dispatcher started');
}

function stopOutboxDispatcher() {
  if (_dispatchTimer) {
    clearInterval(_dispatchTimer);
    _dispatchTimer = null;
    logger.info('Outbox dispatcher stopped');
  }
}

module.exports = {
  dispatchOutboxEvents,
  startOutboxDispatcher,
  stopOutboxDispatcher,
  // Exported for testing only:
  tryClaimEvent,
};
