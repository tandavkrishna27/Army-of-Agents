import { SecretsWorkspace } from "@/components/secrets/SecretsWorkspace";
import { useCompany } from "@/context/CompanyContext";

export function SecretsSectionWrapper() {
  const { selectedCompanyId } = useCompany();

  if (!selectedCompanyId) {
    return (
      <section className="p-8">
        <p className="text-sm text-muted-foreground">Select a company to manage secrets.</p>
      </section>
    );
  }

  return <SecretsWorkspace companyId={selectedCompanyId} />;
}
