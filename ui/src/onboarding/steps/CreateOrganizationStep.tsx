import { useEffect, useRef, useState } from "react";
import type { StepProps } from "../registry";
import { organizationsApi } from "../../api/organizations";
import {
  isConfirmedPendingTenant,
  readPendingTenant,
  writePendingTenant,
  type ConfirmedPendingTenant,
  type PendingTenantAttempt,
} from "../pendingTenant";
import { Button } from "@/components/ui/button";
import { Reveal } from "../motion";
import { FIELD, GradientText, LABEL, StepCard, StepHeading, StepShell } from "./shared";

/**
 * "Create your organization" step (Phase 2 Task 3/12) — the TENANT step,
 * ordered immediately before the (renamed) company step in the founder
 * sequence. Creates the Organization (the multi-tenant account that will own
 * one or more Companies + billing) and stores its id on the onboarding
 * context (`ctx.setOrganizationId`) for the following company step, which
 * forwards it into `createCompany`.
 *
 * Unlike every other spine step, this one does NOT call `advanceOnboarding` —
 * Organization membership is not modeled in the `onboarding_progress` state
 * machine (that machine is per-company; an Organization exists above the
 * company layer, see Phase 2 Task 9's org-first journey resolver). Its
 * registry `isComplete` instead reads `ctx.organizationId` directly (see
 * `steps/index.ts`). Reload recovery is persisted per user in `pendingTenant`:
 * this step adopts that Organization on mount, and `OrgStep` clears the hint
 * after the Company has been created and its progress write succeeds.
 */
export function CreateOrganizationStep({ ctx, onComplete }: StepProps) {
  // Reload durability (Fix 3a): a tenant persisted on a prior mount means the
  // org was already created — a hard reload between this step and the company
  // step must NOT POST a second (ghost) organization. Mirror OrgStep's
  // pendingOrganization pattern: read once at mount into a ref, then adopt it
  // instead of re-creating.
  const [pendingAtMount] = useState(() => readPendingTenant(ctx.userId));
  const [name, setName] = useState(pendingAtMount?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createdRef = useRef<ConfirmedPendingTenant | null>(
    isConfirmedPendingTenant(pendingAtMount) ? pendingAtMount : null,
  );
  const attemptRef = useRef<PendingTenantAttempt | null>(
    pendingAtMount && !isConfirmedPendingTenant(pendingAtMount) ? pendingAtMount : null,
  );

  // Auto-resolve on mount when a persisted tenant exists (post-reload / strand
  // resume): adopt its id and advance to the company step without re-creating.
  useEffect(() => {
    if (!isConfirmedPendingTenant(pendingAtMount)) return;
    ctx.setOrganizationId?.(pendingAtMount.id);
    onComplete();
    // Mount-only: pendingAtMount is frozen for this mount; re-running on
    // ctx/onComplete identity changes would double-advance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    // Same-mount retry after a downstream failure: reuse the already-created org.
    if (createdRef.current) {
      ctx.setOrganizationId?.(createdRef.current.id);
      onComplete();
      return;
    }
    if (!name.trim()) {
      setError("Please enter a name for your organization.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const normalizedName = name.trim();
      const attempt =
        attemptRef.current?.name === normalizedName
          ? attemptRef.current
          : { name: normalizedName, creationRequestId: crypto.randomUUID() };
      attemptRef.current = attempt;
      // Persist the request identity before the network call. If the server
      // commits but the response is lost, a reload replays the same request.
      writePendingTenant(ctx.userId, attempt);
      const org = await organizationsApi.create({
        name: normalizedName,
        creationRequestId: attempt.creationRequestId,
      });
      const pending: ConfirmedPendingTenant = { id: org.id, name: org.name };
      createdRef.current = pending;
      // Persist BEFORE onComplete so a reload during the engine's re-read still
      // finds the recovery hint (OrgStep clears it once the company consumes it).
      writePendingTenant(ctx.userId, pending);
      ctx.setOrganizationId?.(org.id);
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create your organization.");
      setBusy(false);
    }
  };

  return (
    <StepShell>
      <Reveal>
        <StepHeading
          title={
            <>
              Your <GradientText>organization</GradientText>
            </>
          }
          subtitle="Your organization is the account that owns your companies and billing."
        />
      </Reveal>
      <Reveal delay={0.09}>
        <StepCard>
          <label className={LABEL} htmlFor="org-tenant-name">
            Organization name
          </label>
          <input
            id="org-tenant-name"
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
