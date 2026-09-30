// server/src/services/heartbeat-execution-target.ts
//
// Pure helper extracted from the heartbeat run-scope so the P5 execution-target
// routing is unit-testable off the large-file heartbeat path. Given the run's
// current adapter config and the adapter config of a routed execution target
// (or null when routing fell back to local), it produces the config the run
// dispatches with. A null routed target returns the input config UNCHANGED (same
// reference) — the self-hosted/default-off fallback path stays byte-identical.
import type { Db } from "@armyofagents/db";
import { resolveCompanyOrganizationId } from "./org-concurrency.js";

export async function resolveHeartbeatExecutionTargetOrganizationId(
  db: Db,
  input: { companyId: string; tenantIsolationEnforced: boolean },
): Promise<string | null> {
  const organizationId = await resolveCompanyOrganizationId(db, input.companyId);
  if (!organizationId && input.tenantIsolationEnforced) {
    throw new Error(`Cloud heartbeat run cannot resolve an organization for company ${input.companyId}.`);
  }
  return organizationId;
}

export function mergeResolvedExecutionTarget(
  config: Record<string, unknown>,
  adapterConfig: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!adapterConfig) return config;
  return { ...config, executionTarget: adapterConfig };
}

// Decide how a resolveExecutionTargetForRun failure is handled. An EXPLICIT pin
// (environmentRuntime.executionTargetId != null) OR a personal_subscription run
// must fail closed rather than silently falling back to the local host (which on
// shared infra would be a different trust domain than the credential's bound
// target). An unpinned company_api_key / null-credential run keeps the local
// fallback so a transient DB/routing error does not fail an otherwise-runnable run.
// Decision #117 §4.
export function handleExecutionTargetRoutingError(
  error: unknown,
  ctx: { hasExplicitPin: boolean; credentialKind: "company_api_key" | "personal_subscription" | null },
): null {
  // Decision #117 §4: an explicit pin OR a personal_subscription run must fail
  // closed — never silently fall back to the local host (which on shared infra
  // would be a different trust domain than the credential's bound target). An
  // unpinned company_api_key / null-credential run keeps the local fallback so a
  // transient DB/routing error does not fail an otherwise-runnable run.
  if (ctx.hasExplicitPin || ctx.credentialKind === "personal_subscription") throw error;
  return null;
}
