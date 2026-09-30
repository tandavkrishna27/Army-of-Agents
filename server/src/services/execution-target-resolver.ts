// server/src/services/execution-target-resolver.ts
import { or, isNull, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@armyofagents/db";
import { executionTargets } from "@armyofagents/db";
import {
  canonicalizeJsonV1,
  registeredTargetProfileV1Schema,
  verifyAndBrandProviderConstraintProfileV1,
  type RegisteredTargetProfileV1,
  type VerifiedProviderConstraintProfileV1,
} from "@armyofagents/worker-protocol";

export interface ExecutionTargetRow {
  id: string;
  slug: string;
  kind: string;
  trustClass: string;
  status: string;
  organizationId: string | null;
  ownerUserId?: string | null;
  scope?: string;
  targetAuthorityKey?: string;
  deviceGeneration?: number;
  registeredProfile?: Record<string, unknown> | null;
  registeredProfileHash?: string | null;
  providerConstraintProfile?: Record<string, unknown> | null;
  lastSeenAt?: Date | null;
  config?: Record<string, unknown>;
}

export interface NormalizedPlacementRegistryTarget {
  id: string;
  scope: RegisteredTargetProfileV1["scope"];
  ownerUserId: string | null;
  targetAuthorityKey: string;
  deviceGeneration: number;
  registeredProfileHash: string;
  targetId: string;
  targetSlug: string;
  targetClass: RegisteredTargetProfileV1["targetClass"];
  targetScope: RegisteredTargetProfileV1["scope"];
  targetGeneration: number;
  profileHash: string;
  providerConstraintHash: string;
  status: string;
  lastSeenAt: Date | null;
  registeredProfile: RegisteredTargetProfileV1;
  providerConstraintProfile: VerifiedProviderConstraintProfileV1;
}

const TARGET_KIND_BY_CLASS = {
  managed_cloud: new Set(["pooled_gvisor", "e2b"]),
  organization_dedicated: new Set(["dedicated_worker"]),
  owner_desktop: new Set(["desktop", "local_host"]),
} as const;

/**
 * The closed placement-provider vocabulary, DERIVED from the class map above so it cannot drift
 * from the kinds normalization will accept.
 *
 * REL-004 Lane C (D6) passes this to `evaluateKillSwitches`, which refuses a provider switch
 * naming a value outside it. A mistyped value would otherwise match nothing and silently
 * permit — the same hazard that module already refuses for a mistyped `dimension`.
 */
export const EXECUTION_TARGET_KINDS: readonly string[] = Object.freeze(
  [...new Set(Object.values(TARGET_KIND_BY_CLASS).flatMap((kinds) => [...kinds]))].sort(),
);

const LEGACY_TRUST_BY_CLASS = {
  managed_cloud: "shared_multitenant",
  organization_dedicated: "dedicated_tenant",
  owner_desktop: "local_trusted",
} as const;

const PLACEMENT_SCOPE_PRIORITY = {
  platform: 0,
  organization: 1,
  owner: 2,
} as const;

const PLACEMENT_CLASS_PRIORITY = {
  managed_cloud: 0,
  organization_dedicated: 1,
  owner_desktop: 2,
} as const;

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Stable pre-resolution order for Decision #117. The resolver keeps all of
 * its existing pin/credential semantics; this only removes repository/heap
 * enumeration as an authority input. Invalid or missing registered profiles
 * sort after mapped authority and still fail closed during normalization.
 */
export function sortExecutionTargetRowsForPlacement(
  targets: readonly ExecutionTargetRow[],
): ExecutionTargetRow[] {
  const authority = (target: ExecutionTargetRow) => {
    const parsed = registeredTargetProfileV1Schema.safeParse(target.registeredProfile);
    if (!parsed.success) return { scope: 3, targetClass: 3 };
    return {
      scope: PLACEMENT_SCOPE_PRIORITY[parsed.data.scope],
      targetClass: PLACEMENT_CLASS_PRIORITY[parsed.data.targetClass],
    };
  };
  return [...targets].sort((left, right) => {
    const leftAuthority = authority(left);
    const rightAuthority = authority(right);
    return leftAuthority.scope - rightAuthority.scope
      || leftAuthority.targetClass - rightAuthority.targetClass
      || compareStableText(left.slug, right.slug)
      || compareStableText(left.id, right.id);
  });
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Normalize one bounded registry row into the frozen E1 placement vocabulary.
 * Missing legacy profiles stay unmapped. Every duplicated identity/scope/class
 * fact must agree, so neither a legacy row nor a worker report can promote it.
 */
export async function normalizePlacementRegistryTarget(
  row: ExecutionTargetRow,
): Promise<NormalizedPlacementRegistryTarget | null> {
  if (!row.registeredProfile || !row.providerConstraintProfile || !row.registeredProfileHash) {
    return null;
  }
  const parsed = registeredTargetProfileV1Schema.safeParse(row.registeredProfile);
  if (!parsed.success) return null;
  const profile = parsed.data;
  const provider = await verifyAndBrandProviderConstraintProfileV1(
    row.providerConstraintProfile,
    (bytes) => sha256(bytes),
  );
  if (!provider) return null;

  const calculatedProfileHash = sha256(canonicalizeJsonV1(profile));
  if (calculatedProfileHash !== row.registeredProfileHash) return null;
  if (String(profile.targetId) !== row.id) return null;
  if (profile.organizationId !== row.organizationId) return null;
  if (profile.ownerPrincipalId !== (row.ownerUserId ?? null)) return null;
  if (profile.scope !== row.scope) return null;
  if (profile.deviceGeneration !== row.deviceGeneration) return null;
  if (!TARGET_KIND_BY_CLASS[profile.targetClass].has(row.kind as never)) return null;
  if (LEGACY_TRUST_BY_CLASS[profile.targetClass] !== row.trustClass) return null;
  if (profile.providerConstraints.profileId !== provider.profileId) return null;
  if (profile.providerConstraints.version !== provider.version) return null;
  if (profile.providerConstraints.digest !== provider.digest) return null;

  const expectedAuthority = profile.scope === "platform"
    ? "platform"
    : profile.scope === "organization"
      ? `organization:${profile.organizationId}`
      : `owner:${profile.organizationId}:${profile.ownerPrincipalId}`;
  if (row.targetAuthorityKey !== expectedAuthority) return null;

  return {
    id: row.id,
    scope: profile.scope,
    ownerUserId: row.ownerUserId ?? null,
    targetAuthorityKey: row.targetAuthorityKey,
    deviceGeneration: profile.deviceGeneration,
    registeredProfileHash: calculatedProfileHash,
    targetId: row.id,
    targetSlug: row.slug,
    targetClass: profile.targetClass,
    targetScope: profile.scope,
    targetGeneration: profile.deviceGeneration,
    profileHash: calculatedProfileHash,
    providerConstraintHash: String(provider.digest),
    status: row.status,
    lastSeenAt: row.lastSeenAt ?? null,
    registeredProfile: profile,
    providerConstraintProfile: provider,
  };
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
  // A non-subscription binding that NAMES an execution target (slug set; not a
  // personal_subscription credential, guaranteed by the early return above) routes to
  // the org's tenant-creatable `dedicated_worker` of that slug. This is the E7-1 canary
  // path (E11-F004): the canary presents a null-credential binding plus a well-known slug
  // (CANARY_EXECUTION_TARGET_SLUG), and an operator CAN create + ratify a `dedicated_worker`
  // at organization scope — whereas the `pooled_gvisor`/`managed_cloud`/`platform` target a
  // null-credential binding used to fall through to has NO tenant create+ratify path at all.
  // Placement requirements are derived from the resolved target's ratified profile, so
  // routing here makes them org-scoped automatically and a keyed run yields a real
  // distributed placement instead of `placement_not_leasable` → legacy.
  //
  // `dedicated_worker`-restricted + `?? null` on purpose (DE-29, "no silent broadening"):
  // a named-but-absent target resolves to NOTHING — never the `pooled_gvisor` fallthrough,
  // never a throw. A `dedicated_worker` row can ONLY normalize as `organization_dedicated`
  // (TARGET_KIND_BY_CLASS above), so this arm can never reach an `owner_desktop` target; the
  // owner-misrouting class the pin/personal_subscription branches guard stays excluded here too.
  //
  // SCOPED TO THE NULL-CREDENTIAL (canary) SHAPE — `!input.credentialKind`. The canary binding
  // carries a slug with NO credentialKind; this arm exists for exactly that. A CREDENTIALED
  // slug-bearing binding (e.g. a `company_api_key` heartbeat binding, which `toExecutionTargetHint`
  // can emit with `executionTargetSlug = execution_target_id`) intentionally FALLS THROUGH to the
  // shared `pooled_gvisor` pool below — its pre-E11-F004 behaviour — so this arm cannot silently
  // divert a keyed/business binding off the pool. (No current writer produces such a binding, but
  // scoping it here keeps the arm's blast radius exactly the canary and matches its stated intent.)
  if (!input.credentialKind && input.executionTargetSlug) {
    return active.find((t) => t.kind === "dedicated_worker" && t.slug === input.executionTargetSlug) ?? null;
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
  // local_host is the one legitimate null: the local driver IS the default, so there is
  // nothing to override. Every other unhandled kind used to reach the bare `return null`
  // at the end of this function, and null means "no adapter override" — i.e. the run
  // executed on the CONTROL-PLANE host, which is precisely what an execution target
  // exists to prevent. See DSK-001 Lane C / F28.
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

  // EXHAUSTIVE FROM HERE. `desktop` and `e2b` belong to the DISTRIBUTED placement system
  // rather than this legacy adapter path — `TARGET_KIND_BY_CLASS` above maps
  // `managed_cloud -> {pooled_gvisor, e2b}` and `owner_desktop -> {desktop, local_host}`,
  // and E2B execution itself runs through `environments` with `provider: "e2b"`
  // (`environment-runtime.ts`), keyed on the ENVIRONMENT provider, not on the target
  // kind. So neither kind has a legacy adapter representation, and falling through to
  // null never meant "handled elsewhere" — it meant "runs here, unsandboxed".
  //
  // Fail-closed is the right direction: the heartbeat's routing `.catch()` does not wrap
  // this call, so the throw propagates and fails the run. A failed run beats a run
  // executing on the control plane with a desktop target.
  //
  // NO COMPILE-TIME `never` HERE, deliberately. `ExecutionTargetRow.kind` is `string`
  // because the column is `text("kind")` with only a COMMENT listing the five values and
  // NO CHECK constraint (`schema/execution_targets.ts:33`) — the database really can hold
  // an unknown kind. An exhaustiveness assertion would be claiming a guarantee the data
  // layer does not provide, which is how a guard ends up decorative.
  //
  // The guarantee that IS available: this runtime throw catches anything unhandled, and a
  // test iterating EXECUTION_TARGET_KINDS catches drift in the known set — so adding a
  // sixth kind without handling it fails a test rather than going quiet.
  if (target.kind === "desktop" || target.kind === "e2b") {
    throw new Error(
      `Execution target kind "${target.kind}" has no control-plane adapter configuration. ` +
        "It is placed through the distributed worker path, so running it here would " +
        "execute on the control-plane host.",
    );
  }
  throw new Error(`Unhandled execution target kind ${JSON.stringify(target.kind)}.`);
}
