'use strict';

/**
 * requireRole — explicit role-based access control middleware.
 *
 * Used AFTER an auth middleware (requireAdminAuth or requireSchoolAuth) has
 * populated `req.user`.  Checks that the authenticated user holds at least one
 * of the specified roles before allowing the request to proceed.
 *
 * Super-admin bypass:
 *   A token with `role: 'admin'` (legacy env super-admin) or
 *   `roles: ['super_admin']` (DB super-admin) always passes regardless of the
 *   required-roles list.  This preserves the break-glass access semantics
 *   established by requireAdminAuth / requireSchoolAuth.
 *
 * Usage:
 *   const { requireRole } = require('../middleware/requireRole');
 *
 *   // Only 'owner' or 'finance' may generate reports:
 *   router.get('/reports', requireSchoolAuth(), requireRole('owner', 'finance'), handler);
 *
 *   // Only 'super_admin' may delete school limits:
 *   router.delete('/payment-limits/:id', requireAdminAuth, requireRole('super_admin'), handler);
 *
 * @param {...string} roles  One or more allowed role strings.
 * @returns {import('express').RequestHandler}
 */
function requireRole(...roles) {
  if (roles.length === 0) {
    throw new Error('[requireRole] At least one role must be specified');
  }

  return function requireRoleMiddleware(req, res, next) {
    const user = req.user;

    if (!user) {
      // Auth middleware did not run or did not set req.user — configuration error
      return res.status(500).json({
        error: 'Server configuration error: auth middleware must run before requireRole.',
        code: 'AUTH_MIDDLEWARE_MISSING',
      });
    }

    // Super-admin bypass — break-glass access regardless of required roles
    const isSuperAdmin =
      user.role === 'admin' ||
      (Array.isArray(user.roles) && user.roles.includes('super_admin'));

    if (isSuperAdmin) {
      return next();
    }

    // Check if the user holds any of the required roles
    const userRoles = Array.isArray(user.roles) ? user.roles : (user.role ? [user.role] : []);
    const hasRequiredRole = roles.some((r) => userRoles.includes(r));

    if (!hasRequiredRole) {
      return res.status(403).json({
        error: `Forbidden. Required role: ${roles.join(' or ')}.`,
        code: 'INSUFFICIENT_ROLE',
      });
    }

    return next();
  };
}

module.exports = { requireRole };
