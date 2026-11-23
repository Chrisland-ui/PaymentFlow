'use strict';

/**
 * Issue #58: Define asset and decimal validation on-chain.
 *
 * Acceptance Criteria:
 *   1. Unsupported assets fail before state mutation.
 *   2. Amount boundaries are tested (zero, negative, minimum 1 stroop, max int64, overflow).
 *   3. Off-chain validation matches contract rules.
 */

const {
  DECIMALS,
  STROOPS_PER_UNIT,
  MIN_AMOUNT_STROOPS,
  MAX_INT64_STROOPS,
  ERROR_CODES,
  ContractAssetValidationError,
  parseAssetIdentifier,
  validateContractAsset,
  validateContractAmount,
  validateContractAssetAndAmount,
  verifyOffChainMatchesContract,
} = require('../backend/src/services/contractAssetValidation');

describe('Issue #58 — Contract Asset and Decimal Validation', () => {
  describe('parseAssetIdentifier', () => {
    test('parses "native" and "XLM" string to native asset descriptor', () => {
      expect(parseAssetIdentifier('native')).toEqual({
        code: 'XLM',
        type: 'native',
        issuer: null,
        identifier: 'XLM:native',
      });
      expect(parseAssetIdentifier('XLM')).toEqual({
        code: 'XLM',
        type: 'native',
        issuer: null,
        identifier: 'XLM:native',
      });
    });

    test('parses code:issuer string', () => {
      const parsed = parseAssetIdentifier('USDC:GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B');
      expect(parsed.code).toBe('USDC');
      expect(parsed.type).toBe('credit_alphanum4');
      expect(parsed.issuer).toBe('GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B');
      expect(parsed.identifier).toBe('USDC:GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B');
    });

    test('parses object format', () => {
      const parsed = parseAssetIdentifier({
        code: 'USDC',
        issuer: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B',
      });
      expect(parsed.code).toBe('USDC');
      expect(parsed.type).toBe('credit_alphanum4');
      expect(parsed.issuer).toBe('GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B');
    });

    test('throws error for missing or empty asset input', () => {
      expect(() => parseAssetIdentifier(null)).toThrow(ContractAssetValidationError);
      expect(() => parseAssetIdentifier('')).toThrow(ContractAssetValidationError);
      expect(() => parseAssetIdentifier({})).toThrow(ContractAssetValidationError);
    });
  });

  describe('validateContractAsset — Identity and Issuer Checks', () => {
    test('succeeds for valid native XLM without issuer', () => {
      const res = validateContractAsset('XLM');
      expect(res.valid).toBe(true);
      expect(res.asset.code).toBe('XLM');
      expect(res.asset.type).toBe('native');
      expect(res.asset.issuer).toBeNull();
      expect(res.asset.decimals).toBe(DECIMALS);
    });

    test('fails if native XLM provides an issuer', () => {
      expect(() => {
        validateContractAsset({ code: 'XLM', issuer: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B' });
      }).toThrow(ContractAssetValidationError);

      try {
        validateContractAsset({ code: 'XLM', issuer: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B' });
      } catch (err) {
        expect(err.code).toBe(ERROR_CODES.ISSUER_NOT_ALLOWED);
      }
    });

    test('succeeds for valid USDC with configured issuer', () => {
      const config = require('../backend/src/config');
      const res = validateContractAsset(`USDC:${config.USDC_ISSUER}`);
      expect(res.valid).toBe(true);
      expect(res.asset.code).toBe('USDC');
      expect(res.asset.issuer).toBe(config.USDC_ISSUER);
    });

    test('fails if credit asset has mismatched rogue issuer (spoofing protection)', () => {
      const rogueIssuer = 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G6O7ODYY2NO74PTDXWUC';
      expect(() => {
        validateContractAsset(`USDC:${rogueIssuer}`);
      }).toThrow(ContractAssetValidationError);

      try {
        validateContractAsset(`USDC:${rogueIssuer}`);
      } catch (err) {
        expect(err.code).toBe(ERROR_CODES.INVALID_ISSUER);
      }
    });

    test('fails for completely unsupported asset code', () => {
      expect(() => {
        validateContractAsset('BTC:GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G6O7ODYY2NO74PTDXWUC');
      }).toThrow(ContractAssetValidationError);

      try {
        validateContractAsset('UNKNOWN');
      } catch (err) {
        expect(err.code).toBe(ERROR_CODES.UNSUPPORTED_ASSET);
      }
    });

    test('fails if asset is not in allowedAssetCodes option', () => {
      expect(() => {
        validateContractAsset('XLM', { allowedAssetCodes: ['USDC'] });
      }).toThrow(ContractAssetValidationError);
    });
  });

  describe('validateContractAmount — Boundary & Decimal Precision', () => {
    test('converts valid decimal string to stroops exact BigInt', () => {
      const res = validateContractAmount('100.5000000');
      expect(res.valid).toBe(true);
      expect(res.stroops).toBe(1005000000n);
      expect(res.amountDecimal).toBe('100.5000000');
    });

    test('handles minimum amount (1 stroop = 0.0000001)', () => {
      const res = validateContractAmount('0.0000001');
      expect(res.valid).toBe(true);
      expect(res.stroops).toBe(1n);
      expect(res.amountDecimal).toBe('0.0000001');
    });

    test('fails on zero amount when allowZero is false', () => {
      expect(() => validateContractAmount('0')).toThrow(ContractAssetValidationError);
      try {
        validateContractAmount('0.0000000');
      } catch (err) {
        expect(err.code).toBe(ERROR_CODES.AMOUNT_ZERO);
      }
    });

    test('allows zero when allowZero is true', () => {
      const res = validateContractAmount('0', { allowZero: true });
      expect(res.valid).toBe(true);
      expect(res.stroops).toBe(0n);
    });

    test('fails on negative amount', () => {
      expect(() => validateContractAmount('-5.0000000')).toThrow(ContractAssetValidationError);
      try {
        validateContractAmount('-0.0000001');
      } catch (err) {
        expect(err.code).toBe(ERROR_CODES.AMOUNT_NEGATIVE);
      }
    });

    test('fails on underflow below 1 stroop when rounding down', () => {
      try {
        validateContractAmount('0.00000004'); // rounds to 0 stroops
      } catch (err) {
        expect(err.code).toBe(ERROR_CODES.AMOUNT_ZERO);
      }
    });

    test('rejects extra decimal precision when strictPrecision is true', () => {
      expect(() => {
        validateContractAmount('10.12345678', { strictPrecision: true });
      }).toThrow(ContractAssetValidationError);

      try {
        validateContractAmount('10.12345678', { strictPrecision: true });
      } catch (err) {
        expect(err.code).toBe(ERROR_CODES.DECIMAL_PRECISION_EXCEEDED);
      }
    });

    test('handles max int64 boundary exactly', () => {
      // 922337203685.4775807 is exactly MAX_INT64_STROOPS
      const res = validateContractAmount('922337203685.4775807');
      expect(res.valid).toBe(true);
      expect(res.stroops).toBe(MAX_INT64_STROOPS);
    });

    test('fails on overflow beyond max int64 boundary', () => {
      expect(() => {
        validateContractAmount('922337203685.4775808'); // 1 stroop beyond max int64
      }).toThrow(ContractAssetValidationError);

      try {
        validateContractAmount('922337203685.4775808');
      } catch (err) {
        expect(err.code).toBe(ERROR_CODES.AMOUNT_OVERFLOW);
      }
    });

    test('fails on invalid format / non-numeric input', () => {
      expect(() => validateContractAmount('abc')).toThrow(ContractAssetValidationError);
      expect(() => validateContractAmount('')).toThrow(ContractAssetValidationError);
      expect(() => validateContractAmount(null)).toThrow(ContractAssetValidationError);
      expect(() => validateContractAmount(Infinity)).toThrow(ContractAssetValidationError);
      expect(() => validateContractAmount(NaN)).toThrow(ContractAssetValidationError);
    });
  });

  describe('validateContractAssetAndAmount — Pre-mutation Protection', () => {
    test('does NOT mutate state if asset is unsupported', () => {
      let stateMutated = false;
      const simulateStateMutation = () => {
        stateMutated = true;
      };

      expect(() => {
        validateContractAssetAndAmount({
          asset: 'INVALID_TOKEN',
          amount: '100.0000000',
        });
        simulateStateMutation();
      }).toThrow(ContractAssetValidationError);

      expect(stateMutated).toBe(false);
    });

    test('does NOT mutate state if amount check fails', () => {
      let stateMutated = false;
      const simulateStateMutation = () => {
        stateMutated = true;
      };

      expect(() => {
        validateContractAssetAndAmount({
          asset: 'XLM',
          amount: '-50.0000000',
        });
        simulateStateMutation();
      }).toThrow(ContractAssetValidationError);

      expect(stateMutated).toBe(false);
    });

    test('passes and enables state mutation when asset and amount are valid', () => {
      let stateMutated = false;
      const simulateStateMutation = () => {
        stateMutated = true;
      };

      const result = validateContractAssetAndAmount({
        asset: 'XLM',
        amount: '25.0000000',
      });

      expect(result.valid).toBe(true);
      expect(result.stroops).toBe(250000000n);
      simulateStateMutation();
      expect(stateMutated).toBe(true);
    });
  });

  describe('verifyOffChainMatchesContract — Parity Verification', () => {
    test('confirms parity for valid native XLM payment', () => {
      const parity = verifyOffChainMatchesContract('XLM', '50.0000000');
      expect(parity.matches).toBe(true);
      expect(parity.assetAgrees).toBe(true);
      expect(parity.amountAgrees).toBe(true);
    });

    test('confirms parity for unsupported asset', () => {
      const parity = verifyOffChainMatchesContract('DOGE', '10.0000000');
      expect(parity.matches).toBe(true);
      expect(parity.offChain.assetAccepted).toBe(false);
      expect(parity.onChain.assetValid).toBe(false);
    });

    test('confirms parity for invalid amount', () => {
      const parity = verifyOffChainMatchesContract('XLM', '-10.0000000');
      expect(parity.matches).toBe(true);
      expect(parity.amountAgrees).toBe(true);
      expect(parity.onChain.amountError).toBe(ERROR_CODES.AMOUNT_NEGATIVE);
    });
  });
});
