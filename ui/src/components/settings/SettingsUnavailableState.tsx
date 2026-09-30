import { useEffect, useRef } from "react";
import { useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import type { SettingsDeploymentState } from "./useSettingsSidebar";

export function SettingsUnavailableState({
  sectionName,
  deploymentState,
  onRetry,
}: {
  sectionName: "Access" | "Heartbeats";
  deploymentState: Exclude<SettingsDeploymentState, "available">;
  onRetry: () => void;
}) {
  const navigate = useNavigate();
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // Route-entry focus only. A loading state may later become cloud/error, but
  // that async transition must not steal focus a second time.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const isCloud = deploymentState === "cloud";
  const isError = deploymentState === "error";
  const heading = isCloud
    ? `${sectionName} is unavailable on AoA Cloud`
    : isError
    ? `We couldn't verify ${sectionName} availability`
    : `Checking ${sectionName} availability`;
  const description = isCloud
    ? "This instance-wide view is disabled in cloud mode because operator access must not expose tenant data."
    : isError
    ? "Deployment status could not be loaded. This section stays closed until AoA can verify that it is safe to open."
    : "AoA is checking the deployment mode before opening this instance-wide section.";

  return (
    <section
      className="max-w-xl rounded-xl border border-border bg-card p-6"
      role={isCloud ? undefined : "status"}
      aria-live={isCloud ? undefined : "polite"}
    >
      <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
        {heading}
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={() => navigate("/instance/settings?tab=general")}>Back to General</Button>
        {isError ? (
          <Button variant="secondary" onClick={onRetry}>
            Retry deployment check
          </Button>
        ) : null}
      </div>
    </section>
  );
}
