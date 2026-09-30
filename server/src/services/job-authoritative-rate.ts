// server/src/services/job-authoritative-rate.ts
//
// JOB-012 — the versioned, FAIL-CLOSED authoritative-rate resolver used ONLY by the
// budget/cost bridge. It never trusts a worker-supplied price: the worker usage event
// carries bounded UNITS only, and the SERVER resolves provider/model/biller/
// billing-type/rate/version/rounding here.
//
// Why a NEW resolver instead of `cost-model.ts computeCostCents`: `computeCostCents`
// fails OPEN (an unknown model silently falls back to DEFAULT_RATE = Sonnet). The
// legacy heartbeat / one-shot callers depend on that lenient behavior and MUST NOT
// change. The authoritative charge must instead FAIL CLOSED — an unknown/unresolvable
// model throws `JobBudgetCostRateError` BEFORE any write, so zero cost_events and zero
// receipts are produced. This resolver gates on `isKnownRateModel` first, so the
// `computeCostCents` call it makes afterwards can only ever hit a KNOWN rate.
//
// Model resolution source (best-available immutable-ish fact, per the resolved design):
//   * task_run  → the source-owning agent's `adapter_config.model` (+ adapter_type as
//     provider). This is the agent that will run the task.
//   * crew_run / commander_turn → the company crew/Commander config
//     (`internal_agent_config`): crew prefers `crew_model`, Commander uses `model`.
//   * one_shot / service_reconcile / browser_request → the company workload default
//     (`internal_agent_config.model`) — these are agent-less.
//
// Snapshotting an immutable `{provider,model,rateId,rateVersion,roundingMode}` onto the
// job at submission time (so a later config change cannot re-price an in-flight job) is
// a documented follow-up (arguably JOB-009 placement territory) and is intentionally
// OUT of this ticket's schema scope.

import { eq } from "drizzle-orm";
import { agents, internalAgentConfig, type Db } from "@armyofagents/db";
import type { SubmitJobSource } from "@armyofagents/shared";
import { computeCostCents, isKnownRateModel } from "./internal-agent/cost-model.js";
import { inferBillingType } from "./costs.js";

/** The rate schedule version this resolver prices against. Bump ONLY when the
 * `RATES` table in cost-model.ts is re-priced, so historical rows stay attributable. */
export const AUTHORITATIVE_RATE_VERSION = 1;

/** How `computeCostCents` rounds a fractional cent (Math.round → half-up). Recorded on
 * cost_events.rounding_mode for provenance. */
export const AUTHORITATIVE_ROUNDING_MODE = "round_half_up_cents";

export interface AuthoritativeUsageUnits {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  runtimeMillis: number;
}

export interface ResolvedAuthoritativeRate {
  provider: string;
  model: string;
  biller: string;
  billingType: string;
  rateId: string;
  rateVersion: number;
  roundingMode: string;
  costCents: number;
}

/**
 * Thrown when the resolver cannot map the accepted usage to a KNOWN, versioned rate.
 * Fail-closed BEFORE any effect: the bridge produces zero cost_events / zero receipts.
 */
export class JobBudgetCostRateError extends Error {
  readonly code = "JOB_BUDGET_COST_RATE";
  constructor(message: string) {
    super(message);
    this.name = "JobBudgetCostRateError";
  }
}

function asModelString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Resolve the company crew/Commander/workload default model + provider. */
async function resolveCompanyConfigModel(
  tx: Db,
  companyId: string,
  preferCrewModel: boolean,
): Promise<{ provider: string; model: string } | null> {
  const [config] = await tx
    .select({
      provider: internalAgentConfig.provider,
      model: internalAgentConfig.model,
      crewModel: internalAgentConfig.crewModel,
    })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId))
    .limit(1);
  if (!config) return null;
  const model = preferCrewModel
    ? asModelString(config.crewModel) ?? asModelString(config.model)
    : asModelString(config.model);
  if (!model) return null;
  return { provider: config.provider ?? "anthropic", model };
}

/** Resolve the source-owning model/provider (null if it cannot be determined). */
async function resolveModelForSource(
  tx: Db,
  source: SubmitJobSource,
  companyId: string,
): Promise<{ provider: string; model: string } | null> {
  switch (source.kind) {
    case "task_run": {
      const [agent] = await tx
        .select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
        .from(agents)
        .where(eq(agents.id, source.assigneeAgentId))
        .limit(1);
      if (!agent) return null;
      const model = asModelString((agent.adapterConfig as Record<string, unknown>)?.model);
      if (!model) return null;
      return { provider: agent.adapterType, model };
    }
    case "crew_run":
      return resolveCompanyConfigModel(tx, companyId, true);
    case "commander_turn":
    case "one_shot":
    case "service_reconcile":
    case "browser_request":
      return resolveCompanyConfigModel(tx, companyId, false);
  }
}

/**
 * Resolve the authoritative rate for an accepted usage event. FAILS CLOSED (throws
 * `JobBudgetCostRateError`) when the model cannot be resolved or has no KNOWN rate —
 * the bridge must call this BEFORE any charge/receipt write.
 */
export async function resolveAuthoritativeRate(
  tx: Db,
  input: { source: SubmitJobSource; companyId: string; units: AuthoritativeUsageUnits },
): Promise<ResolvedAuthoritativeRate> {
  const resolved = await resolveModelForSource(tx, input.source, input.companyId);
  if (!resolved) {
    throw new JobBudgetCostRateError(
      `no model could be resolved for source kind '${input.source.kind}' (company ${input.companyId})`,
    );
  }
  if (!isKnownRateModel(resolved.model)) {
    throw new JobBudgetCostRateError(
      `no known rate for model '${resolved.model}' — refusing to fall back to a default rate`,
    );
  }
  // The known-model gate above guarantees this never uses DEFAULT_RATE.
  const costCents = computeCostCents(
    resolved.provider,
    resolved.model,
    input.units.inputTokens,
    input.units.outputTokens,
  );
  return {
    provider: resolved.provider,
    model: resolved.model,
    biller: resolved.provider,
    billingType: inferBillingType(resolved.provider),
    rateId: resolved.model,
    rateVersion: AUTHORITATIVE_RATE_VERSION,
    roundingMode: AUTHORITATIVE_ROUNDING_MODE,
    costCents,
  };
}
