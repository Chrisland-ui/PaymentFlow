'use strict';

/**
 * assertTenantScope — middleware that enforces cross-tenant isolation at the
 * resource level.
 *
 * After `requireSchoolAuth` has verified the JWT and set `req.schoolId` from
 * the token, this middleware double-checks that the school the user is acting
 * on (from URL params or query) matches their token's school claim.
 *
 * This is a defence-in-depth layer: `requireSchoolAuth` already rejects tokens
 * whose `schoolId` doesn't match `X-School-ID`, but some endpoints accept the
 * school ID via URL param (e.g. `/api/schools/:schoolId/...`) where a
 * misconfigured client could send a different value than the header.
 *
 * Super-admin bypass:
 *   Tokens with `role: 'admin'` or `roles: ['super_admin']` are cross-school
 *   by design (break-glass access) and are always allowed through.
 *
 * Lookup order for the "requested" school ID:
 *   1. `req.params.schoolId`
 *   2. `req.params.id`  (when the resource IS a school, e.g. PUT /api/schools/:id)
 *   3. `req.body.schoolId`
 *   4. `req.query.schoolId`
 *   5. `req.headers['x-school-id']`
 *   If none of the above are present the middleware passes (no school context
 *   to check against).
 *
 * Usage:
 *   const { assertTenantScope } = require('../middleware/tenantIsolation');
 *
 *   router.get('/students',
 *     requireSchoolAuth(),
 *     assertTenantScope,
 *     studentController.list
 *   );
 *
 * @type {import('express').RequestHandler}
 */
function assertTenantScope(req, res, next) {
  const user = req.user;

  if (!user) {
    return res.status(500).json({
      error: 'Server configuration error: auth middleware must run before assertTenantScope.',
      code: 'AUTH_MIDDLEWARE_MISSING',
    });
  }

  // Super-admin bypass — break-glass cross-school access is always permitted
  const isSuperAdmin =
    user.role === 'admin' ||
    (Array.isArray(user.roles) && user.roles.includes('super_admin'));

  if (isSuperAdmin) {
    return next();
  }

  // Determine the school being acted on
  const requestedSchoolId =
    req.params.schoolId ||
    req.params.id ||          // for /api/schools/:id routes
    req.body?.schoolId ||
    req.query?.schoolId ||
    req.headers['x-school-id'] ||
    null;

  // If no school context is present in the request, nothing to assert
  if (!requestedSchoolId) {
    return next();
  }

  // req.schoolId is set by requireSchoolAuth from the JWT claim
  const tokenSchoolId = req.schoolId || user.schoolId;

  if (tokenSchoolId && tokenSchoolId !== requestedSchoolId) {
    return res.status(403).json({
      error: 'Forbidden. Cross-tenant access denied.',
      code: 'TENANT_ISOLATION_VIOLATION',
    });
  }

  return next();
}

module.exports = { assertTenantScope };
