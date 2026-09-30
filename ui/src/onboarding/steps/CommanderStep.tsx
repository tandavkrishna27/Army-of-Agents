import { useState } from "react";
import type { StepProps } from "../registry";
import { providerToCliTool, type CommanderProvider } from "@armyofagents/shared";
import { internalAgentApi } from "../../api/internal-agent";
import { advanceOnboarding } from "../../api/onboarding";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Reveal } from "../motion";
import { GradientText, StepHeading, StepShell } from "./shared";

const CARDS: { provider: CommanderProvider; label: string; desc: string }[] = [
  { provider: "anthropic", label: "Claude", desc: "Anthropic Claude Code CLI" },
  { provider: "openai", label: "Codex", desc: "OpenAI Codex CLI" },
];

/**
 * "Choose your Commander" step (Stage C / order 4). Cards, not a dropdown — no
 * model internals (scope §6). Writes the single internal_agent_config row in
 * place via PATCH (idempotent; the row is seeded at company create), then
 * advances COMMANDER_SELECTED and completes. Blank models → provider default
 * server-side. Crew inherits the same provider.
 */
export function CommanderStep({ ctx, onComplete }: StepProps) {
  const cloudMode = ctx.deploymentMode === "cloud_auth";
  const [provider, setProvider] = useState<CommanderProvider | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!ctx.companyId || !provider) return;
    setBusy(true);
    setError(null);
    try {
      await internalAgentApi.updateConfig(ctx.companyId, {
        cliTool: providerToCliTool(provider),
        provider,
        model: null,
        crewModel: null,
      });
      await advanceOnboarding({
        companyId: ctx.companyId,
        journey: ctx.journey,
        requestedState: "COMMANDER_SELECTED",
      });
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save your Commander choice.");
      setBusy(false);
    }
  };

  return (
    <StepShell>
      <Reveal>
        <StepHeading
          title={
            <>
              {cloudMode
                ? <>Choose your <GradientText>AI provider</GradientText></>
                : <>Bring your <GradientText>engine</GradientText> online</>}
            </>
          }
          subtitle={cloudMode
            ? "Save a provider preference for supported agent runs and future Commander availability. Commander does not run on AoA Cloud yet."
            : "This runtime powers Commander and every agent. Pick a CLI — you can change the model later in Settings."}
        />
      </Reveal>

      <Reveal delay={0.09}>
        <div className="grid grid-cols-2 gap-3">
          {CARDS.map((c) => (
            <button
              key={c.provider}
              type="button"
              className={cn(
                "rounded-xl border border-border-strong bg-card p-4 text-left transition-colors hover:border-brand",
                provider === c.provider && "border-brand shadow-[inset_0_0_0_1px_var(--brand)]",
              )}
              onClick={() => setProvider(c.provider)}
            >
              <div className="text-sm font-medium text-text">{c.label}</div>
              <div className="text-xs text-dim">
                {cloudMode ? `${c.label} provider preference` : c.desc}
              </div>
            </button>
          ))}
        </div>
      </Reveal>

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      <Reveal delay={0.18}>
        <Button className="w-full" onClick={() => void submit()} disabled={busy || !provider}>
          {busy ? "Saving…" : "Continue"}
        </Button>
      </Reveal>
    </StepShell>
  );
}
