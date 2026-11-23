'use strict';

/**
 * Structured Logger Utility
 *
 * Provides consistent logging with levels, timestamps, and context.
 * Supports runtime log level changes via setLevel() — no server restart needed.
 *
 * File transports use DailyRotateFile (winston-daily-rotate-file):
 *   - logs/combined-%DATE%.log  — all levels
 *   - logs/error-%DATE%.log     — errors only
 * Rotation is controlled by LOG_MAX_SIZE (default: 100m) and
 * LOG_MAX_FILES (default: 14d) environment variables.
 */

const winston = require('winston');
require('winston-daily-rotate-file');
const { AsyncLocalStorage } = require('async_hooks');
const { redactLogValue } = require('./redactConfig');

const asyncLocalStorage = new AsyncLocalStorage();

const SERVICE = process.env.SERVICE_NAME || 'paymentflow-backend';
const ENVIRONMENT = process.env.NODE_ENV || 'development';
const LOG_SHIPPING_URL = process.env.LOG_SHIPPING_URL;

const _fileTransports = [
  new winston.transports.DailyRotateFile({
    filename:    'logs/combined-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize:     process.env.LOG_MAX_SIZE  || '100m',
    maxFiles:    process.env.LOG_MAX_FILES || '14d',
  }),
  new winston.transports.DailyRotateFile({
    filename:    'logs/error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    level:       'error',
    maxSize:     process.env.LOG_MAX_SIZE  || '100m',
    maxFiles:    process.env.LOG_MAX_FILES || '14d',
  }),
];

// Winston instance used solely for file rotation; console output is handled
// by the existing structured logger below so the log format stays unchanged.
const _winstonLogger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: _fileTransports,
});

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

const VALID_LEVELS = Object.keys(LOG_LEVELS);

// Mutable runtime level — starts from env var, can be changed via setLevel()
let _currentLevel = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
if (!VALID_LEVELS.includes(_currentLevel)) {
  _currentLevel = 'INFO';
}

/**
 * Set the log level at runtime. Takes effect immediately for all subsequent calls.
 * @param {string} level - One of 'debug' | 'info' | 'warn' | 'error' (case-insensitive)
 * @throws {Error} if level is invalid
 */
function setLevel(level) {
  const upper = (level || '').toUpperCase();
  if (!VALID_LEVELS.includes(upper)) {
    throw new Error(`Invalid log level "${level}". Must be one of: ${VALID_LEVELS.join(', ').toLowerCase()}`);
  }
  _currentLevel = upper;
}

/**
 * Get the current log level.
 * @returns {string} current level in lowercase
 */
function getLevel() {
  return _currentLevel.toLowerCase();
}

function shouldLog(level) {
  return LOG_LEVELS[level] <= LOG_LEVELS[_currentLevel];
}

function formatMessage(level, message, ...args) {
  const timestamp = new Date().toISOString();
  const formattedArgs = args.map(arg => {
    if (arg instanceof Error) {
      return { message: arg.message, stack: arg.stack, ...arg };
    }
    return arg;
  });

  const store = asyncLocalStorage.getStore();
  const correlationId = store?.correlationId || store?.requestId;

  return redactLogValue({
    timestamp,
    severity: level.toLowerCase(),
    service: SERVICE,
    environment: ENVIRONMENT,
    message,
    ...(correlationId ? { correlationId, requestId: correlationId } : {}),
    context: formattedArgs.length > 0 ? Object.assign({}, ...formattedArgs.filter((arg) => arg && typeof arg === 'object' && !Array.isArray(arg))) : undefined,
    args: formattedArgs.length > 0 ? formattedArgs : undefined,
    pid: process.pid,
  });
}

function ship(entry) {
  if (!LOG_SHIPPING_URL || typeof fetch !== 'function') return;
  void fetch(LOG_SHIPPING_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(entry),
    signal: AbortSignal.timeout(Number(process.env.LOG_SHIPPING_TIMEOUT_MS || 1000)),
  }).catch(() => {
    // Shipping is best effort. The local stdout/file transports remain authoritative.
  });
}

const logger = {
  error(message, ...args) {
    if (shouldLog('ERROR')) {
      const entry = formatMessage('ERROR', message, ...args);
      console.error(JSON.stringify(entry));
      _winstonLogger.error(message, entry);
      ship(entry);
    }
  },

  warn(message, ...args) {
    if (shouldLog('WARN')) {
      const entry = formatMessage('WARN', message, ...args);
      console.warn(JSON.stringify(entry));
      _winstonLogger.warn(message, entry);
      ship(entry);
    }
  },

  info(message, ...args) {
    if (shouldLog('INFO')) {
      const entry = formatMessage('INFO', message, ...args);
      console.log(JSON.stringify(entry));
      _winstonLogger.info(message, entry);
      ship(entry);
    }
  },

  debug(message, ...args) {
    if (shouldLog('DEBUG')) {
      const entry = formatMessage('DEBUG', message, ...args);
      console.log(JSON.stringify(entry));
      _winstonLogger.debug(message, entry);
      ship(entry);
    }
  },

  /**
   * Create a child logger with additional context prefix.
   */
  child(context) {
    return {
      error: (message, ...args) => logger.error(`[${context}] ${message}`, ...args),
      warn:  (message, ...args) => logger.warn(`[${context}] ${message}`, ...args),
      info:  (message, ...args) => logger.info(`[${context}] ${message}`, ...args),
      debug: (message, ...args) => logger.debug(`[${context}] ${message}`, ...args),
    };
  },

  setLevel,
  getLevel,
  asyncLocalStorage,
};

const { redactConfig, SENSITIVE_KEYS } = require('./redactConfig');

module.exports = logger;
module.exports.logger = logger;
module.exports.setLevel = setLevel;
module.exports.getLevel = getLevel;
module.exports.asyncLocalStorage = asyncLocalStorage;
module.exports.redactConfig = redactConfig;
module.exports.SENSITIVE_KEYS = SENSITIVE_KEYS;
