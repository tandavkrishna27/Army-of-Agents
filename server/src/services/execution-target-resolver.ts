// server/src/services/execution-target-resolver.ts
import { or, isNull, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { executionTargets } from "@armyofagents/db";

export interface ExecutionTargetRow {
  id: string;
  slug: string;
  kind: string;
  trustClass: string;
  status: string;
  organizationId: string | null;
  config?: Record<string, unknown>;
}

// `credentialKind` + `executionTargetSlug` are P4's normalized seam field names.
export function chooseExecutionTargetRow(input: {
  credentialKind: "company_api_key" | "personal_subscription" | null;
  pinnedTargetId: string | null;
  executionTargetSlug: string | null;
  targets: ExecutionTargetRow[];
}): ExecutionTargetRow | null {
  const active = input.targets.filter((t) => t.status === "active");
  if (input.pinnedTargetId) {
    const pinned = active.find((t) => t.id === input.pinnedTargetId);
    if (!pinned) throw new Error(`Pinned execution target ${input.pinnedTargetId} is not available.`);
    if (input.credentialKind === "personal_subscription" && input.executionTargetSlug && pinned.slug !== input.executionTargetSlug) {
      throw new Error("Pinned target does not match the subscription credential's execution target.");
    }
    return pinned;
  }
  if (input.credentialKind === "personal_subscription") {
    if (!input.executionTargetSlug) throw new Error("Personal subscription run has no bound execution target.");
    const match = active.find((t) => t.slug === input.executionTargetSlug && (t.kind === "dedicated_worker" || t.kind === "local_host"));
    if (!match) throw new Error(`No dedicated execution target matches credential target "${input.executionTargetSlug}".`);
    return match;
  }
  // company_api_key (business key) -> shared pool
  const pool = active.find((t) => t.kind === "pooled_gvisor");
  return pool ?? null; // null => caller falls back to local (self-hosted single tenant)
}

export async function resolveExecutionTargetForRun(
  db: Db,
  input: {
    organizationId: string | null;
    companyId: string;
    // credentialKind + executionTargetSlug come straight off P4's resolver seam.
    credentialKind: "company_api_key" | "personal_subscription" | null;
    pinnedTargetId: string | null;
    executionTargetSlug: string | null;
  },
): Promise<ExecutionTargetRow | null> {
  // System/shared targets (organizationId null) + this org's targets are both
  // eligible — scoped in SQL (index execution_targets_org_idx) rather than a
  // full-table scan + JS filter. For a null org, isNull() alone yields the system
  // rows (preserving the prior JS-filter behavior; eq() cannot take a null value,
  // and `col = NULL` would never match anyway).
  const orgScope =
    input.organizationId == null
      ? isNull(executionTargets.organizationId)
      : or(
          isNull(executionTargets.organizationId),
          eq(executionTargets.organizationId, input.organizationId),
        );
  const scoped = (await db
    .select({
      id: executionTargets.id,
      slug: executionTargets.slug,
      kind: executionTargets.kind,
      trustClass: executionTargets.trustClass,
      status: executionTargets.status,
      organizationId: executionTargets.organizationId,
      config: executionTargets.config,
    })
    .from(executionTargets)
    .where(orgScope)) as ExecutionTargetRow[];
  return chooseExecutionTargetRow({
    credentialKind: input.credentialKind,
    pinnedTargetId: input.pinnedTargetId,
    executionTargetSlug: input.executionTargetSlug,
    targets: scoped,
  });
}

const HARDENED_ISOLATION = {
  user: "1000:1000",
  capDropAll: true,
  noNewPrivileges: true,
  readOnlyRootfs: true,
  tmpfs: ["/tmp:rw,noexec,nosuid,size=64m", "/home/agent:rw,nosuid,size=256m"],
  memory: "2g",
  cpus: "2",
  pidsLimit: 512,
  ipcPrivate: true,
} as const;

export function executionTargetToAdapterConfig(
  target: ExecutionTargetRow,
  // Whether this run executes on SHARED multi-tenant infra. The security boundary
  // is deployment-mode, NOT organizationId: on a founder's OWN box (self-hosted
  // single_user/single_tenant) the config is trusted and must be honored, while on
  // shared infra this registry path must never execute in the control plane.
  // Fail-closed default (`true`) rejects when a caller forgets to pass; the sole
  // production caller (heartbeat) passes the resolved trust boundary explicitly.
  multiTenant = true,
): Record<string, unknown> | null {
  const cfg = target.config ?? {};
  if (target.kind === "local_host") return null; // local driver, no override
  if (target.kind === "pooled_gvisor" || target.kind === "dedicated_worker") {
    if (multiTenant) {
      throw new Error(
        "Cloud execution targets are registry-only until the gVisor worker pool and Gate-B hardware validation are complete.",
      );
    }
    // Self-hosted single-tenant execution is the only direct Docker path. The
    // founder owns this host, so preserve its authored callback/network profile.
    return {
      type: "sandbox-docker",
      image: (cfg.image as string) ?? "aoa/agent-base:latest",
      runtime: "runsc",
      network: (cfg.network as string) ?? "none",
      allowHostGateway: cfg.allowHostGateway === true,
      isolation: cfg.isolation ?? HARDENED_ISOLATION,
    };
  }
  return null;
}
