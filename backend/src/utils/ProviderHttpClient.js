'use strict';

/**
 * ProviderHttpClient Base Class (Issue #290)
 *
 * Central base class that external provider clients extend to ensure uniform
 * timeout, retry, backoff, and circuit-breaker enforcement via providerPolicyRegistry.
 */

const axios = require('axios');
const { getPolicy, executeWithPolicy } = require('../config/providerPolicyRegistry');
const logger = require('./logger');

class ProviderHttpClient {
  /**
   * @param {string} providerName - Identifier for the provider (e.g. 'stellar', 'coingecko', 'twilio')
   * @param {object} [options]
   * @param {string} [options.baseURL]
   * @param {object} [options.headers]
   */
  constructor(providerName, options = {}) {
    if (!providerName) {
      throw new Error('ProviderHttpClient requires a valid providerName');
    }
    this.providerName = providerName;
    this.baseURL = options.baseURL || '';
    this.defaultHeaders = options.headers || {};
    this.logger = logger.child(`ProviderClient:${providerName}`);
    this.axios = axios.create({
      baseURL: this.baseURL,
      headers: this.defaultHeaders,
    });
  }

  /**
   * Get effective policy for an operation.
   * @param {string} operation
   * @returns {object}
   */
  getOperationPolicy(operation) {
    return getPolicy(this.providerName, operation);
  }

  /**
   * Execute an operation under the provider policy.
   * @param {string} operation
   * @param {Function} requestFn
   * @param {object} [opts]
   * @returns {Promise<any>}
   */
  async execute(operation, requestFn, opts = {}) {
    return executeWithPolicy(this.providerName, operation, requestFn, opts);
  }

  /**
   * Helper for GET requests executed under policy.
   */
  async get(url, config = {}, operation = 'get') {
    const policy = this.getOperationPolicy(operation);
    return this.execute(operation, async () => {
      const resp = await this.axios.get(url, {
        ...config,
        timeout: policy.timeoutMs,
      });
      return resp.data;
    });
  }

  /**
   * Helper for POST requests executed under policy.
   */
  async post(url, data, config = {}, operation = 'post') {
    const policy = this.getOperationPolicy(operation);
    return this.execute(operation, async () => {
      const resp = await this.axios.post(url, data, {
        ...config,
        timeout: policy.timeoutMs,
      });
      return resp.data;
    });
  }
}

module.exports = ProviderHttpClient;
