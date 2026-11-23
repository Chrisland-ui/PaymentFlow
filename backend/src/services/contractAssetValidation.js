'use strict';

/**
 * On-chain & Contract Asset and Decimal Validation (Issue #58).
 *
 * Asset identity and precision mismatches can cause incorrect settlement or
 * locked funds. This module defines the authoritative contract rules for:
 *   1. Accepted asset identifiers and canonical SAC/Stellar representations.
 *   2. Strict issuer checks (preventing rogue token spoofing).
 *   3. Decimal conversion and exact integer stroop boundary enforcement.
 *   4. Explicit underflow and overflow error handling before state mutation.
 *   5. Off-chain vs. on-chain validation parity assertions.
 */

const config = require('../config');
const {
  ALL_ASSETS,
  ACCEPTED_ASSETS,
  isAcceptedAsset,
} = require('../config/stellarConfig');
const {
  toStroops,
  fromStroops,
} = require('../utils/stellarAmount');

const DECIMALS = 7;
const STROOPS_PER_UNIT = 10000000n; // 10^7
const MIN_AMOUNT_STROOPS = 1n; // 0.0000001 (1 stroop)
const MAX_INT64_STROOPS = 9223372036854775807n; // max signed 64-bit int
const MAX_INT128_STROOPS = 170141183460469231731687303715884105727n; // max signed 128-bit int

const ERROR_CODES = {
  UNSUPPORTED_ASSET: 'UNSUPPORTED_ASSET',
  INVALID_ASSET_TYPE: 'INVALID_ASSET_TYPE',
  INVALID_ISSUER: 'INVALID_ISSUER',
  ISSUER_NOT_ALLOWED: 'ISSUER_NOT_ALLOWED',
  MISSING_ISSUER: 'MISSING_ISSUER',
  AMOUNT_REQUIRED: 'AMOUNT_REQUIRED',
  INVALID_AMOUNT_FORMAT: 'INVALID_AMOUNT_FORMAT',
  AMOUNT_ZERO: 'AMOUNT_ZERO',
  AMOUNT_NEGATIVE: 'AMOUNT_NEGATIVE',
  AMOUNT_UNDERFLOW: 'AMOUNT_UNDERFLOW',
  AMOUNT_OVERFLOW: 'AMOUNT_OVERFLOW',
  DECIMAL_PRECISION_EXCEEDED: 'DECIMAL_PRECISION_EXCEEDED',
};

class ContractAssetValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ContractAssetValidationError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Parses an asset representation into a normalized object.
 *
 * Supported formats:
 *   - 'XLM' or 'native'
 *   - 'USDC:<issuer>'
 *   - { code: 'USDC', issuer: '...', type?: 'credit_alphanum4' }
 *
 * @param {string|object} assetInput
 * @returns {{ code: string, type: string, issuer: string|null, identifier: string }}
 */
function parseAssetIdentifier(assetInput) {
  if (!assetInput) {
    throw new ContractAssetValidationError(
      ERROR_CODES.UNSUPPORTED_ASSET,
      'Asset identifier is required'
    );
  }

  if (typeof assetInput === 'string') {
    const trimmed = assetInput.trim();
    if (trimmed.toUpperCase() === 'NATIVE' || trimmed.toUpperCase() === 'XLM') {
      return {
        code: 'XLM',
        type: 'native',
        issuer: null,
        identifier: 'XLM:native',
      };
    }

    if (trimmed.includes(':')) {
      const parts = trimmed.split(':');
      const code = parts[0].trim().toUpperCase();
      const issuer = parts[1].trim();
      const type = code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12';
      return {
        code,
        type,
        issuer,
        identifier: `${code}:${issuer}`,
      };
    }

    // Bare code without issuer
    const code = trimmed.toUpperCase();
    if (code === 'XLM') {
      return {
        code: 'XLM',
        type: 'native',
        issuer: null,
        identifier: 'XLM:native',
      };
    }

    // If bare code matches a known credit asset in config, inspect issuer
    const known = ALL_ASSETS[code];
    return {
      code,
      type: known ? known.type : (code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12'),
      issuer: known && known.issuer ? known.issuer : null,
      identifier: known && known.issuer ? `${code}:${known.issuer}` : code,
    };
  }

  if (typeof assetInput === 'object') {
    const code = (assetInput.code || '').trim().toUpperCase();
    if (!code) {
      throw new ContractAssetValidationError(
        ERROR_CODES.UNSUPPORTED_ASSET,
        'Asset object missing required code property'
      );
    }

    if (code === 'XLM' || assetInput.type === 'native') {
      return {
        code: 'XLM',
        type: 'native',
        issuer: assetInput.issuer || null,
        identifier: 'XLM:native',
      };
    }

    const type = assetInput.type || (code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12');
    const issuer = assetInput.issuer ? assetInput.issuer.trim() : null;
    return {
      code,
      type,
      issuer,
      identifier: issuer ? `${code}:${issuer}` : code,
    };
  }

  throw new ContractAssetValidationError(
    ERROR_CODES.UNSUPPORTED_ASSET,
    `Invalid asset input type: ${typeof assetInput}`
  );
}

/**
 * Validates that an asset satisfies on-chain contract specifications and issuer checks.
 *
 * Rules:
 *   - Asset must be supported by the contract configuration.
 *   - Native asset (XLM) must NOT have an issuer attached.
 *   - Credit asset (USDC) MUST have an issuer matching the configured trusted issuer.
 *
 * @param {string|object} assetInput
 * @param {object} [options]
 * @param {string[]} [options.allowedAssetCodes] Optional subset of allowed codes
 * @returns {{ valid: boolean, asset: { code: string, type: string, issuer: string|null, decimals: number, identifier: string } }}
 */
function validateContractAsset(assetInput, options = {}) {
  const parsed = parseAssetIdentifier(assetInput);
  const knownDefinition = ALL_ASSETS[parsed.code];

  if (!knownDefinition) {
    throw new ContractAssetValidationError(
      ERROR_CODES.UNSUPPORTED_ASSET,
      `Asset "${parsed.code}" is not supported by contract specification`,
      { asset: parsed }
    );
  }

  if (options.allowedAssetCodes && !options.allowedAssetCodes.includes(parsed.code)) {
    throw new ContractAssetValidationError(
      ERROR_CODES.UNSUPPORTED_ASSET,
      `Asset "${parsed.code}" is not active in current contract deployment`,
      { asset: parsed, allowed: options.allowedAssetCodes }
    );
  }

  // Native XLM checks
  if (knownDefinition.type === 'native') {
    if (parsed.issuer) {
      throw new ContractAssetValidationError(
        ERROR_CODES.ISSUER_NOT_ALLOWED,
        'Native Stellar Lumens (XLM) cannot have an issuer',
        { asset: parsed }
      );
    }
    return {
      valid: true,
      asset: {
        code: 'XLM',
        type: 'native',
        issuer: null,
        decimals: DECIMALS,
        identifier: 'XLM:native',
      },
    };
  }

  // Credit asset checks (e.g. USDC)
  if (!parsed.issuer) {
    throw new ContractAssetValidationError(
      ERROR_CODES.MISSING_ISSUER,
      `Credit asset "${parsed.code}" requires an explicit trusted issuer`,
      { asset: parsed }
    );
  }

  const expectedIssuer = knownDefinition.issuer || config.USDC_ISSUER;
  if (!expectedIssuer) {
    throw new ContractAssetValidationError(
      ERROR_CODES.INVALID_ISSUER,
      `No trusted issuer is configured for asset "${parsed.code}"`,
      { asset: parsed }
    );
  }

  if (parsed.issuer !== expectedIssuer) {
    throw new ContractAssetValidationError(
      ERROR_CODES.INVALID_ISSUER,
      `Issuer mismatch for asset "${parsed.code}": expected ${expectedIssuer}, received ${parsed.issuer}`,
      { asset: parsed, expectedIssuer }
    );
  }

  return {
    valid: true,
    asset: {
      code: parsed.code,
      type: knownDefinition.type,
      issuer: parsed.issuer,
      decimals: DECIMALS,
      identifier: `${parsed.code}:${parsed.issuer}`,
    },
  };
}

/**
 * Validates and converts an amount into exact integer stroops under contract arithmetic boundaries.
 *
 * @param {string|number|bigint} amount
 * @param {object} [options]
 * @param {boolean} [options.allowZero=false]
 * @param {bigint} [options.minStroops=1n]
 * @param {bigint} [options.maxStroops=MAX_INT64_STROOPS]
 * @param {boolean} [options.strictPrecision=false] If true, rejects sub-stroop decimals instead of rounding
 * @returns {{ valid: boolean, stroops: bigint, amountDecimal: string }}
 */
function validateContractAmount(amount, options = {}) {
  const allowZero = options.allowZero === true;
  const minStroops = options.minStroops !== undefined ? BigInt(options.minStroops) : MIN_AMOUNT_STROOPS;
  const maxStroops = options.maxStroops !== undefined ? BigInt(options.maxStroops) : MAX_INT64_STROOPS;
  const strictPrecision = options.strictPrecision === true;

  if (amount === null || amount === undefined || amount === '') {
    throw new ContractAssetValidationError(
      ERROR_CODES.AMOUNT_REQUIRED,
      'Amount is required and cannot be empty'
    );
  }

  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) {
      throw new ContractAssetValidationError(
        ERROR_CODES.INVALID_AMOUNT_FORMAT,
        'Amount must be a finite numeric value'
      );
    }
  }

  let amountStr = typeof amount === 'bigint'
    ? amount.toString()
    : typeof amount === 'number'
      ? amount.toFixed(DECIMALS)
      : String(amount).trim();

  // Negative amount check
  if (amountStr.startsWith('-')) {
    throw new ContractAssetValidationError(
      ERROR_CODES.AMOUNT_NEGATIVE,
      'Amount cannot be negative',
      { amount }
    );
  }

  // Format validation
  if (!/^\d*(\.\d*)?$/.test(amountStr) || amountStr === '' || amountStr === '.') {
    throw new ContractAssetValidationError(
      ERROR_CODES.INVALID_AMOUNT_FORMAT,
      `Invalid amount format: "${amount}"`,
      { amount }
    );
  }

  const [intPart = '0', fracRaw = ''] = amountStr.split('.');

  // Strict precision check (if decimals > 7)
  if (strictPrecision && fracRaw.length > DECIMALS) {
    throw new ContractAssetValidationError(
      ERROR_CODES.DECIMAL_PRECISION_EXCEEDED,
      `Amount exceeds maximum allowed precision of ${DECIMALS} decimal places`,
      { amount, decimals: fracRaw.length, maxDecimals: DECIMALS }
    );
  }

  let stroops;
  try {
    stroops = toStroops(amount);
  } catch (err) {
    throw new ContractAssetValidationError(
      ERROR_CODES.INVALID_AMOUNT_FORMAT,
      `Failed to convert amount to contract stroops: ${err.message}`,
      { amount }
    );
  }

  if (stroops === 0n) {
    if (!allowZero) {
      throw new ContractAssetValidationError(
        ERROR_CODES.AMOUNT_ZERO,
        'Amount must be greater than zero',
        { amount, stroops: '0' }
      );
    }
    return {
      valid: true,
      stroops: 0n,
      amountDecimal: '0.0000000',
    };
  }

  // Underflow check
  if (stroops < minStroops) {
    throw new ContractAssetValidationError(
      ERROR_CODES.AMOUNT_UNDERFLOW,
      `Amount underflow: ${stroops.toString()} stroops is less than minimum ${minStroops.toString()} stroops`,
      { amount, stroops: stroops.toString(), minStroops: minStroops.toString() }
    );
  }

  // Overflow check
  if (stroops > maxStroops) {
    throw new ContractAssetValidationError(
      ERROR_CODES.AMOUNT_OVERFLOW,
      `Amount overflow: ${stroops.toString()} stroops exceeds contract maximum ${maxStroops.toString()} stroops`,
      { amount, stroops: stroops.toString(), maxStroops: maxStroops.toString() }
    );
  }

  return {
    valid: true,
    stroops,
    amountDecimal: fromStroops(stroops),
  };
}

/**
 * Validates both asset and amount atomically BEFORE state mutation.
 *
 * If either asset identity or amount boundary check fails, an error is thrown
 * and NO mutation occurs.
 *
 * @param {object} params
 * @param {string|object} params.asset
 * @param {string|number|bigint} params.amount
 * @param {boolean} [params.allowZero=false]
 * @param {bigint} [params.customMaxStroops]
 * @param {boolean} [params.strictPrecision=false]
 * @param {string[]} [params.allowedAssetCodes]
 * @returns {{ valid: boolean, asset: object, stroops: bigint, amountDecimal: string }}
 */
function validateContractAssetAndAmount({
  asset,
  amount,
  allowZero = false,
  customMaxStroops = null,
  strictPrecision = false,
  allowedAssetCodes = null,
}) {
  const validatedAsset = validateContractAsset(asset, { allowedAssetCodes });
  const validatedAmount = validateContractAmount(amount, {
    allowZero,
    maxStroops: customMaxStroops || MAX_INT64_STROOPS,
    strictPrecision,
  });

  return {
    valid: true,
    asset: validatedAsset.asset,
    stroops: validatedAmount.stroops,
    amountDecimal: validatedAmount.amountDecimal,
  };
}

/**
 * Asserts that off-chain validation rules match contract rules.
 *
 * Validates that:
 *   1. isAcceptedAsset rejects/accepts consistent with contract rules.
 *   2. Amount conversions in stellarAmount match contract stroop arithmetic.
 *
 * @param {string|object} assetInput
 * @param {string|number|bigint} amountInput
 * @returns {{ matches: boolean, offChain: object, onChain: object }}
 */
function verifyOffChainMatchesContract(assetInput, amountInput) {
  let onChainAsset = null;
  let onChainAssetError = null;
  let onChainAmount = null;
  let onChainAmountError = null;

  try {
    onChainAsset = validateContractAsset(assetInput);
  } catch (err) {
    onChainAssetError = err;
  }

  try {
    onChainAmount = validateContractAmount(amountInput);
  } catch (err) {
    onChainAmountError = err;
  }

  // Off-chain check
  const parsed = parseAssetIdentifier(assetInput);
  const offChainAssetCheck = isAcceptedAsset(parsed.code, parsed.type, parsed.issuer);

  let offChainStroops = null;
  let offChainAmountError = null;
  try {
    offChainStroops = toStroops(amountInput);
  } catch (err) {
    offChainAmountError = err;
  }

  const assetAgrees = (Boolean(onChainAsset) === offChainAssetCheck.accepted);
  const amountAgrees = (
    (Boolean(onChainAmount) && !offChainAmountError && onChainAmount.stroops === offChainStroops) ||
    (Boolean(onChainAmountError) && (Boolean(offChainAmountError) || onChainAmountError.code === ERROR_CODES.AMOUNT_UNDERFLOW || onChainAmountError.code === ERROR_CODES.AMOUNT_OVERFLOW || onChainAmountError.code === ERROR_CODES.AMOUNT_ZERO || onChainAmountError.code === ERROR_CODES.AMOUNT_NEGATIVE))
  );

  return {
    matches: assetAgrees && amountAgrees,
    assetAgrees,
    amountAgrees,
    offChain: {
      assetAccepted: offChainAssetCheck.accepted,
      stroops: offChainStroops ? offChainStroops.toString() : null,
      error: offChainAmountError ? offChainAmountError.message : null,
    },
    onChain: {
      assetValid: Boolean(onChainAsset),
      assetError: onChainAssetError ? onChainAssetError.code : null,
      stroops: onChainAmount ? onChainAmount.stroops.toString() : null,
      amountError: onChainAmountError ? onChainAmountError.code : null,
    },
  };
}

module.exports = {
  DECIMALS,
  STROOPS_PER_UNIT,
  MIN_AMOUNT_STROOPS,
  MAX_INT64_STROOPS,
  MAX_INT128_STROOPS,
  ERROR_CODES,
  ContractAssetValidationError,
  parseAssetIdentifier,
  validateContractAsset,
  validateContractAmount,
  validateContractAssetAndAmount,
  verifyOffChainMatchesContract,
};
