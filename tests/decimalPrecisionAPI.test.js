'use strict';

/**
 * Issue #34 — Decimal precision enforcement at API boundaries.
 *
 * Tests that:
 *   1. validateDecimalAmount rejects malformed precision and coercion traps.
 *   2. Stored and emitted values round-trip exactly (canonical serialisation).
 *   3. Currency-specific rules are enforced (XLM / USDC → 7 dp).
 *   4. The Joi helper decimalAmountJoi integrates cleanly into schema validation.
 *   5. toStroops / fromStroops produce exact integer conversions.
 */

const {
  validateDecimalAmount,
  toDecimalString,
  toStroops,
  fromStroops,
  decimalAmountJoi,
  CURRENCY_RULES,
} = require('../backend/src/utils/decimalPrecision');
const Decimal = require('decimal.js');
const Joi     = require('joi');

// ── 1. validateDecimalAmount — rejection cases ────────────────────────────────

describe('validateDecimalAmount — rejection', () => {
  test.each([
    ['empty string',       '',          'AMOUNT_REQUIRED'],
    ['null',               null,        'AMOUNT_REQUIRED'],
    ['undefined',          undefined,   'AMOUNT_REQUIRED'],
    ['non-numeric string', 'abc',       'AMOUNT_INVALID_FORMAT'],
    ['scientific notation','1e5',       'AMOUNT_INVALID_FORMAT'],
    ['negative number',    '-1',        'AMOUNT_NEGATIVE'],
    ['negative string',    '-0.5',      'AMOUNT_NEGATIVE'],
    ['array',              [],          'AMOUNT_INVALID_TYPE'],
    ['object',             {},          'AMOUNT_INVALID_TYPE'],
  ])('rejects %s → code %s', (_label, input, expectedCode) => {
    const result = validateDecimalAmount(input);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(expectedCode);
  });

  test('rejects 8 decimal places for default precision', () => {
    const result = validateDecimalAmount('1.12345678');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('AMOUNT_TOO_PRECISE');
    expect(result.error).toMatch(/8 decimal places/);
  });

  test('rejects exactly 8 dp for XLM', () => {
    const result = validateDecimalAmount('1.00000008', { currency: 'XLM' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('AMOUNT_TOO_PRECISE');
  });

  test('rejects exactly 8 dp for USDC', () => {
    const result = validateDecimalAmount('1.00000008', { currency: 'USDC' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('AMOUNT_TOO_PRECISE');
  });

  test('rejects value below minValue', () => {
    const result = validateDecimalAmount('0.5', { minValue: 1.0 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('AMOUNT_TOO_LOW');
  });

  test('rejects value above maxValue', () => {
    const result = validateDecimalAmount('100001', { maxValue: 100000 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('AMOUNT_TOO_HIGH');
  });
});

// ── 2. validateDecimalAmount — acceptance cases ───────────────────────────────

describe('validateDecimalAmount — acceptance', () => {
  test.each([
    ['integer string',    '250'],
    ['7 dp string',       '1.0000001'],
    ['exactly 7 dp',      '100.1234567'],
    ['zero dp',           '100'],
    ['JS number',          250.5],
    ['string "0"',        '0'],
    ['0.1 + 0.2 coercion trick as string', '0.3'],
  ])('accepts %s', (_label, input) => {
    const result = validateDecimalAmount(input);
    expect(result.ok).toBe(true);
    expect(result.value).toBeInstanceOf(Decimal);
    expect(typeof result.canonical).toBe('string');
  });

  test('result.value is a Decimal instance', () => {
    const { value } = validateDecimalAmount('123.456');
    expect(value).toBeInstanceOf(Decimal);
    expect(value.toFixed(3)).toBe('123.456');
  });
});

// ── 3. Round-trip guarantee ───────────────────────────────────────────────────

describe('round-trip serialisation', () => {
  const ROUND_TRIP_CASES = [
    '0',
    '0.0000001',
    '1',
    '1.5',
    '100.1234567',
    '250',
    '1000000',
    '99.9999999',
  ];

  test.each(ROUND_TRIP_CASES)('"%s" survives store → parse → emit unchanged', (input) => {
    const { canonical } = validateDecimalAmount(input);
    // Simulate MongoDB Number storage: canonical → Number → Decimal
    const asNumber = Number(canonical);
    const reDecimal = new Decimal(String(asNumber));
    const reEmitted = toDecimalString(reDecimal);
    expect(reEmitted).toBe(canonical);
  });

  test('0.1 + 0.2 does NOT equal 0.3 as floats but DOES in Decimal', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // prove the float trap
    const a = validateDecimalAmount('0.1');
    const b = validateDecimalAmount('0.2');
    expect(a.ok && b.ok).toBe(true);
    const sum = a.value.plus(b.value);
    expect(toDecimalString(sum)).toBe('0.3');
  });
});

// ── 4. toDecimalString canonical form ────────────────────────────────────────

describe('toDecimalString', () => {
  test('removes trailing zeroes', () => {
    expect(toDecimalString('100.1000000')).toBe('100.1');
  });

  test('removes trailing point', () => {
    expect(toDecimalString('250.0000000')).toBe('250');
  });

  test('preserves significant fractional digits', () => {
    expect(toDecimalString('0.0000001')).toBe('0.0000001');
  });

  test('accepts Decimal instance', () => {
    expect(toDecimalString(new Decimal('3.14'))).toBe('3.14');
  });
});

// ── 5. Currency-specific rules ────────────────────────────────────────────────

describe('CURRENCY_RULES coverage', () => {
  test('XLM allows exactly 7 dp', () => {
    expect(validateDecimalAmount('1.1234567', { currency: 'XLM' }).ok).toBe(true);
  });

  test('XLM rejects 8 dp', () => {
    expect(validateDecimalAmount('1.12345678', { currency: 'XLM' }).ok).toBe(false);
  });

  test('USDC allows exactly 7 dp', () => {
    expect(validateDecimalAmount('1.1234567', { currency: 'USDC' }).ok).toBe(true);
  });

  test('USDC rejects 8 dp', () => {
    expect(validateDecimalAmount('1.12345678', { currency: 'USDC' }).ok).toBe(false);
  });

  test('CURRENCY_RULES exports all supported currencies', () => {
    expect(Object.keys(CURRENCY_RULES)).toEqual(expect.arrayContaining(['XLM', 'USDC']));
  });

  test('each currency rule has maxDecimalPlaces', () => {
    for (const rule of Object.values(CURRENCY_RULES)) {
      expect(typeof rule.maxDecimalPlaces).toBe('number');
      expect(rule.maxDecimalPlaces).toBeGreaterThan(0);
    }
  });
});

// ── 6. Joi integration ────────────────────────────────────────────────────────

describe('decimalAmountJoi Joi schema', () => {
  const schema = Joi.object({
    amount: decimalAmountJoi({ minValue: 1.0 }).required(),
  });

  test('accepts valid decimal string', () => {
    const { error, value } = schema.validate({ amount: '250.5' });
    expect(error).toBeUndefined();
    expect(value.amount).toBe('250.5'); // canonical string, not float
  });

  test('accepts JS number (backward compat)', () => {
    const { error, value } = schema.validate({ amount: 100 });
    expect(error).toBeUndefined();
    expect(value.amount).toBe('100'); // normalised to canonical string
  });

  test('rejects 8 dp string', () => {
    const { error } = schema.validate({ amount: '1.12345678' });
    expect(error).toBeDefined();
  });

  test('rejects value below minValue', () => {
    const { error } = schema.validate({ amount: '0.5' });
    expect(error).toBeDefined();
  });

  test('rejects non-numeric string', () => {
    const { error } = schema.validate({ amount: 'abc' });
    expect(error).toBeDefined();
  });

  test('rejects scientific notation', () => {
    const { error } = schema.validate({ amount: '1e5' });
    expect(error).toBeDefined();
  });

  test('output is canonical string, not a float', () => {
    const { value } = schema.validate({ amount: '100.00' });
    expect(typeof value.amount).toBe('string');
    // Canonical form strips trailing zeroes
    expect(value.amount).toBe('100');
  });
});

// ── 7. toStroops / fromStroops ────────────────────────────────────────────────

describe('toStroops / fromStroops', () => {
  test('1 XLM = 10000000 stroops', () => {
    expect(toStroops('1')).toBe('10000000');
  });

  test('0.0000001 XLM = 1 stroop', () => {
    expect(toStroops('0.0000001')).toBe('1');
  });

  test('250.5 XLM = correct stroop count', () => {
    expect(toStroops('250.5')).toBe('2505000000');
  });

  test('fromStroops(1) = 0.0000001', () => {
    expect(fromStroops('1')).toBe('0.0000001');
  });

  test('fromStroops(10000000) = 1', () => {
    expect(fromStroops('10000000')).toBe('1');
  });

  test('toStroops throws on sub-stroop precision', () => {
    expect(() => toStroops('0.00000001')).toThrow(RangeError);
  });

  test('round-trip: toStroops → fromStroops = original', () => {
    const original = '100.1234567';
    const stroops  = toStroops(original);
    const back     = fromStroops(stroops);
    expect(back).toBe(original);
  });
});

// ── 8. Payment schema integration ────────────────────────────────────────────

describe('paymentSchemas.js — stellarAmount uses decimalAmountJoi', () => {
  const { _atoms } = require('../backend/src/middleware/schemas/paymentSchemas');

  test('stellarAmount is exported and is a Joi schema', () => {
    expect(_atoms.stellarAmount).toBeDefined();
    expect(typeof _atoms.stellarAmount.validate).toBe('function');
  });

  test('stellarAmount rejects 8 dp (previously allowed by old number.precision guard)', () => {
    const { error } = _atoms.stellarAmount.validate('1.12345678');
    expect(error).toBeDefined();
  });

  test('stellarAmount accepts exactly 7 dp string', () => {
    const { error } = _atoms.stellarAmount.validate('1.1234567');
    expect(error).toBeUndefined();
  });

  test('stellarAmount rejects negative value', () => {
    const { error } = _atoms.stellarAmount.validate('-5');
    expect(error).toBeDefined();
  });
});
