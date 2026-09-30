import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import type { OnboardingJourney } from "@armyofagents/shared";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { advanceOnboarding, getOnboardingProgress, onboardingApi } from "../api/onboarding";
import { DarkShell, FlowEngine } from "../onboarding/FlowEngine";
import { ONBOARDING_STEPS } from "../onboarding/steps";
import { CreateAnotherCompany } from "../onboarding/CreateAnotherCompany";
import { InvitedJoinTerminal } from "../onboarding/InvitedJoinTerminal";
import { FirstRunHome } from "../onboarding/FirstRunHome";
import { healthApi } from "../api/health";

/**
 * The onboarding route (Stage B / B7). Wires the FlowEngine with the real
 * session user, the currently-selected company (the org layer; null = the user
 * layer), and the real progress API. Steps own their own advance; the engine
 * only reads + resolves.
 */
export function OnboardingFlowPage({ journey }: { journey: OnboardingJourney }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const { selectedCompanyId } = useCompany();
  const [invitedDone, setInvitedDone] = useState(false);
  // Founder: after the spine finishes, the persona fork + in-flight tail run
  // INLINE here (same dark flow) rather than on the dashboard — onboarding never
  // bleeds into the company pages. `spineDone` also covers resume: a returning
  // founder whose spine is already complete makes FlowEngine resolve no step and
  // fire onFinished immediately, dropping straight into the tail.
  const [spineDone, setSpineDone] = useState(false);
  const isNewFounderOrganization =
    journey === "founder" && searchParams.get("new") === "1";
  const { data: session, isLoading } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const userId = session?.user?.id;
  const profileProgressQuery = useQuery({
    queryKey: ["onboarding", "progress", "user-layer", userId],
    queryFn: async () => {
      const progress = await getOnboardingProgress(null);
      if (progress?.completedStates.includes("PROFILE_SET")) return progress;
      return advanceOnboarding({
        companyId: null,
        journey: "founder",
        requestedState: "PROFILE_SET",
      });
    },
    enabled: Boolean(userId && isNewFounderOrganization),
    retry: false,
  });

  if (isLoading || healthQuery.isLoading || (isNewFounderOrganization && profileProgressQuery.isLoading)) {
    return (
      <div className="onboarding-dark flex min-h-screen items-center justify-center bg-background">
        <p className="text-sm text-dim">Loading…</p>
      </div>
    );
  }

  if (!userId) {
    navigate("/auth", { replace: true });
    return null;
  }

  if (healthQuery.error) {
    return (
      <div className="onboarding-dark flex min-h-screen items-center justify-center bg-background px-6">
        <p className="text-sm text-destructive">Failed to determine deployment mode</p>
      </div>
    );
  }

  if (isNewFounderOrganization && profileProgressQuery.error) {
    return (
      <div className="onboarding-dark flex min-h-screen items-center justify-center bg-background px-6">
        <p className="text-sm text-destructive">
          {profileProgressQuery.error instanceof Error
            ? profileProgressQuery.error.message
            : "Failed to prepare organization setup"}
        </p>
      </div>
    );
  }

  // "Create another organization" (?new=1). A returning founder funnelled to
  // bare /onboarding binds to their already-complete company, so the engine
  // resolves no step and bounces them to the Lobby — a dead end. Drive the
  // org-create step DIRECTLY on the user layer (companyId=null); its RB1
  // handshake selects the new company, then we resume that company's layer via a
  // clean /onboarding (dropping ?new so it can't re-fire). Going through the
  // engine with a pinned-null companyId would instead loop: OrgStep advances on
  // the NEW company while the engine re-reads the still-empty user layer.
  if (isNewFounderOrganization) {
    // Fix 2 (design P1): resolve the founder's own create-capable Organization
    // before the company step. In cloud_auth an explicit org id is mandatory —
    // the server's resolveCompanyOrganizationId 403s a >=2-org founder who omits
    // it and never guesses; a single-org founder is auto-picked silently. Only
    // self-hosted omits the id (resolveCompanyOrganizationId derives
    // DEFAULT_ORGANIZATION_ID). CreateAnotherCompany owns that whole resolution.
    return (
      <DarkShell>
        <div className="relative z-10 flex min-h-screen items-center justify-center px-6 py-8">
          <CreateAnotherCompany
            userId={userId}
            journey={journey}
            onCompleteCompany={() => navigate("/onboarding", { replace: true })}
            onBack={() => navigate("/", { replace: true })}
          />
        </div>
      </DarkShell>
    );
  }

  if (journey === "invited" && invitedDone) {
    return <InvitedJoinTerminal />;
  }

  // Founder tail: the spine is done — run the persona fork + in-flight tail
  // (departments → integrations → braindump → Librarian → agents → first job)
  // in the SAME dark flow. FirstRunHome writes firstRunCompleted at the end; on
  // completion we hand off to the Lobby (the returning-user home base). Guard on
  // selectedCompanyId — the org-create step selects it, and on resume the index
  // gate selects it before routing here; a brief null is just a loading frame.
  if (journey === "founder" && spineDone) {
    if (!selectedCompanyId) {
      return (
        <DarkShell>
          <div className="relative z-10 flex min-h-screen items-center justify-center px-6">
            <p className="text-sm text-dim">Loading…</p>
          </div>
        </DarkShell>
      );
    }
    return (
      <FirstRunHome
        companyId={selectedCompanyId}
        onComplete={() => {
          // Re-resolve the journey (now firstRunCompleted) so the index gate
          // doesn't bounce us back into onboarding, then hand off to the Lobby.
          queryClient.removeQueries({ queryKey: ["onboarding", "journey"], exact: true });
          navigate("/", { replace: true });
        }}
      />
    );
  }

  return (
    <FlowEngine
      userId={userId}
      companyId={journey === "invited" ? null : (selectedCompanyId ?? null)}
      journey={journey}
      deploymentMode={healthQuery.data?.deploymentMode}
      api={onboardingApi}
      registry={ONBOARDING_STEPS}
      onBack={() => navigate("/", { replace: true })}
      onFinished={() => {
        if (journey === "invited") {
          setInvitedDone(true);
          return;
        }
        // Founder spine complete → hand off to the INLINE tail above (persona +
        // in-flight), NOT the dashboard. The tail owns the firstRunCompleted
        // write and the final navigation to the Lobby.
        setSpineDone(true);
      }}
    />
  );
}
