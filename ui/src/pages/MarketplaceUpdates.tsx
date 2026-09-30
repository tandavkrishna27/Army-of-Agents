import { Navigate, useParams } from "react-router-dom";

export default function MarketplaceUpdates() {
  const { companyPrefix } = useParams();
  const target = companyPrefix
    ? `/${companyPrefix}/settings?tab=marketplace&section=updates`
    : "/settings?tab=marketplace&section=updates";
  return <Navigate to={target} replace />;
}
