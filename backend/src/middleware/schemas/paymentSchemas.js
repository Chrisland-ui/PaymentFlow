'use strict';

/**
 * Payment Validation Schemas
 * --------------------------
 * Pure Joi schema objects — no Express logic here.
 * Each schema can be consumed by the `validate()` factory in validate.js
 * or reused directly in unit tests without spinning up an HTTP server.
 *
 * Stellar precision note: XLM and USDC on Stellar both support up to
 * 7 decimal places.  Amounts are validated as decimal strings via
 * decimalPrecision.js so that floating-point coercion never alters the
 * value between the API boundary and business logic.
 */

const Joi = require('joi');
const { decimalAmountJoi, CURRENCY_RULES } = require('../utils/decimalPrecision');

// ── Shared atomic rules ──────────────────────────────────────────────────────

/**
 * A valid MongoDB ObjectId is a 24-character lowercase hex string.
 * Using `hex()` + `length()` keeps the error messages precise.
 */
const mongoObjectId = Joi.string()
  .hex()
  .length(24)
  .lowercase()
  .messages({
    'string.base':     '"studentId" must be a string',
    'string.hex':      '"studentId" must be a valid MongoDB ObjectId (24-char hex)',
    'string.length':   '"studentId" must be a valid MongoDB ObjectId (exactly 24 characters)',
    'string.lowercase':'\"studentId\" must be lowercase hex',
    'any.required':    '"studentId" is required',
  });

/** Minimum payment amount (1.0 XLM / USDC) matching Stellar's minimum meaningful transfer. */
const MIN_AMOUNT = 1.0;

/**
 * Validates that an amount:
 *   - is supplied as a decimal string or number
 *   - is positive and >= MIN_AMOUNT
 *   - has at most 7 decimal places (Stellar precision)
 *   - round-trips exactly through storage and re-parse
 *
 * Uses decimalAmountJoi() so the same rules apply to the fee controller and any
 * future endpoint that accepts monetary values.
 */
const stellarAmount = decimalAmountJoi({ currency: 'XLM', minValue: MIN_AMOUNT })
  .messages({
    'any.required': '"amount" is required',
    'any.invalid':  '"amount" {{#reason}}',
  });

/** Whitelisted Stellar asset codes — extend this array as more tokens are accepted. */
const ALLOWED_CURRENCIES = Object.keys(CURRENCY_RULES);

const currencyCode = Joi.string()
  .valid(...ALLOWED_CURRENCIES)
  .uppercase()
  .messages({
    'string.base':  '"currency" must be a string',
    'any.only':     `"currency" must be one of [${ALLOWED_CURRENCIES.join(', ')}]`,
  });

// ── Payment Intent ────────────────────────────────────────────────────────────

/**
 * POST /api/payments/intent
 *
 * `studentId`  required  — MongoDB ObjectId hex identifying the student record.
 * `amount`     optional  — Pre-declared amount (overridden by the on-chain value).
 * `currency`   optional  — Asset code; must be whitelisted if provided.
 */
const createPaymentIntentSchema = Joi.object({
  studentId: mongoObjectId.required(),
  amount:    stellarAmount.optional(),
  currency:  currencyCode.optional(),
}).options({ allowUnknown: false, abortEarly: false });

// ── Submit Transaction ────────────────────────────────────────────────────────

/**
 * POST /api/payments/submit
 *
 * `xdr`  required  — Base64-encoded Stellar XDR transaction envelope.
 *                    The controller decodes and validates the Stellar-level
 *                    content; this schema only ensures the field is present
 *                    and non-empty.
 */
const submitTransactionSchema = Joi.object({
  xdr: Joi.string().trim().min(1).max(48 * 1024).required().messages({
    'string.base':  '"xdr" must be a string',
    'string.empty': '"xdr" must not be an empty string',
    'string.min':   '"xdr" must not be an empty string',
    'string.max':   '"xdr" must not exceed 49152 characters',
    'any.required': '"xdr" is required',
  }),
}).options({ allowUnknown: false, abortEarly: false });

// ── Verify Payment ────────────────────────────────────────────────────────────

/**
 * POST /api/payments/verify
 *
 * `txHash`  required  — 64-character lowercase hex string (SHA-256 of the
 *                       Stellar transaction XDR).
 */
const verifyPaymentSchema = Joi.object({
  txHash: Joi.string()
    .pattern(/^[a-f0-9]{64}$/)
    .required()
    .messages({
      'string.base':    '"txHash" must be a string',
      'string.pattern.base': '"txHash" must be a valid 64-character hex string',
      'any.required':   '"txHash" is required',
    }),
}).options({ allowUnknown: false, abortEarly: false });

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  createPaymentIntentSchema,
  submitTransactionSchema,
  verifyPaymentSchema,
  /** Exported for reuse in future schemas (e.g. student registration). */
  _atoms: { mongoObjectId, stellarAmount, currencyCode, ALLOWED_CURRENCIES },
};
