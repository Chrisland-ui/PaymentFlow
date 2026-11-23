  cursor: Joi.string().min(1).max(2048).optional(),
'use strict';

/**
 * Request limit schemas — Issue #41
 *
 * Centralises endpoint-specific body, array, string, pagination, and filter
 * limits so every validation error names the bounded field and is enforced
 * before any expensive DB or Stellar call begins.
 */

const Joi = require('joi');
const { decimalAmountJoi } = require('../../utils/decimalPrecision');

// ── Pagination ────────────────────────────────────────────────────────────────

/** Standard paginated list: page ≥ 1, limit 1–200 (default 50). */
const paginationSchema = Joi.object({
  page:  Joi.number().integer().min(1).max(10000).default(1)
    .messages({
      'number.base':    '"page" must be a number',
      'number.integer': '"page" must be an integer',
      'number.min':     '"page" must be at least 1',
      'number.max':     '"page" must not exceed 10000',
    }),
  limit: Joi.number().integer().min(1).max(200).default(50)
    .messages({
      'number.base':    '"limit" must be a number',
      'number.integer': '"limit" must be an integer',
      'number.min':     '"limit" must be at least 1',
      'number.max':     '"limit" must not exceed 200',
    }),
}).unknown(true);   // allow other query params through

/** Export endpoints allow up to 10 000 rows. */
const exportPaginationSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(10000).default(10000)
    .messages({
      'number.max': '"limit" must not exceed 10000 for exports',
    }),
}).unknown(true);

// ── Audit log query filters ───────────────────────────────────────────────────

const MAX_FILTER_STRING = 200;

const auditQuerySchema = Joi.object({
  action:      Joi.string().max(MAX_FILTER_STRING).optional()
    .messages({ 'string.max': `"action" must not exceed ${MAX_FILTER_STRING} characters` }),
  targetType:  Joi.string().max(MAX_FILTER_STRING).optional()
    .messages({ 'string.max': `"targetType" must not exceed ${MAX_FILTER_STRING} characters` }),
  performedBy: Joi.string().max(MAX_FILTER_STRING).optional()
    .messages({ 'string.max': `"performedBy" must not exceed ${MAX_FILTER_STRING} characters` }),
  result:      Joi.string().valid('success', 'failure').optional()
    .messages({ 'any.only': '"result" must be "success" or "failure"' }),
  search:      Joi.string().max(MAX_FILTER_STRING).optional()
    .messages({ 'string.max': `"search" must not exceed ${MAX_FILTER_STRING} characters` }),
  startDate:   Joi.string().isoDate().optional()
    .messages({ 'string.isoDate': '"startDate" must be a valid ISO 8601 date' }),
  endDate:     Joi.string().isoDate().optional()
    .messages({ 'string.isoDate': '"endDate" must be a valid ISO 8601 date' }),
  cursor:      Joi.string().min(1).max(2048).optional()
    .messages({ 'string.max': '"cursor" must not exceed 2048 characters' }),
  page:        Joi.number().integer().min(1).max(10000).default(1),
  limit:       Joi.number().integer().min(1).max(200).default(50),
}).unknown(false)
  .messages({ 'object.unknown': 'Unknown query parameter: "{{#label}}"' });

// ── Student body ──────────────────────────────────────────────────────────────

const updateStudentSchema = Joi.object({
  name:         Joi.string().trim().min(1).max(200).optional()
    .messages({
      'string.max':   '"name" must not exceed 200 characters',
      'string.empty': '"name" must not be empty',
    }),
  class:        Joi.string().trim().min(1).max(100).optional()
    .messages({ 'string.max': '"class" must not exceed 100 characters' }),
  feeAmount:    decimalAmountJoi({ minValue: 0.01 }).optional()
    .messages({ 'any.invalid': '"feeAmount" must be a positive amount with at most 2 decimal places' }),
  graduatedAt:  Joi.date().iso().optional().allow(null),
  parentEmail:  Joi.string().email().max(254).optional().allow(null, '')
    .messages({ 'string.max': '"parentEmail" must not exceed 254 characters' }),
  parentPhone:  Joi.string().max(30).optional().allow(null, '')
    .messages({ 'string.max': '"parentPhone" must not exceed 30 characters' }),
  academicYear: Joi.string().max(20).optional().allow(null, '')
    .messages({ 'string.max': '"academicYear" must not exceed 20 characters' }),
  gender:       Joi.string().max(20).optional().allow(null, '')
    .messages({ 'string.max': '"gender" must not exceed 20 characters' }),
  parentName:   Joi.string().max(200).optional().allow(null, '')
    .messages({ 'string.max': '"parentName" must not exceed 200 characters' }),
  contactNumber:Joi.string().max(30).optional().allow(null, '')
    .messages({ 'string.max': '"contactNumber" must not exceed 30 characters' }),
}).unknown(false)
  .messages({ 'object.unknown': '"{{#label}}" is not an allowed field' });

const registerStudentSchema = Joi.object({
  studentId:    Joi.string().trim().max(28).optional(),
  name:         Joi.string().trim().min(1).max(200).required(),
  class:        Joi.string().trim().min(1).max(100).required(),
  feeAmount:    decimalAmountJoi({ minValue: 0.01 }).optional(),
  parentEmail:  Joi.string().email().max(254).optional().allow('', null),
  parentPhone:  Joi.string().max(30).optional().allow('', null),
}).unknown(false);

// ── Dispute body ──────────────────────────────────────────────────────────────

const createDisputeSchema = Joi.object({
  studentId:   Joi.string().max(28).required()
    .messages({
      'any.required': '"studentId" is required',
      'string.max':   '"studentId" must not exceed 28 characters',
    }),
  txHash:      Joi.string().pattern(/^[a-f0-9]{64}$/).required()
    .messages({
      'any.required':          '"txHash" is required',
      'string.pattern.base':   '"txHash" must be a valid 64-character hex string',
    }),
  reason:      Joi.string().trim().min(1).max(2000).required()
    .messages({
      'any.required': '"reason" is required',
      'string.max':   '"reason" must not exceed 2000 characters',
      'string.empty': '"reason" must not be empty',
    }),
  evidence:    Joi.array().max(20).items(
    Joi.object({
      type:        Joi.string().max(100).required(),
      description: Joi.string().max(1000).required(),
      url:         Joi.string().uri().max(2048).optional(),
    })
  ).optional()
    .messages({ 'array.max': '"evidence" must not contain more than 20 items' }),
}).unknown(false);

// ── Fee adjustment body ───────────────────────────────────────────────────────

const createFeeAdjustmentSchema = Joi.object({
  name:        Joi.string().trim().min(1).max(200).required()
    .messages({
      'any.required': '"name" is required',
      'string.max':   '"name" must not exceed 200 characters',
    }),
  description: Joi.string().max(1000).optional().allow('', null)
    .messages({ 'string.max': '"description" must not exceed 1000 characters' }),
  type:        Joi.string().valid('percentage', 'fixed', 'waiver').required()
    .messages({ 'any.only': '"type" must be one of: percentage, fixed, waiver' }),
  value:       Joi.number().required()
    .messages({ 'any.required': '"value" is required' }),
  conditions:  Joi.object().optional(),
  className:   Joi.string().max(100).optional().allow('', null)
    .messages({ 'string.max': '"className" must not exceed 100 characters' }),
  priority:    Joi.number().integer().min(0).max(9999).optional()
    .messages({ 'number.max': '"priority" must not exceed 9999' }),
}).unknown(false);

// ── Webhook endpoint body ─────────────────────────────────────────────────────

const createWebhookEndpointSchema = Joi.object({
  url:         Joi.string().uri().max(2048).required()
    .messages({
      'any.required': '"url" is required',
      'string.max':   '"url" must not exceed 2048 characters',
      'string.uri':   '"url" must be a valid URI',
    }),
  description: Joi.string().max(500).optional().allow('', null)
    .messages({ 'string.max': '"description" must not exceed 500 characters' }),
  events:      Joi.array().max(50).items(Joi.string().max(100)).optional()
    .messages({ 'array.max': '"events" must not contain more than 50 items' }),
  secret:      Joi.string().max(256).optional().allow('', null)
    .messages({ 'string.max': '"secret" must not exceed 256 characters' }),
  isActive:    Joi.boolean().optional(),
}).unknown(false);

// ── School body ───────────────────────────────────────────────────────────────

const createSchoolSchema = Joi.object({
  name:              Joi.string().trim().min(1).max(200).required()
    .messages({ 'string.max': '"name" must not exceed 200 characters' }),
  slug:              Joi.string().max(100).optional()
    .messages({ 'string.max': '"slug" must not exceed 100 characters' }),
  walletAddress:     Joi.string().max(64).optional()
    .messages({ 'string.max': '"walletAddress" must not exceed 64 characters' }),
  currency:          Joi.string().max(10).optional()
    .messages({ 'string.max': '"currency" must not exceed 10 characters' }),
  timezone:          Joi.string().max(100).optional()
    .messages({ 'string.max': '"timezone" must not exceed 100 characters' }),
  contactEmail:      Joi.string().email().max(254).optional().allow('', null)
    .messages({ 'string.max': '"contactEmail" must not exceed 254 characters' }),
  maxStudents:       Joi.number().integer().min(1).max(1000000).optional()
    .messages({ 'number.max': '"maxStudents" must not exceed 1000000' }),
}).unknown(true);  // schools may carry extra fields

const updateSchoolSchema = createSchoolSchema.fork(
  ['name'],
  (s) => s.optional(),
);

// ── Bulk arrays ───────────────────────────────────────────────────────────────

/** Generic body with an items/students array capped at 100. */
const MAX_BULK_ITEMS = 100;

const bulkArraySchema = Joi.object({
  students: Joi.array().max(MAX_BULK_ITEMS).optional()
    .messages({ 'array.max': `"students" must not contain more than ${MAX_BULK_ITEMS} items` }),
  items: Joi.array().max(MAX_BULK_ITEMS).optional()
    .messages({ 'array.max': `"items" must not contain more than ${MAX_BULK_ITEMS} items` }),
}).unknown(true);

module.exports = {
  paginationSchema,
  exportPaginationSchema,
  auditQuerySchema,
  registerStudentSchema,
  updateStudentSchema,
  createDisputeSchema,
  createFeeAdjustmentSchema,
  createWebhookEndpointSchema,
  createSchoolSchema,
  updateSchoolSchema,
  bulkArraySchema,
  // Constants exported for documentation/testing
  MAX_FILTER_STRING,
  MAX_BULK_ITEMS,
};
