import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import type { StepProps } from "../registry";
import { companyWorkspaceFsApi } from "../../api/filesystem";
import { api, ApiError } from "../../api/client";
import { advanceOnboarding } from "../../api/onboarding";
import { Button } from "@/components/ui/button";
import { FolderBrowserDialog } from "@/components/FolderBrowserDialog";
import { cn } from "@/lib/utils";
import { Reveal } from "../motion";
import { FIELD, GradientText, LABEL, StepCard, StepHeading, StepShell } from "./shared";

type ProbeBody = {
  probe?: { summary?: string; checks?: { message?: string; status?: string }[] };
};

/** Pull the most precise reason out of a 422 (probe-blocked) response. */
function reasonFromError(err: unknown): string {
  if (err instanceof ApiError && err.status === 422) {
    const body = err.body as ProbeBody | null;
    const failed = body?.probe?.checks?.find((c) => c.status === "failed")?.message;
    return (
      body?.probe?.summary ??
      failed ??
      "Could not verify this folder. Pick another path or check permissions, then retry."
    );
  }
  return err instanceof Error
    ? err.message
    : "Could not verify this folder. Pick another path or check permissions, then retry.";
}

/**
 * "Set up your environment" step (Stage C / order 3, revA R13). Registers this
 * machine as a local environment and BLOCKS on a real read/create/delete probe
 * — a 422 keeps the founder on the step with the reason. On success it advances
 * ENVIRONMENT_READY on the org layer (the FlowEngine is read-only; steps own
 * their advance) and completes.
 */
export function EnvironmentStep({ ctx, onComplete }: StepProps) {
  const [rootFolder, setRootFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // WS3: the WS0a company-scoped, jail-aware folder browser — passing
  // companyId routes the dialog through the membership-authorized
  // workspace-fs API instead of the instance-admin filesystem API.
  const [browserOpen, setBrowserOpen] = useState(false);

  // BLOCKING fix: prefill must use the SAME company-scoped
  // `companyWorkspaceFsApi(companyId).home()` the Browse dialog uses below —
  // not the instance-admin `filesystemApi.home()` (gated by
  // `assertCanManageInstanceSettings`), which 403s for a non-admin founder in
  // `authenticated` mode and leaves the field blank. Best-effort: a prefill
  // failure doesn't block the step — direct path entry still works.
  useEffect(() => {
    if (!ctx.companyId) return;
    let cancelled = false;
    companyWorkspaceFsApi(ctx.companyId)
      .home()
      .then(({ homePath }) => {
        if (cancelled) return;
        const sep = homePath.includes("\\") ? "\\" : "/";
        setRootFolder(`${homePath}${sep}AoA`);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ctx.companyId]);

  const submit = async () => {
    if (!ctx.companyId || !rootFolder.trim()) {
      setError("Please enter a folder path.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 422 = probe blocked → surface the reason and keep the user here.
      await api.post(`/companies/${ctx.companyId}/onboarding/environment`, {
        rootFolder: rootFolder.trim(),
      });
      await advanceOnboarding({
        companyId: ctx.companyId,
        journey: ctx.journey,
        requestedState: "ENVIRONMENT_READY",
      });
      onComplete();
    } catch (e) {
      setError(reasonFromError(e));
      setBusy(false);
    }
  };

  return (
    <StepShell>
      <Reveal>
        <StepHeading
          title={
            <>
              Set up your <GradientText>environment</GradientText>
            </>
          }
          subtitle="AoA registers this machine and verifies it can read and write here. This is where department workspaces and agent files live."
        />
      </Reveal>

      <Reveal delay={0.09}>
        <StepCard>
          <label className={LABEL} htmlFor="env-root-folder">
            Root folder
          </label>
          <div className="flex gap-2">
            <input
              id="env-root-folder"
              className={cn(FIELD, "font-mono")}
              value={rootFolder}
              onChange={(e) => setRootFolder(e.target.value)}
            />
            <Button type="button" variant="secondary" className="shrink-0 gap-1.5" onClick={() => setBrowserOpen(true)}>
              <FolderOpen className="h-3.5 w-3.5" aria-hidden />
              Browse
            </Button>
          </div>
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </StepCard>
      </Reveal>

      <Reveal delay={0.18}>
        <Button className="w-full" onClick={() => void submit()} disabled={busy || !rootFolder.trim()}>
          {busy ? "Verifying…" : "Verify & continue"}
        </Button>
      </Reveal>

      {/* Known cross-cutting item (plan Decisions): this Radix dialog portals
          to document.body and picks up ambient app theme tokens rather than
          the `.onboarding-dark` scope — tracked separately, not fixed here. */}
      <FolderBrowserDialog
        open={browserOpen}
        onClose={() => setBrowserOpen(false)}
        onSelect={(path) => setRootFolder(path)}
        initialPath={rootFolder || undefined}
        companyId={ctx.companyId ?? undefined}
        title="Choose your environment root"
        description="AoA reads and writes here — department workspaces and agent files live inside this folder."
      />
    </StepShell>
  );
}
