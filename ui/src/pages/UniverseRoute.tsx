import { useEffect } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useCompany } from "../context/CompanyContext";
import { AccessRequired } from "./AccessRequired";
import { Universe } from "./Universe";
import { AgentPanelProvider } from "../context/AgentPanelContext";

/** Standalone company boundary, deliberately outside the board Layout. */
export function UniverseRoute() {
  const { companyPrefix } = useParams<{ companyPrefix: string }>();
  const { companies, loading, error, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const location = useLocation();
  const navigate = useNavigate();
  const company = companies.find((candidate) => candidate.issuePrefix.toUpperCase() === companyPrefix?.toUpperCase());

  useEffect(() => {
    if (loading || error || !company) return;
    if (selectedCompanyId !== company.id) {
      setSelectedCompanyId(company.id, { source: "route_sync" });
    }
    if (companyPrefix !== company.issuePrefix) {
      navigate(`/${company.issuePrefix}/universe${location.search}${location.hash}`, { replace: true });
    }
  }, [loading, error, company, companyPrefix, selectedCompanyId, setSelectedCompanyId, navigate, location.search, location.hash]);

  if (loading) return <div role="status">Loading company…</div>;
  if (error) return <div role="alert">Unable to load your companies. Please reload to try again.</div>;
  if (!company) return <AccessRequired requestedPrefix={companyPrefix} />;
  if (selectedCompanyId !== company.id) return <div role="status">Opening Universe…</div>;
  return <AgentPanelProvider key={company.id}><Universe /></AgentPanelProvider>;
}
