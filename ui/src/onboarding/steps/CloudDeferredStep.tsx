import { useState, type ReactNode } from "react";
import type { OnboardingState } from "@armyofagents/shared";
import type { StepProps } from "../registry";
import { CloudProviderKeyNotice } from "../CloudProviderKeyNotice";
import { advanceOnboarding } from "../../api/onboarding";
import { Button } from "@/components/ui/button";
import { Reveal } from "../motion";
import { EnvironmentStep } from "./EnvironmentStep";
import { VerifyStep } from "./VerifyStep";
import { GradientText, StepCard, StepHeading, StepShell } from "./shared";

function CloudDeferredStep({
  ctx,
  onComplete,
  state,
  title,
  description,
  supportingContent,
}: StepProps & {
  state: OnboardingState;
  title: string;
  description: string;
  supportingContent?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const continueSetup = async () => {
    if (!ctx.companyId) return;
    setBusy(true);
    setError(null);
    try {
      await advanceOnboarding({
        companyId: ctx.companyId,
        journey: ctx.journey,
        requestedState: state,
      });
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not continue setup.");
      setBusy(false);
    }
  };

  return (
    <StepShell>
      <Reveal>
        <StepHeading
          title={<><GradientText>{title}</GradientText></>}
          subtitle={description}
        />
      </Reveal>
      <Reveal delay={0.09}>
        <StepCard>
          <p className="text-sm text-dim">
            Local host access stays disabled on AoA Cloud. E2B can be configured
            in company Settings for supported heartbeat-agent runs; the gVisor
            worker pool and full workspace lifecycle remain deferred.
          </p>
          {supportingContent && <div className="mt-3">{supportingContent}</div>}
          {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        </StepCard>
      </Reveal>
      <Reveal delay={0.18}>
        <Button className="w-full" onClick={() => void continueSetup()} disabled={busy}>
          {busy ? "Continuing…" : "Continue setup"}
        </Button>
      </Reveal>
    </StepShell>
  );
}

export function CloudAwareEnvironmentStep(props: StepProps) {
  if (props.ctx.deploymentMode !== "cloud_auth") return <EnvironmentStep {...props} />;
  return (
    <CloudDeferredStep
      {...props}
      state="ENVIRONMENT_READY"
      title="Cloud execution"
      description="Local execution and the gVisor worker pool are not available on AoA Cloud yet."
    />
  );
}

export function CloudAwareVerifyStep(props: StepProps) {
  if (props.ctx.deploymentMode !== "cloud_auth") return <VerifyStep {...props} />;
  return (
    <CloudDeferredStep
      {...props}
      state="COMMANDER_VERIFIED"
      title="Commander deferred"
      description="Commander uses a local CLI and cannot be verified or run on AoA Cloud yet. Continue to finish control-plane setup."
      supportingContent={
        <CloudProviderKeyNotice deploymentMode={props.ctx.deploymentMode} />
      }
    />
  );
}
