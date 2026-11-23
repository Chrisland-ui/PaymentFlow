/**
 * Tests for envValidation.js — Issue #2
 *
 * Covers:
 *   - validateEnv() warns (does not throw) in non-production when NEXT_PUBLIC_API_URL is missing
 *   - validateEnv() throws in production when NEXT_PUBLIC_API_URL is missing
 *   - validateEnv() returns correct values when all vars are set
 *   - getEnvVar returns fallback when var not set
 *   - getEnvVar returns value when var is set
 *
 * Jest environment: node (matches jest.config.js).
 * No React, no DOM — purely unit-tests against the JS module.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Load a fresh copy of the module with the given env vars applied.
 * Resets the module registry to clear module-level state between tests.
 */
function loadModule(envOverrides = {}) {
  jest.resetModules();
  const saved = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const mod = require('../envValidation');
  // Restore env vars
  for (const [key] of Object.entries(envOverrides)) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
  return mod;
}

/**
 * Load a fresh copy of the module, then run a callback with the given env vars
 * applied at call-time (not at module-load time).
 * Useful for validateEnv() / getEnvVar() which read process.env at call time.
 */
function withEnv(envOverrides, fn) {
  jest.resetModules();
  const saved = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const mod = require('../envValidation');
    return fn(mod);
  } finally {
    for (const [key] of Object.entries(envOverrides)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

// ─── getEnvVar ────────────────────────────────────────────────────────────────

describe('envValidation — getEnvVar', () => {
  it('returns the fallback when the var is not set', () => {
    const { getEnvVar } = loadModule();
    // Ensure the var is not set
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(getEnvVar('NEXT_PUBLIC_API_URL', 'http://localhost:5000/api')).toBe('http://localhost:5000/api');
  });

  it('returns the fallback when the var is an empty string', () => {
    const { getEnvVar } = loadModule();
    process.env.__TEST_EMPTY_VAR__ = '';
    expect(getEnvVar('__TEST_EMPTY_VAR__', 'default')).toBe('default');
    delete process.env.__TEST_EMPTY_VAR__;
  });

  it('returns the value when the var is set', () => {
    const { getEnvVar } = loadModule();
    process.env.__TEST_SET_VAR__ = 'http://example.com/api';
    expect(getEnvVar('__TEST_SET_VAR__', 'fallback')).toBe('http://example.com/api');
    delete process.env.__TEST_SET_VAR__;
  });

  it('returns empty string as fallback when no fallback is provided and var is missing', () => {
    const { getEnvVar } = loadModule();
    delete process.env.__TEST_MISSING_VAR__;
    expect(getEnvVar('__TEST_MISSING_VAR__')).toBe('');
  });

  it('returns the value and not the fallback when var is set', () => {
    const { getEnvVar } = loadModule();
    process.env.__TEST_PREF_VAR__ = 'actual-value';
    expect(getEnvVar('__TEST_PREF_VAR__', 'should-not-be-used')).toBe('actual-value');
    delete process.env.__TEST_PREF_VAR__;
  });
});

// ─── validateEnv — development (non-production) ───────────────────────────────

describe('envValidation — validateEnv in development (NODE_ENV != production)', () => {
  let consoleSpy;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('warns but does not throw when NEXT_PUBLIC_API_URL is missing in development', () => {
    jest.resetModules();
    const savedApiUrl = process.env.NEXT_PUBLIC_API_URL;
    const savedNodeEnv = process.env.NODE_ENV;
    delete process.env.NEXT_PUBLIC_API_URL;
    process.env.NODE_ENV = 'development';

    try {
      const { validateEnv } = require('../envValidation');
      expect(() => validateEnv()).not.toThrow();
      expect(consoleSpy).toHaveBeenCalledWith(
        '[envValidation]',
        expect.stringContaining('NEXT_PUBLIC_API_URL')
      );
    } finally {
      if (savedApiUrl === undefined) {
        delete process.env.NEXT_PUBLIC_API_URL;
      } else {
        process.env.NEXT_PUBLIC_API_URL = savedApiUrl;
      }
      process.env.NODE_ENV = savedNodeEnv;
    }
  });

  it('warns but does not throw when NODE_ENV is not set and NEXT_PUBLIC_API_URL is missing', () => {
    jest.resetModules();
    const savedApiUrl = process.env.NEXT_PUBLIC_API_URL;
    const savedNodeEnv = process.env.NODE_ENV;
    delete process.env.NEXT_PUBLIC_API_URL;
    delete process.env.NODE_ENV;

    try {
      const { validateEnv } = require('../envValidation');
      expect(() => validateEnv()).not.toThrow();
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      if (savedApiUrl === undefined) {
        delete process.env.NEXT_PUBLIC_API_URL;
      } else {
        process.env.NEXT_PUBLIC_API_URL = savedApiUrl;
      }
      if (savedNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = savedNodeEnv;
      }
    }
  });

  it('warning message mentions the missing variable name, not its value', () => {
    jest.resetModules();
    const savedApiUrl = process.env.NEXT_PUBLIC_API_URL;
    const savedNodeEnv = process.env.NODE_ENV;
    delete process.env.NEXT_PUBLIC_API_URL;
    process.env.NODE_ENV = 'development';

    try {
      const { validateEnv } = require('../envValidation');
      validateEnv();
      const warnArgs = consoleSpy.mock.calls[0];
      expect(warnArgs.join(' ')).toContain('NEXT_PUBLIC_API_URL');
    } finally {
      if (savedApiUrl === undefined) {
        delete process.env.NEXT_PUBLIC_API_URL;
      } else {
        process.env.NEXT_PUBLIC_API_URL = savedApiUrl;
      }
      process.env.NODE_ENV = savedNodeEnv;
    }
  });

  it('does not warn when NEXT_PUBLIC_API_URL is present', () => {
    jest.resetModules();
    const savedNodeEnv = process.env.NODE_ENV;
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:5000/api';
    process.env.NODE_ENV = 'development';

    try {
      const { validateEnv } = require('../envValidation');
      validateEnv();
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = savedNodeEnv;
    }
  });
});

// ─── validateEnv — production ─────────────────────────────────────────────────

describe('envValidation — validateEnv in production (NODE_ENV = production)', () => {
  it('throws when NEXT_PUBLIC_API_URL is missing in production', () => {
    jest.resetModules();
    const savedApiUrl = process.env.NEXT_PUBLIC_API_URL;
    const savedNodeEnv = process.env.NODE_ENV;
    delete process.env.NEXT_PUBLIC_API_URL;
    process.env.NODE_ENV = 'production';

    try {
      const { validateEnv } = require('../envValidation');
      expect(() => validateEnv()).toThrow(/NEXT_PUBLIC_API_URL/);
    } finally {
      if (savedApiUrl === undefined) {
        delete process.env.NEXT_PUBLIC_API_URL;
      } else {
        process.env.NEXT_PUBLIC_API_URL = savedApiUrl;
      }
      process.env.NODE_ENV = savedNodeEnv;
    }
  });

  it('thrown error message mentions the missing var name', () => {
    jest.resetModules();
    const savedApiUrl = process.env.NEXT_PUBLIC_API_URL;
    const savedNodeEnv = process.env.NODE_ENV;
    delete process.env.NEXT_PUBLIC_API_URL;
    process.env.NODE_ENV = 'production';

    try {
      const { validateEnv } = require('../envValidation');
      expect(() => validateEnv()).toThrow(
        expect.objectContaining({ message: expect.stringContaining('NEXT_PUBLIC_API_URL') })
      );
    } finally {
      if (savedApiUrl === undefined) {
        delete process.env.NEXT_PUBLIC_API_URL;
      } else {
        process.env.NEXT_PUBLIC_API_URL = savedApiUrl;
      }
      process.env.NODE_ENV = savedNodeEnv;
    }
  });

  it('thrown error message includes guidance about .env.local', () => {
    jest.resetModules();
    const savedApiUrl = process.env.NEXT_PUBLIC_API_URL;
    const savedNodeEnv = process.env.NODE_ENV;
    delete process.env.NEXT_PUBLIC_API_URL;
    process.env.NODE_ENV = 'production';

    try {
      const { validateEnv } = require('../envValidation');
      expect(() => validateEnv()).toThrow(/.env.local/);
    } finally {
      if (savedApiUrl === undefined) {
        delete process.env.NEXT_PUBLIC_API_URL;
      } else {
        process.env.NEXT_PUBLIC_API_URL = savedApiUrl;
      }
      process.env.NODE_ENV = savedNodeEnv;
    }
  });

  it('does not throw when NEXT_PUBLIC_API_URL is set in production', () => {
    jest.resetModules();
    const savedNodeEnv = process.env.NODE_ENV;
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com/api';
    process.env.NODE_ENV = 'production';

    try {
      const { validateEnv } = require('../envValidation');
      expect(() => validateEnv()).not.toThrow();
    } finally {
      process.env.NODE_ENV = savedNodeEnv;
    }
  });
});

// ─── validateEnv — return value ───────────────────────────────────────────────

describe('envValidation — validateEnv return value', () => {
  it('returns correct values when all required vars are set', () => {
    jest.resetModules();
    const savedApiUrl = process.env.NEXT_PUBLIC_API_URL;
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com/api';

    try {
      const { validateEnv } = require('../envValidation');
      const result = validateEnv();
      expect(result.NEXT_PUBLIC_API_URL).toBe('https://api.example.com/api');
    } finally {
      if (savedApiUrl === undefined) {
        delete process.env.NEXT_PUBLIC_API_URL;
      } else {
        process.env.NEXT_PUBLIC_API_URL = savedApiUrl;
      }
    }
  });

  it('returns optional vars with their defaults when not explicitly set', () => {
    jest.resetModules();
    const savedApiUrl = process.env.NEXT_PUBLIC_API_URL;
    const savedTimeout = process.env.NEXT_PUBLIC_REQUEST_TIMEOUT_MS;
    const savedNetwork = process.env.NEXT_PUBLIC_STELLAR_NETWORK;

    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com/api';
    delete process.env.NEXT_PUBLIC_REQUEST_TIMEOUT_MS;
    delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;

    try {
      const { validateEnv } = require('../envValidation');
      const result = validateEnv();
      expect(result.NEXT_PUBLIC_REQUEST_TIMEOUT_MS).toBe('15000');
      expect(result.NEXT_PUBLIC_STELLAR_NETWORK).toBe('testnet');
    } finally {
      if (savedApiUrl === undefined) {
        delete process.env.NEXT_PUBLIC_API_URL;
      } else {
        process.env.NEXT_PUBLIC_API_URL = savedApiUrl;
      }
      if (savedTimeout === undefined) {
        delete process.env.NEXT_PUBLIC_REQUEST_TIMEOUT_MS;
      } else {
        process.env.NEXT_PUBLIC_REQUEST_TIMEOUT_MS = savedTimeout;
      }
      if (savedNetwork === undefined) {
        delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
      } else {
        process.env.NEXT_PUBLIC_STELLAR_NETWORK = savedNetwork;
      }
    }
  });

  it('returns optional vars with explicit values when they are set', () => {
    jest.resetModules();
    const savedApiUrl = process.env.NEXT_PUBLIC_API_URL;
    const savedTimeout = process.env.NEXT_PUBLIC_REQUEST_TIMEOUT_MS;
    const savedNetwork = process.env.NEXT_PUBLIC_STELLAR_NETWORK;

    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com/api';
    process.env.NEXT_PUBLIC_REQUEST_TIMEOUT_MS = '30000';
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = 'mainnet';

    try {
      const { validateEnv } = require('../envValidation');
      const result = validateEnv();
      expect(result.NEXT_PUBLIC_REQUEST_TIMEOUT_MS).toBe('30000');
      expect(result.NEXT_PUBLIC_STELLAR_NETWORK).toBe('mainnet');
    } finally {
      if (savedApiUrl === undefined) {
        delete process.env.NEXT_PUBLIC_API_URL;
      } else {
        process.env.NEXT_PUBLIC_API_URL = savedApiUrl;
      }
      if (savedTimeout === undefined) {
        delete process.env.NEXT_PUBLIC_REQUEST_TIMEOUT_MS;
      } else {
        process.env.NEXT_PUBLIC_REQUEST_TIMEOUT_MS = savedTimeout;
      }
      if (savedNetwork === undefined) {
        delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
      } else {
        process.env.NEXT_PUBLIC_STELLAR_NETWORK = savedNetwork;
      }
    }
  });

  it('return value includes both required and optional keys', () => {
    jest.resetModules();
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com/api';

    try {
      const { validateEnv } = require('../envValidation');
      const result = validateEnv();
      expect(result).toHaveProperty('NEXT_PUBLIC_API_URL');
      expect(result).toHaveProperty('NEXT_PUBLIC_REQUEST_TIMEOUT_MS');
      expect(result).toHaveProperty('NEXT_PUBLIC_STELLAR_NETWORK');
    } finally {
      // no cleanup needed for NEXT_PUBLIC_API_URL since we set it in parent scope
    }
  });
});

// ─── Module constants ─────────────────────────────────────────────────────────

describe('envValidation — exported constants', () => {
  it('REQUIRED_PUBLIC_VARS contains NEXT_PUBLIC_API_URL', () => {
    const { REQUIRED_PUBLIC_VARS } = loadModule();
    expect(REQUIRED_PUBLIC_VARS).toContain('NEXT_PUBLIC_API_URL');
  });

  it('OPTIONAL_PUBLIC_VARS contains NEXT_PUBLIC_REQUEST_TIMEOUT_MS with default 15000', () => {
    const { OPTIONAL_PUBLIC_VARS } = loadModule();
    expect(OPTIONAL_PUBLIC_VARS).toHaveProperty('NEXT_PUBLIC_REQUEST_TIMEOUT_MS', '15000');
  });

  it('OPTIONAL_PUBLIC_VARS contains NEXT_PUBLIC_STELLAR_NETWORK with default testnet', () => {
    const { OPTIONAL_PUBLIC_VARS } = loadModule();
    expect(OPTIONAL_PUBLIC_VARS).toHaveProperty('NEXT_PUBLIC_STELLAR_NETWORK', 'testnet');
  });

  it('isBrowser is false in Node.js (jest) environment', () => {
    const { isBrowser } = loadModule();
    // Jest runs in Node.js, window is not defined
    expect(isBrowser).toBe(false);
  });
});
