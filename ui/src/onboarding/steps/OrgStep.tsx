import { useEffect, useRef, useState } from "react";
import type { StepProps } from "../registry";
import { useCompany } from "../../context/CompanyContext";
import { companiesApi } from "../../api/companies";
import { advanceOnboarding } from "../../api/onboarding";
import {
  clearPendingOrganization,
  isConfirmedPendingOrganization,
  readPendingOrganization,
  writePendingOrganization,
  type ConfirmedPendingOrganization,
  type PendingOrganizationAttempt,
} from "../pendingOrganization";
import { clearPendingTenant } from "../pendingTenant";
import { Button } from "@/components/ui/button";
import { Reveal } from "../motion";
import { FIELD, GradientText, LABEL, StepCard, StepHeading, StepShell } from "./shared";

/**
 * "Create your company" step (Stage C / order 2; component name kept as
 * `OrgStep` for history, but Phase 2 Task 2/3 renamed its onboarding state
 * and copy from ORGANIZATION_CREATED/"organization" to COMPANY_CREATED/
 * "company" — the wizard historically said "organization" but meant COMPANY.
 * The actual multi-tenant Organization is now created a step earlier by
 * `CreateOrganizationStep`, whose id `ctx.organizationId` this step forwards
 * into `createCompany`. Creates the company via the CompanyContext primitive
 * — which invalidates the companies query AND sets it as the selected company
 * (the RB1 handshake: the selectedCompanyId change reloads the FlowEngine
 * from the user layer to the NEW company's layer). The advance therefore
 * targets the NEW companyId, not ctx.companyId (still null here). Name
 * only — mission/vision are captured later. `ensureProgress` already seeds
 * the org layer from the user layer, so the PROFILE_SET dependency holds.
 *
 * Revisited state: when ctx.companyId is already set (walked back from a
 * later step, or resuming an interrupted company layer), the company exists —
 * render it read-only with a single Continue (re-advance) instead of an
 * editable empty field whose input would be silently discarded.
 */
export function OrgStep({ ctx, onComplete }: StepProps) {
  const { createCompany } = useCompany();
  const [pendingAtMount] = useState(() => readPendingOrganization(ctx.userId));
  const [name, setName] = useState(pendingAtMount?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The durable recovery hint closes both retry windows: createdRef handles a
  // same-mount retry, while localStorage survives a reload/tab close between the
  // company POST and the onboarding PATCH. A selected org-layer company is also
  // safe to reuse when resuming an interrupted flow.
  const createdRef = useRef<ConfirmedPendingOrganization | null>(
    isConfirmedPendingOrganization(pendingAtMount) ? pendingAtMount : null,
  );
  const attemptRef = useRef<PendingOrganizationAttempt | null>(
    pendingAtMount && !isConfirmedPendingOrganization(pendingAtMount)
      ? pendingAtMount
      : null,
  );

  const revisitedCompanyId = ctx.companyId;
  const [revisitedName, setRevisitedName] = useState<string | null>(null);
  useEffect(() => {
    if (!revisitedCompanyId) return;
    let cancelled = false;
    companiesApi
      .get(revisitedCompanyId)
      .then((company) => {
        if (!cancelled) setRevisitedName((company as { name?: string } | null)?.name ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [revisitedCompanyId]);

  const submit = async () => {
    const resumableCompany =
      createdRef.current ??
      (ctx.companyId ? { id: ctx.companyId, name: name.trim() } : null);
    if (!resumableCompany && !name.trim()) {
      setError("Please enter a name for your company.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // organizationId is set by the preceding CreateOrganizationStep on the
      // founder spine, and by CreateAnotherCompany on the standalone "create
      // another company" surface (OnboardingFlow.tsx `?new=1`). In cloud_auth
      // it is always an explicit create-capable org id (CreateAnotherCompany
      // resolves it — the server 403s an omitted id for a founder in >=2 orgs).
      // It is null only on the self-hosted path, where omitting it makes
      // resolveCompanyOrganizationId derive DEFAULT_ORGANIZATION_ID.
      const normalizedName = name.trim();
      const organizationId = ctx.organizationId ?? undefined;
      let company = resumableCompany;
      if (!company) {
        const priorAttempt = attemptRef.current;
        const attempt =
          priorAttempt?.name === normalizedName &&
          priorAttempt.organizationId === organizationId
            ? priorAttempt
            : {
                name: normalizedName,
                organizationId,
                creationRequestId: crypto.randomUUID(),
              };
        attemptRef.current = attempt;
        // Persist before POST so commit-plus-lost-response retries use the
        // same server idempotency key rather than creating a ghost company.
        writePendingOrganization(ctx.userId, attempt);
        company = await createCompany({
          name: normalizedName,
          organizationId,
          creationRequestId: attempt.creationRequestId,
        });
      }
      createdRef.current = company;
      writePendingOrganization(ctx.userId, company);
      await advanceOnboarding({
        companyId: company.id,
        journey: ctx.journey,
        requestedState: "COMPANY_CREATED",
      });
      clearPendingOrganization(ctx.userId);
      clearPendingTenant(ctx.userId);
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create your company.");
      setBusy(false);
    }
  };

  /** Read-only re-advance for the revisited state (no create, no edit). */
  const continueRevisited = async () => {
    if (!revisitedCompanyId) return;
    setBusy(true);
    setError(null);
    try {
      await advanceOnboarding({
        companyId: revisitedCompanyId,
        journey: ctx.journey,
        requestedState: "COMPANY_CREATED",
      });
      clearPendingOrganization(ctx.userId);
      clearPendingTenant(ctx.userId);
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to continue.");
      setBusy(false);
    }
  };

  if (revisitedCompanyId) {
    return (
      <StepShell>
        <Reveal>
          <StepHeading
            title={
              <>
                Your <GradientText>company</GradientText>
              </>
            }
            subtitle="Your company is already created — continue to pick up where you left off."
          />
        </Reveal>
        <Reveal delay={0.09}>
          <StepCard>
            <span className={LABEL}>Company name</span>
            <div data-testid="org-revisited-name" className="rounded-md border border-border-strong bg-field px-3 py-2 text-sm text-text">
              {revisitedName ?? "…"}
            </div>
            {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
          </StepCard>
        </Reveal>
        <Reveal delay={0.18}>
          <Button className="w-full" onClick={() => void continueRevisited()} disabled={busy}>
            {busy ? "Continuing…" : "Continue"}
          </Button>
        </Reveal>
      </StepShell>
    );
  }

  return (
    <StepShell>
      <Reveal>
        <StepHeading
          title={
            <>
              Your <GradientText>company</GradientText>
            </>
          }
          subtitle="This is what your workforce serves — everything your agents do traces back here. You can change the name later."
        />
      </Reveal>
      <Reveal delay={0.09}>
        <StepCard>
          <label className={LABEL} htmlFor="org-name">
            Company name
          </label>
          <input
            id="org-name"
            className={FIELD}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </StepCard>
      </Reveal>
      <Reveal delay={0.18}>
        <Button className="w-full" onClick={() => void submit()} disabled={busy}>
          {busy ? "Creating…" : "Continue"}
        </Button>
      </Reveal>
    </StepShell>
  );
}
