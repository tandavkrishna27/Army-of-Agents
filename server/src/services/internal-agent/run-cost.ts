import { computeCostCents } from "./cost-model.js";

/**
 * Cost for a finished Commander run, in cents.
 * Prefer the adapter-reported cost (already real cents). Subscription CLI
 * reports 0 — fall back to a token × list-price ESTIMATE. Never a real bill.
 */
export function resolveRunCostCents(input: {
  reportedCostCents: number;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
}): number {
  if (input.reportedCostCents > 0) return input.reportedCostCents;
  return computeCostCents(
    input.provider ?? "anthropic",
    input.model ?? "claude-sonnet-4-6",
    input.inputTokens,
    input.outputTokens,
  );
}

/**
 * REVIEW FIX (Lens C): the estimate's rate model must reflect the ACTIVE CLI
 * tool, not internal_agent_config.model (a dormant legacy API-mode column that
 * defaults to claude-sonnet-4-6 regardless of the CLI in use — so a codex run
 * would otherwise be priced at Claude rates). For claude_cli we honour an
 * explicitly-configured model; otherwise we use a representative model per tool.
 * It is a labelled estimate, not a bill.
 */
export function rateModelForCliTool(
  cliTool: string | null,
  configModel: string | null,
): { provider: string; model: string } {
  switch (cliTool) {
    case "codex":
      return { provider: "openai", model: "gpt-4.1" };
    case "opencode":
      return { provider: "openai", model: "gpt-4.1" };
    case "claude_cli":
    default:
      return { provider: "anthropic", model: configModel ?? "claude-sonnet-4-6" };
  }
}

// ── Shared types for run persistence helpers ──────────────────────────────────

export interface RunFinalSummary {
  durationMs: number;
  costCents: number;
  tokenUsage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | null;
  model?: string | null;
  provider?: string | null;
}

// ── Per-run persistence resolution (extracted from the chat SSE handler) ──────
//
// These are pure functions so the route's inline logic can be unit-tested
// against the REAL implementation rather than local copies.

/**
 * Resolve the run duration to persist.
 * Prefer the adapter-reported durationMs; fall back to wall-clock when the
 * adapter reports 0, a negative value, or finalSummary is absent.
 */
export function resolveRunDurationMs(
  finalSummary: RunFinalSummary | null,
  wallClockMs: number,
): number {
  return finalSummary && finalSummary.durationMs > 0 ? finalSummary.durationMs : wallClockMs;
}

/**
 * Resolve the costCents to persist.
 * When tokenUsage is present, delegate to resolveRunCostCents (estimate-vs-reported).
 * When absent, fall through to the raw reportedCostCents (0 for subscription CLIs).
 *
 * Note: runProvider/runModel are the COST-LABEL inputs, not the adapter-reported
 * provenance.  Cost PRICING always uses the cost-label so codex turns are priced
 * at OpenAI rates even if the adapter reports a different model string (F1).
 */
export function resolveRunCostCentsFromSummary(
  finalSummary: RunFinalSummary | null,
  runProvider: string,
  runModel: string,
): number {
  const tokenUsage = finalSummary?.tokenUsage ?? null;
  const reportedCostCents = finalSummary?.costCents ?? 0;
  if (tokenUsage) {
    return resolveRunCostCents({
      reportedCostCents,
      provider: runProvider,
      model: runModel,
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
    });
  }
  return reportedCostCents;
}

/**
 * Resolve the model/provider columns to persist.
 * F1: prefer the adapter-reported model/provider (actual runtime provenance)
 * over the cost-label defaults.  Cost PRICING is unaffected.
 */
export function resolvePersistedProvenance(
  finalSummary: RunFinalSummary | null,
  runModel: string,
  runProvider: string,
): { model: string; provider: string } {
  return {
    model: finalSummary?.model ?? runModel,
    provider: finalSummary?.provider ?? runProvider,
  };
}

/**
 * Build the `done` SSE payload.
 * F2: sends the LOCALLY-COMPUTED costCents (matches DB row) and a
 * guaranteed-non-null tokenUsage so the wire is consistent with the DB.
 */
export function resolveDonePayload(
  finalSummary: RunFinalSummary | null,
  computedCostCents: number,
): { costCents: number; tokenUsage: { inputTokens: number; outputTokens: number } } {
  return {
    costCents: computedCostCents,
    tokenUsage: finalSummary?.tokenUsage ?? { inputTokens: 0, outputTokens: 0 },
  };
}
