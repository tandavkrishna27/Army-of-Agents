import { type CSSProperties } from "react";
import type { PendingInvitation } from "@armyofagents/shared";
import { useNavigate } from "@/lib/router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { profileApi } from "@/api/profile";
import { companiesApi, type CompanyStats } from "@/api/companies";
import { getOnboardingProgress } from "@/api/onboarding";
import {
  isConfirmedPendingOrganization,
  readPendingOrganization,
} from "@/onboarding/pendingOrganization";
import { queryKeys } from "@/lib/queryKeys";
import { LobbyCompanyCard } from "@/components/LobbyCompanyCard";
import { LobbyEmptyState } from "@/components/LobbyEmptyState";
import { LobbyShellMobileMenuButton } from "@/components/LobbyShell";
import { HUMAN_ROLE_LABELS } from "@/lib/human-profile-constants";

function deriveFirstName(
  displayName: string | undefined,
  email: string | undefined
): string {
  if (displayName?.trim()) {
    const first = displayName.trim().split(/\s+/)[0];
    if (first) return first;
  }
  if (email) {
    const local = email.split("@")[0] ?? "";
    return local.split(".")[0] ?? local;
  }
  return "there";
}

export function Lobby({
  pendingInvitations = [],
}: {
  pendingInvitations?: PendingInvitation[];
}) {
  const { companies, loading: companiesLoading, setSelectedCompanyId } = useCompany();
  const navigate = useNavigate();

  const { data: profile } = useQuery({
    queryKey: queryKeys.auth.profile,
    queryFn: () => profileApi.get(),
    staleTime: 60_000,
  });

  // Filter out archived companies
  const visibleCompanies = companies.filter((c) => c.status !== "archived");
  const progressQueries = useQueries({
    queries: visibleCompanies.map((company) => ({
      queryKey: ["onboarding", "progress", company.id] as const,
      queryFn: () => getOnboardingProgress(company.id),
      staleTime: 30_000,
    })),
  });
  const pendingOrganization = profile?.id ? readPendingOrganization(profile.id) : null;
  const interruptedCompanies = visibleCompanies.filter((_, index) => {
    const progress = progressQueries[index]?.data;
    if (progress == null) {
      return isConfirmedPendingOrganization(pendingOrganization) &&
        pendingOrganization.id === visibleCompanies[index]?.id;
    }
    return !progress.completedStates.includes("SETUP_COMPLETE");
  });

  // Lazy-load stats (T4)
  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: queryKeys.companies.stats,
    queryFn: () => companiesApi.stats(),
    enabled: visibleCompanies.length > 0,
  });

  const stats: CompanyStats | undefined = statsData ?? undefined;

  if (companiesLoading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-bg text-dim">
        <span className="text-sm">Loading...</span>
      </div>
    );
  }

  const isEmpty = visibleCompanies.length === 0;
  const firstName = deriveFirstName(
    profile?.displayName ?? undefined,
    profile?.email ?? undefined
  );
  const pendingCompanies = stats
    ? visibleCompanies.filter(
        (c) => (stats[c.id]?.pendingApprovalCount ?? 0) > 0
      ).length
    : 0;
  const subtitleParts: string[] = [];
  subtitleParts.push(
    `${visibleCompanies.length} ${
      visibleCompanies.length === 1 ? "company" : "companies"
    }`
  );
  if (pendingCompanies > 0) {
    subtitleParts.push(
      `${pendingCompanies} with pending approval${
        pendingCompanies === 1 ? "" : "s"
      }`
    );
  }

  return isEmpty ? (
    <LobbyEmptyState
      onCreate={() => navigate("/onboarding")}
      onImport={() => navigate("/import")}
    />
  ) : (
    <div className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6 sm:py-7 md:px-10 md:py-9">
      {/* Mobile hamburger — hidden on tablet+ */}
      <LobbyShellMobileMenuButton className="mb-4" />

      {/* Welcome */}
      <div className="mb-6 sm:mb-7 lobby-heading-enter">
        <h1 className="text-[1.25rem] sm:text-[1.4rem] md:text-[1.55rem] font-bold tracking-[-0.025em] text-foreground">
          Welcome back, {firstName}
          <span className="text-brand">.</span>
        </h1>
        <p className="mt-1 text-[0.82rem] sm:text-[0.86rem] text-dim">
          {subtitleParts.join(" · ")}.
        </p>
      </div>

      {pendingInvitations.length > 0 && (
        <div className="mb-6 flex flex-col gap-2">
          {pendingInvitations.map((invitation) => (
            <button
              key={invitation.inviteId}
              type="button"
              className="flex w-full items-center justify-between rounded-lg border border-brand/30 bg-brand/5 px-4 py-3 text-left transition-colors hover:bg-brand/10"
              aria-label={`Review invitation to ${invitation.companyName}`}
              onClick={() =>
                navigate(
                  `/onboarding/join?company=${encodeURIComponent(invitation.companyId)}`,
                )
              }
            >
              <span>
                <span className="block text-sm font-semibold text-foreground">
                  Invitation to {invitation.companyName}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Join as {HUMAN_ROLE_LABELS[invitation.role] ?? invitation.role} · review to
                  accept
                </span>
              </span>
              <span className="text-xs font-semibold text-brand">Review</span>
            </button>
          ))}
        </div>
      )}

      {interruptedCompanies.length > 0 && (
        <div className="mb-6 flex flex-col gap-2">
          {interruptedCompanies.map((company) => (
            <button
              key={company.id}
              type="button"
              className="flex w-full items-center justify-between rounded-lg border border-brand/30 bg-brand/5 px-4 py-3 text-left transition-colors hover:bg-brand/10"
              aria-label={`Finish setting up ${company.name}`}
              onClick={() => {
                setSelectedCompanyId(company.id);
                navigate("/onboarding");
              }}
            >
              <span>
                <span className="block text-sm font-semibold text-foreground">
                  Finish setting up {company.name}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Continue where you left off.
                </span>
              </span>
              <span className="text-xs font-semibold text-brand">Continue</span>
            </button>
          ))}
        </div>
      )}

      <div className="mb-3 sm:mb-3.5 text-[0.66rem] sm:text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-dim">
        Your companies
      </div>

      <div className="flex flex-col gap-3 sm:gap-3.5">
        {visibleCompanies.map((company, i) => (
          <div
            key={company.id}
            className="lobby-card-enter"
            style={{ "--lobby-card-index": i } as CSSProperties}
          >
            <LobbyCompanyCard
              company={company}
              stats={stats?.[company.id]}
              statsLoading={statsLoading}
              onClick={() => navigate(`/${company.issuePrefix}/home`)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
