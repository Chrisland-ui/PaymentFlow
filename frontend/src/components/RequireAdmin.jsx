import { useEffect } from "react";
import { useRouter } from "next/router";
import { useAdminAuthContext } from "../hooks/AdminAuthContext";
import { useTranslation } from "react-i18next";

/**
 * RequireAdmin
 *
 * A centralized route-guard component that blocks all child rendering until
 * the authentication check resolves, then redirects unauthenticated or
 * under-privileged users appropriately.
 *
 * Behavior (Issue #357):
 *  - If the user has no session at all (not logged in): redirect to /login
 *    with a returnTo param so they can come back after authenticating.
 *  - If the user IS logged in but does NOT have admin role: redirect to /403
 *    so they see a clear "Access Denied" page with a "Request access" option,
 *    rather than being silently pushed to the login page.
 *
 * Usage — wrap any admin page's exported component:
 *
 *   export default function MyAdminPage() { ... }
 *   <RequireAdmin><MyAdminPage /></RequireAdmin>
 *
 * @param {{ children: React.ReactNode }} props
 */
export default function RequireAdmin({ children }) {
  const router = useRouter();
  const { isAdmin, checked, userId } = useAdminAuthContext();
  const { t } = useTranslation();

  useEffect(() => {
    // Only act once the /auth/me round-trip has completed.
    if (!checked) return;
    if (isAdmin) return;

    if (userId) {
      // User is authenticated but lacks admin role — show 403 with request-access CTA.
      router.replace(`/403?from=${encodeURIComponent(router.asPath)}`);
    } else {
      // No active session at all — redirect to login.
      router.replace(`/login?returnTo=${encodeURIComponent(router.asPath)}`);
    }
  }, [checked, isAdmin, userId, router]);

  // Block all child rendering until the auth state is resolved AND confirmed.
  if (!checked || !isAdmin) {
    return (
      <div
        className="app-auth-gate"
        role="status"
        aria-live="polite"
        data-testid="require-admin-gate"
      >
        {checked ? t("auth.redirecting") : t("auth.checking")}
      </div>
    );
  }

  return children;
}
