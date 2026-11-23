import { useRouter } from "next/router";
import { useAdminAuthContext } from "./AdminAuthContext";

export function useFeatureFlag(flagName) {
  const router = useRouter();
  const { isAdmin, schoolId, features } = useAdminAuthContext();

  if (typeof flagName !== "string" || !flagName.trim()) return false;

  if (process.env.NODE_ENV === "development" && router.isReady) {
    const override = router.query[`flag_${flagName}`];
    const value = Array.isArray(override) ? override[0] : override;
    if (value === "true") return true;
    if (value === "false") return false;
  }

  return Boolean(isAdmin && schoolId && features && features[flagName] === true);
}