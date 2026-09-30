import { GitHubIntegrationCard } from "@/components/GitHubIntegrationCard";
import { useCompany } from "@/context/CompanyContext";

/**
 * Settings → Operations → GitHub.
 *
 * The GitHub connection surface as a flat panel: the section header carries the
 * title + description, and {@link GitHubIntegrationCard} renders the App / PAT
 * controls directly beneath it (no nested card chrome, no duplicate header).
 */
export function GitHubSection() {
  // Key the card by company so switching companies while sitting on this section
  // remounts it — otherwise a half-typed PAT (and inline error) typed for company
  // A would survive the switch and could be saved to company B. Sibling sections
  // (Providers, Inbox) already key by selectedCompanyId.
  const { selectedCompanyId } = useCompany();
  return (
    <div>
      <div className="px-8 pt-6 pb-3 border-b border-border">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
          Settings · Operations
        </div>
        <h2 className="text-[1.4rem] font-bold tracking-tight mt-1">
          GitHub<span className="text-brand">.</span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect GitHub for pull-request creation, review sync, and agent repository access.
        </p>
      </div>
      <div className="p-8 max-w-[680px]">
        <GitHubIntegrationCard key={selectedCompanyId ?? "none"} />
      </div>
    </div>
  );
}
