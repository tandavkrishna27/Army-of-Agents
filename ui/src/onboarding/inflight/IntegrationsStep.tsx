import { useRef, useState } from "react";
import { Github, Link2 } from "lucide-react";
import { isGitHubRepoUrl } from "@armyofagents/shared";
import { githubIntegrationApi } from "../../api/github-integration";
import { ApiError } from "../../api/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Reveal } from "../motion";
import { FIELD, GradientText, LABEL, StepCard, StepHeading, StepShell } from "../steps/shared";

/**
 * Opaque, server-allowlisted key — see `ONBOARDING_RETURN_PATHS` in
 * `server/src/services/github-app.ts`. The server maps this key to a fixed
 * internal path ONLY after it round-trips through the signed install state;
 * an unrecognized key here would simply be dropped server-side (fallback to
 * Settings), never trusted as a raw redirect target.
 */
const ONBOARDING_RETURN_KEY = "integrations";

/** Future integrations — intentionally inert scaffold (WS5 scope: GitHub only). */
const COMING_SOON = ["Slack", "Linear", "Notion"];

export type IntegrationsStepProps = {
  companyId: string;
  onDone: () => void;
};

/**
 * WS5 — the In-flight "Integrations" surface. Standalone, like
 * `DefineDepartments` (WS4): domain-only, no `advanceOnboarding` call — WS9
 * wires this onto Home later. Offers GitHub via two modes:
 *
 *  - Connect (App/auth): drives `server/src/routes/github.ts`'s install-url /
 *    callback flow. The onboarding return target is carried inside the
 *    server-signed install state (never a free-form query param) so the
 *    callback can land the founder back here after installing — see
 *    `ONBOARDING_RETURN_PATHS` in `server/src/services/github-app.ts`.
 *  - Paste URL: a public-repo URL, validated with the shared
 *    `isGitHubRepoUrl` — the fallback when the GitHub App isn't configured on
 *    this instance (install-url 503s) or when the founder just prefers it.
 *
 * Optional/skippable — Skip and a successful Connect/paste all call `onDone`.
 */
export function IntegrationsStep({ companyId, onDone }: IntegrationsStepProps) {
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [appUnavailable, setAppUnavailable] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");

  const doneFiredRef = useRef(false);
  function fireOnDoneOnce() {
    if (doneFiredRef.current) return;
    doneFiredRef.current = true;
    onDone();
  }

  async function handleConnect() {
    setConnecting(true);
    setConnectError(null);
    try {
      const { url } = await githubIntegrationApi.getAppInstallUrl(companyId, ONBOARDING_RETURN_KEY);
      fireOnDoneOnce();
      window.location.href = url;
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        // Graceful fallback — the App isn't configured on this instance.
        // NOT a broken/disabled button: switch straight to the paste-URL path.
        setAppUnavailable(true);
        setShowPaste(true);
      } else {
        setConnectError(err instanceof Error ? err.message : "Couldn't start the GitHub connection.");
      }
    } finally {
      setConnecting(false);
    }
  }

  const trimmedRepoUrl = repoUrl.trim();
  const repoUrlValid = trimmedRepoUrl.length > 0 && isGitHubRepoUrl(trimmedRepoUrl);

  function handlePasteContinue() {
    if (!repoUrlValid) return;
    fireOnDoneOnce();
  }

  return (
    <StepShell>
      <Reveal>
        <StepHeading
          title={
            <>
              Connect your <GradientText>codebase</GradientText>
            </>
          }
          subtitle="Optional — hook up GitHub now, or skip and do it later from Settings."
        />
      </Reveal>

      <Reveal delay={0.09}>
        <StepCard>
          <div className="flex items-center gap-2">
            <Github className="h-4 w-4 text-text" aria-hidden />
            <span className="text-sm font-medium text-text">GitHub</span>
          </div>

          {!showPaste && (
            <div className="mt-3 space-y-2">
              <Button
                type="button"
                className="w-full gap-1.5"
                onClick={() => void handleConnect()}
                disabled={connecting}
              >
                {connecting ? "Connecting…" : "Connect GitHub App"}
              </Button>
              {connectError && <p className="text-xs text-destructive">{connectError}</p>}
              <button
                type="button"
                className={cn(LABEL, "text-center hover:text-text")}
                onClick={() => setShowPaste(true)}
              >
                Or paste a public repo URL instead
              </button>
            </div>
          )}

          {showPaste && (
            <div className="mt-3 space-y-2">
              {appUnavailable && (
                <p className="text-xs text-dim">
                  GitHub App isn't set up on this instance — paste a repo URL instead.
                </p>
              )}
              <label className={LABEL} htmlFor="integrations-repo-url">
                Repository URL
              </label>
              <div className="flex items-center gap-2">
                <Link2 className="h-3.5 w-3.5 shrink-0 text-dim" aria-hidden />
                <input
                  id="integrations-repo-url"
                  className={cn(FIELD, "text-xs")}
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/org/repo"
                />
              </div>
              {trimmedRepoUrl.length > 0 && !repoUrlValid && (
                <p className="text-xs text-destructive">Enter a valid GitHub repository URL.</p>
              )}
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                onClick={handlePasteContinue}
                disabled={!repoUrlValid}
              >
                Continue
              </Button>
              {!appUnavailable && (
                <button
                  type="button"
                  className={cn(LABEL, "text-center hover:text-text")}
                  onClick={() => setShowPaste(false)}
                >
                  Back to Connect
                </button>
              )}
            </div>
          )}
        </StepCard>
      </Reveal>

      <Reveal delay={0.18}>
        <StepCard className="opacity-60">
          <p className={LABEL}>More integrations</p>
          <div className="flex flex-wrap gap-2">
            {COMING_SOON.map((name) => (
              <span
                key={name}
                className="rounded-full border border-border-strong px-2.5 py-1 text-[10px] text-very-dim"
              >
                {name} · coming soon
              </span>
            ))}
          </div>
        </StepCard>
      </Reveal>

      <Reveal delay={0.27}>
        <Button type="button" variant="ghost" className="w-full" onClick={fireOnDoneOnce}>
          Skip for now
        </Button>
      </Reveal>
    </StepShell>
  );
}
