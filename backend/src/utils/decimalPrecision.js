'use strict';

/**
 * Decimal Precision Validator — Issue #34
 * ----------------------------------------
 * Floating-point coercion can create inconsistent payment amounts between
 * validation, storage, and provider calls.  This module provides a single
 * authoritative validator that must be applied at every API boundary that
 * accepts a monetary value.
 *
 * Design decisions
 * ─────────────────
 * • Amounts MUST be supplied as numeric strings (e.g. "250.00") or integers
 *   (minor-unit representation, e.g. 250000000 stroops).  JS Number inputs
 *   are accepted for backward compatibility but are immediately converted to
 *   their Decimal string representation before any arithmetic, eliminating
 *   the risk of IEEE-754 artefacts travelling further into the system.
 *
 * • Currency-specific rules encode the maximum decimal places permitted for
 *   each asset class.  XLM and USDC on Stellar both support 7 dp; future
 *   assets can be added by extending CURRENCY_RULES without touching call
 *   sites.
 *
 * • Stored and emitted values are always serialised via toDecimalString()
 *   which produces a canonical representation (no trailing zeroes beyond the
 *   currency precision, no scientific notation).
 *
 * • The Joi custom validator rejectsPrecisionViolation() can be used in any
 *   Joi schema that already imports this module.
 *
 * Round-trip guarantee
 * ─────────────────────
 * Any value that passes validateDecimalAmount() can be:
 *   1. Stored as a MongoDB Number (BSON double) without loss for values up to
 *      10^15 (well above any realistic payment ceiling).
 *   2. Re-parsed from the stored string via toMoney() without precision loss.
 *   3. Serialised to JSON and re-parsed with equal value (same guarantee).
 */

const Decimal = require('decimal.js');
const Joi     = require('joi');

// ── Currency rules ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CurrencyRule
 * @property {number} maxDecimalPlaces  Maximum fractional digits allowed.
 * @property {string} description       Human-readable description for error messages.
 */

/** @type {Record<string, CurrencyRule>} */
const CURRENCY_RULES = {
  XLM:  { maxDecimalPlaces: 7, description: 'Stellar Lumens (7 decimal places)' },
  USDC: { maxDecimalPlaces: 7, description: 'USD Coin on Stellar (7 decimal places)' },
};

/** Default rule applied when no currency code is given. */
const DEFAULT_MAX_DECIMAL_PLACES = 2;

// ── Core validation ───────────────────────────────────────────────────────────

/**
 * Validate and normalise a monetary value at an API boundary.
 *
 * @param {string|number} raw - The value as received from the request.
 * @param {Object} [options]
 * @param {string}  [options.currency]      - Asset code (e.g. 'XLM').
 * @param {number}  [options.minValue=0]    - Minimum inclusive value (in major units).
 * @param {number}  [options.maxValue]      - Maximum inclusive value (optional).
 * @returns {{ ok: true, value: Decimal, canonical: string }
 *          |{ ok: false, error: string, code: string }}
 */
function validateDecimalAmount(raw, { currency, minValue = 0, maxValue } = {}) {
  // ── Type check ────────────────────────────────────────────────────────────
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, error: 'Amount is required', code: 'AMOUNT_REQUIRED' };
  }

  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return {
      ok: false,
      error: 'Amount must be a numeric string or number',
      code: 'AMOUNT_INVALID_TYPE',
    };
  }

  const str = String(raw).trim();

  // Reject scientific notation and obviously non-numeric strings early
  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    return {
      ok: false,
      error: `Amount "${str}" is not a valid decimal number`,
      code: 'AMOUNT_INVALID_FORMAT',
    };
  }

  // ── Parse into Decimal ────────────────────────────────────────────────────
  let d;
  try {
    d = new Decimal(str);
  } catch {
    return {
      ok: false,
      error: `Amount "${str}" could not be parsed as a decimal`,
      code: 'AMOUNT_PARSE_FAILED',
    };
  }

  // ── Sign check ────────────────────────────────────────────────────────────
  if (d.isNegative()) {
    return {
      ok: false,
      error: 'Amount must not be negative',
      code: 'AMOUNT_NEGATIVE',
    };
  }

  // ── Precision check ───────────────────────────────────────────────────────
  const rule = currency ? CURRENCY_RULES[currency.toUpperCase()] : null;
  const maxDp = rule ? rule.maxDecimalPlaces : DEFAULT_MAX_DECIMAL_PLACES;
  const currencyLabel = rule ? rule.description : `(default ${maxDp} dp)`;

  // Count actual decimal places in the string representation
  const dotPos = str.indexOf('.');
  const actualDp = dotPos === -1 ? 0 : str.length - dotPos - 1;

  if (actualDp > maxDp) {
    return {
      ok: false,
      error: `Amount "${str}" has ${actualDp} decimal places; ${currencyLabel} allows at most ${maxDp}`,
      code: 'AMOUNT_TOO_PRECISE',
    };
  }

  // ── Range checks ─────────────────────────────────────────────────────────
  if (d.lt(new Decimal(minValue))) {
    return {
      ok: false,
      error: `Amount ${str} is below the minimum allowed value of ${minValue}`,
      code: 'AMOUNT_TOO_LOW',
    };
  }

  if (maxValue !== undefined && d.gt(new Decimal(maxValue))) {
    return {
      ok: false,
      error: `Amount ${str} exceeds the maximum allowed value of ${maxValue}`,
      code: 'AMOUNT_TOO_HIGH',
    };
  }

  return {
    ok:        true,
    value:     d,
    canonical: toDecimalString(d, maxDp),
  };
}

// ── Serialisation ─────────────────────────────────────────────────────────────

/**
 * Produce a canonical decimal string for storage/emission:
 * - No trailing zeroes beyond the minimum necessary.
 * - No scientific notation.
 * - Never a bare "-0".
 *
 * @param {Decimal|number|string} value
 * @param {number} [maxDp=DEFAULT_MAX_DECIMAL_PLACES]
 * @returns {string}
 */
function toDecimalString(value, maxDp = DEFAULT_MAX_DECIMAL_PLACES) {
  const d = value instanceof Decimal ? value : new Decimal(String(value));
  // toSignificantDigits would lose trailing precision; use toFixed then trim.
  const fixed = d.toDecimalPlaces(maxDp).toFixed(maxDp);
  // Remove trailing zeroes after decimal point, and the point itself if bare
  return fixed.replace(/\.?0+$/, '');
}

// ── Minor-unit (stroop) conversion ────────────────────────────────────────────

const STROOPS_PER_UNIT = new Decimal('10000000'); // 1e7

/**
 * Convert a major-unit decimal string to integer stroops.
 * Throws if the conversion would lose precision (e.g. sub-stroop input).
 *
 * @param {string|number|Decimal} majorUnits
 * @returns {string} Integer stroop count as a string (safe for BigInt).
 */
function toStroops(majorUnits) {
  const d = new Decimal(String(majorUnits));
  const stroops = d.times(STROOPS_PER_UNIT);
  if (!stroops.isInteger()) {
    throw new RangeError(
      `${majorUnits} cannot be expressed as a whole number of stroops (sub-stroop precision)`
    );
  }
  return stroops.toFixed(0);
}

/**
 * Convert stroop integer back to major units.
 *
 * @param {string|number} stroops
 * @returns {string} canonical major-unit decimal string
 */
function fromStroops(stroops) {
  const d = new Decimal(String(stroops)).div(STROOPS_PER_UNIT);
  return toDecimalString(d, CURRENCY_RULES.XLM.maxDecimalPlaces);
}

function toMinorUnits(value, decimalPlaces = DEFAULT_MAX_DECIMAL_PLACES) {
  const amount = new Decimal(String(value));
  const minorUnits = amount.times(new Decimal(10).pow(decimalPlaces));
  if (!minorUnits.isInteger()) {
    throw new RangeError(`Amount ${value} exceeds the supported ${decimalPlaces}-decimal precision`);
  }
  return minorUnits.toFixed(0);
}

function fromMinorUnits(value, decimalPlaces = DEFAULT_MAX_DECIMAL_PLACES) {
  return new Decimal(String(value)).div(new Decimal(10).pow(decimalPlaces)).toFixed(decimalPlaces);
}

function toFixedDecimalString(value, decimalPlaces = DEFAULT_MAX_DECIMAL_PLACES) {
  return new Decimal(String(value)).toFixed(decimalPlaces);
}

// ── Joi custom validator ──────────────────────────────────────────────────────

/**
 * Returns a Joi extension that validates a field as a decimal amount string.
 *
 * Usage:
 *   const Joi = require('joi');
 *   const { decimalAmountJoi } = require('./decimalPrecision');
 *   const schema = Joi.object({ amount: decimalAmountJoi({ currency: 'XLM', minValue: 0.01 }) });
 *
 * @param {Object} [options]
 * @param {string} [options.currency]
 * @param {number} [options.minValue=0]
 * @param {number} [options.maxValue]
 * @returns {Joi.Schema}
 */
function decimalAmountJoi(options = {}) {
  return Joi.alternatives()
    .try(Joi.string(), Joi.number())
    .custom((value, helpers) => {
      const result = validateDecimalAmount(value, options);
      if (!result.ok) {
        return helpers.error('any.invalid', { reason: result.error });
      }
      // Normalise to canonical string — prevents downstream float coercion
      return result.canonical;
    })
    .messages({
      'any.invalid': '{{#reason}}',
    });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  CURRENCY_RULES,
  DEFAULT_MAX_DECIMAL_PLACES,
  validateDecimalAmount,
  toDecimalString,
  toStroops,
  fromStroops,
  toMinorUnits,
  fromMinorUnits,
  toFixedDecimalString,
  decimalAmountJoi,
};
