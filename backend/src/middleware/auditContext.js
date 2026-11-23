'use strict';

const { logAudit } = require('../services/auditService');

function inferTargetType(req) {
  const path = `${req.baseUrl || ''}${req.path || ''}`.toLowerCase();
  if (path.includes('student')) return 'student';
  if (path.includes('payment') || path.includes('refund')) return 'payment';
  if (path.includes('fee')) return 'fee';
  if (path.includes('school')) return 'school';
  return 'privileged_resource';
}

function inferTargetId(req) {
  return req.params?.studentId || req.params?.txHash || req.params?.schoolId ||
    req.params?.id || req.params?.key || req.params?.jobId ||
    req.body?.schoolId || `${req.method} ${req.baseUrl || ''}${req.path || ''}`;
}

/**
 * auditContext — middleware that captures audit-relevant information from the request.
 *
 * Attaches req.auditContext with:
 *   - performedBy: admin user identifier from JWT
 *   - ipAddress: client IP
 *   - userAgent: client user agent
 *
 * Should be applied after requireAdminAuth middleware.
 */
function auditContext(req, res, next) {
  req.auditContext = {
    performedBy: req.admin?.email || req.admin?.userId || 'unknown',
    ipAddress: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
    userAgent: req.headers['user-agent'] || null,
  };

  let responseMessage = null;
  let responseBody = null;
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    responseBody = body;
    responseMessage = body?.error || body?.message || null;
    return originalJson(body);
  };

  res.once('finish', () => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
    const schoolId = req.schoolId || req.params?.schoolId || req.body?.schoolId || 'system';
    const targetId = inferTargetId(req);
    const succeeded = res.statusCode < 400;
    logAudit({
      schoolId,
      action: `privileged_${req.method.toLowerCase()}`,
      performedBy: req.auditContext.performedBy,
      targetId,
      targetType: inferTargetType(req),
      before: req.auditContext.before || null,
      after: succeeded ? responseBody || { statusCode: res.statusCode } : null,
      details: { method: req.method, path: req.baseUrl + req.path, statusCode: res.statusCode },
      result: succeeded ? 'success' : 'failure',
      errorMessage: succeeded ? null : responseMessage || `Request failed with HTTP ${res.statusCode}`,
      ipAddress: req.auditContext.ipAddress,
      userAgent: req.auditContext.userAgent,
    });
  });

  next();
}

module.exports = { auditContext };
