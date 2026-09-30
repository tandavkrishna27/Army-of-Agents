import { Navigate } from "react-router-dom";
import { useCompany } from "@/context/CompanyContext";
import { AOA_DEFAULT_CREW_ROSTER_PATH } from "@/lib/marketplace-constants";

/**
 * Resolve the legacy Default Crew marketplace URL only after CompanyContext has
 * finished both fetching companies and applying its persisted/default
 * selection. Redirecting while `selectedCompany` is still null would emit the
 * unprefixed `/team` path, which has no global route.
 */
export function DefaultCrewRosterRedirect() {
  const { companies, selectedCompany, loading, error } = useCompany();

  if (loading || (companies.length > 0 && !selectedCompany)) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        Failed to load companies: {error.message}
      </div>
    );
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    return <Navigate to="/onboarding" replace />;
  }

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}${AOA_DEFAULT_CREW_ROSTER_PATH}`}
      replace
    />
  );
}
