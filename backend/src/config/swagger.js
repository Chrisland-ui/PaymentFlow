'use strict';

/**
 * OpenAPI 3.0 specification for StellarEduPay API
 * Issue #671: Serves at GET /api/docs.json
 */

const swaggerJsdoc = require('swagger-jsdoc');
const { TAXONOMY } = require('../errors/paymentErrorTaxonomy');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'StellarEduPay API',
      version: '1.0.0',
      description: 'Decentralized school fee payment system built on Stellar blockchain',
      contact: {
        name: 'StellarEduPay Support',
        url: 'https://github.com/manuelusman73-png/StellarEduPay',
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT',
      },
    },
    'x-error-codes': TAXONOMY,
    servers: [
      {
        url: process.env.API_URL || 'http://localhost:5000/api',
        description: 'API Server',
      },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT token for admin authentication',
        },
      },
      schemas: {
        Payment: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            schoolId: { type: 'string' },
            studentId: { type: 'string' },
            txHash: { type: 'string' },
            amount: { type: 'number' },
            feeAmount: { type: 'number' },
            status: { type: 'string', enum: ['PENDING', 'SUBMITTED', 'SUCCESS', 'FAILED', 'DISPUTED', 'INVALID'] },
            confirmedAt: { type: 'string', format: 'date-time' },
            feeValidationStatus: { type: 'string', enum: ['valid', 'underpaid', 'overpaid', 'partial', 'unknown'] },
          },
        },
        Student: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            schoolId: { type: 'string' },
            studentId: { type: 'string' },
            name: { type: 'string' },
            class: { type: 'string' },
            feeAmount: { type: 'number' },
            contactEmail: { type: 'string', format: 'email' },
          },
        },
        School: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            schoolId: { type: 'string' },
            name: { type: 'string' },
            slug: { type: 'string' },
            stellarAddress: { type: 'string' },
            network: { type: 'string', enum: ['testnet', 'mainnet'] },
            isActive: { type: 'boolean' },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            code: { type: 'string' },
          },
        },
      },
    },
    security: [
      {
        BearerAuth: [],
      },
    ],
  },
  apis: [
    './backend/src/routes/*.js',
    './backend/src/controllers/*.js',
  ],
};

const specs = swaggerJsdoc(options);

module.exports = specs;
