/**
 * envValidation.js
 *
 * Validates required public environment variables at module load time.
 * A missing NEXT_PUBLIC_API_URL will throw in production or warn in development.
 *
 * Uses CommonJS exports so it can be require()-d from next.config.js.
 * Also exports named ES module-style via module.exports for compatibility.
 *
 * Never logs variable values — only names appear in error/warning messages.
 */

/** Variables that must be set for the app to function */
const REQUIRED_PUBLIC_VARS = ['NEXT_PUBLIC_API_URL'];

/** Variables with safe defaults */
const OPTIONAL_PUBLIC_VARS = {
  NEXT_PUBLIC_REQUEST_TIMEOUT_MS: '15000',
  NEXT_PUBLIC_STELLAR_NETWORK: 'testnet',
};

/**
 * Returns the value of a public env var, or the provided fallback.
 * Never logs the value — only the key name in error messages.
 * @param {string} name
 * @param {string} [fallback='']
 * @returns {string}
 */
function getEnvVar(name, fallback = '') {
  const val = typeof process !== 'undefined' ? process.env[name] : undefined;
  return (val !== undefined && val !== '') ? val : fallback;
}

/**
 * Validates required public environment variables.
 * In production: throws an Error listing missing variables.
 * In development: logs a warning but continues.
 * @returns {{ [key: string]: string }} validated env vars snapshot
 * @throws {Error} in production when required vars are missing
 */
function validateEnv() {
  const missing = REQUIRED_PUBLIC_VARS.filter((name) => !getEnvVar(name));

  if (missing.length > 0) {
    const msg = `Missing required environment variables: ${missing.join(', ')}. Check your .env.local file.`;
    const isProd = typeof process !== 'undefined' && process.env.NODE_ENV === 'production';
    if (isProd) {
      throw new Error(msg);
    } else {
      if (typeof console !== 'undefined') console.warn('[envValidation]', msg);
    }
  }

  return {
    ...Object.fromEntries(REQUIRED_PUBLIC_VARS.map((name) => [name, getEnvVar(name)])),
    ...Object.fromEntries(Object.entries(OPTIONAL_PUBLIC_VARS).map(([name, def]) => [name, getEnvVar(name, def)])),
  };
}

/** True when running in a browser context */
const isBrowser = typeof window !== 'undefined';

module.exports = { REQUIRED_PUBLIC_VARS, OPTIONAL_PUBLIC_VARS, getEnvVar, validateEnv, isBrowser };
