'use strict';

const express = require('express');
const router = express.Router();
const { getAuditLogsEndpoint, getRecentAuditLogsEndpoint, verifyChainEndpoint, exportAuditLogsEndpoint } = require('../controllers/auditController');
const { resolveSchool } = require('../middleware/schoolContext');
const { requireAdminAuth } = require('../middleware/auth');
const { validateAuditQuery, validatePagination, validateExportPagination } = require('../middleware/validate');

router.use(resolveSchool);
router.use(requireAdminAuth);

router.get('/',              validateAuditQuery, getAuditLogsEndpoint);
router.get('/recent',        validatePagination, getRecentAuditLogsEndpoint);
// #1370 — CSV / JSON export for compliance and handover use-cases
router.get('/export',        validateExportPagination, exportAuditLogsEndpoint);
// #885 — verify hash-chain integrity
router.get('/verify-chain',  verifyChainEndpoint);

module.exports = router;
