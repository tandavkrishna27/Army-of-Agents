// server/src/config/distributed-execution-rollout-source.ts
//
// CLI-005 (D1 / O4) — the minimal, server-owned, config-driven per-Organization /
// per-workload rollout policy source that feeds the otherwise-stubbed org+workload
// inputs of `resolveDistributedExecutionRollout` (config/distributed-execution.ts).
//
// It exists ONLY to make the three rollout states (`off | shadow | active`) reachable
// for a heartbeat run without a new table or migration (a richer policy store is
// JOB-007 / MIG-002). It is DEFAULT-DISABLED: with `AOA_DISTRIBUTED_EXECUTION_ROLLOUT`
// unset (or `{}`), every Organization resolves to `off`, so the legacy adapter stays the
// sole authoritative executor and every current path is byte-identical.
//
// Format (JSON in the env var):
//   {
//     "organizations": {
//       "<organizationId>": { "mode": "shadow" | "active", "workloads": ["batch", "*"] }
//     }
//   }
// An Organization absent from the map is disabled. A workload absent from an enabled
// Organization's `workloads` list (and no "*") is disabled. `mode` is one of
// `shadow` | `active` | `canary` for that Organization's enabled workloads
// (CLI-006 added `canary`; see the `RolloutMode` doc comment below).
//
// The deployment gate (`AOA_DISTRIBUTED_EXECUTION_ENABLED`, default-off) is checked
// FIRST by `resolveRunRolloutState`, so this source can never enable distributed
// execution on a deployment that has not opted in.

import type { DeploymentMode } from "@armyofagents/shared";
import { EXECUTION_SOURCE_KINDS } from "@armyofagents/worker-protocol";
import {
  readDistributedExecutionDeploymentFlag,
  resolveDistributedExecutionRollout,
} from "./distributed-execution.js";

export const DISTRIBUTED_EXECUTION_ROLLOUT_ENV = "AOA_DISTRIBUTED_EXECUTION_ROLLOUT";

type Env = Record<string, string | undefined>;

/**
 * CLI-006 (D1) adds `canary` as a strict superset of `active`: everything `active`
 * does (durable convert + the ONE checkout), PLUS placement (making the attempt
 * leasable) and suppression of the legacy `adapter.execute`. It is a distinct mode
 * rather than an overload so CLI-005's landed `active` semantics keep their exact
 * meaning and rollback stays unambiguous (delete the key, or set `active`).
 */
export type RolloutMode = "shadow" | "active" | "canary";
/**
 * The vocabulary the PLACEMENT boundary accepts. `job-placement.ts` validates
 * `["active","shadow"].includes(rollout.mode)` (`:589`) and gates leasability on
 * `mode === "active"` (`:663`), so `canary` is presented there as `active`
 * (see `resolveOrganizationPolicy`). Placement is E3-owned and is not edited.
 */
export type PlacementRolloutMode = "shadow" | "active";
/** The resolved per-run rollout state a caller acts on. */
export type RunRolloutState = "off" | "shadow" | "active" | "canary";

export interface OrganizationRolloutPolicy {
  readonly mode: RolloutMode;
  /** The set of workload types this Organization has opted in; `*` means all. */
  readonly workloads: ReadonlySet<string>;
  /**
   * MIG-002 — the per-SINK axis. The set of execution SOURCE KINDS this Organization has
   * opted in (`*` means all). **`undefined` means all**, which is what every pre-MIG-002
   * config has, so an existing deployment behaves byte-identically.
   *
   * This axis exists because all four cutover sinks resolve to `workloadType: "batch"`, so
   * `workloads` alone cannot express the Wave-4 "MIG-005 then MIG-006 then MIG-007, lowest
   * blast radius first" ordering. `sourceKind` was already on the placement resolver's
   * contract (`job-placement.ts:392-397`) and already passed by placement; it was simply
   * discarded. Nothing in the FROZEN `packages/worker-protocol` changes.
   */
  readonly sources?: ReadonlySet<string>;
}

export interface DistributedExecutionRolloutSource {
  /**
   * Placement-service-compatible org resolver (default `{ enabled:false }`).
   * Returns placement's vocabulary, so a `canary` Organization is reported here
   * as `active` — that is what makes its attempt lease-eligible.
   */
  resolveOrganizationPolicy(input: {
    organizationId: string;
  }): { enabled: boolean; mode: PlacementRolloutMode };
  /**
   * Placement-service-compatible workload resolver (default `false`).
   *
   * `sourceKind` is the MIG-002 per-sink axis. It is OPTIONAL here so existing callers compile
   * unchanged, but the placement service has always passed it (`job-placement.ts:392-397,:445`)
   * — this implementation simply used to discard it.
   */
  resolveWorkloadPolicy(input: {
    organizationId: string;
    workloadType: string;
    sourceKind?: string;
  }): boolean;
  /**
   * Resolve one heartbeat run to `off | shadow | active`. The deployment flag is
   * consulted FIRST — a flag-off deployment always resolves `off` regardless of the
   * rollout map, so nothing here can defeat the default-off gate.
   */
  resolveRunRolloutState(input: {
    deploymentMode: DeploymentMode;
    organizationId: string;
    workloadType: string;
    /** MIG-002 per-sink axis; omitted means "do not filter by sink". */
    sourceKind?: string;
  }): RunRolloutState;
  /**
   * Number of times the rollout string has actually been parsed. Exposed only so the memo can
   * be asserted directly — counting parses is the one property that cannot be observed from the
   * resolvers' return values, and a memo nothing checks silently stops memoizing.
   */
  __parseCountForTests?(): number;
}

class DistributedExecutionRolloutSourceConfigError extends Error {
  constructor(message: string) {
    super(`${DISTRIBUTED_EXECUTION_ROLLOUT_ENV} is invalid: ${message}`);
    this.name = "DistributedExecutionRolloutSourceConfigError";
  }
}

/**
 * Parse the rollout map from an env bag. Empty/unset → an empty map (all Organizations
 * disabled). Throws `DistributedExecutionRolloutSourceConfigError` on malformed JSON or
 * shape so a misconfiguration fails loudly at startup validation rather than silently
 * disabling the rollout at runtime.
 */
export function parseDistributedExecutionRolloutMap(
  env: Env,
): Map<string, OrganizationRolloutPolicy> {
  const raw = env[DISTRIBUTED_EXECUTION_ROLLOUT_ENV]?.trim();
  const map = new Map<string, OrganizationRolloutPolicy>();
  if (!raw) return map;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DistributedExecutionRolloutSourceConfigError("value is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DistributedExecutionRolloutSourceConfigError("value must be a JSON object");
  }
  const organizations = (parsed as Record<string, unknown>).organizations;
  if (organizations === undefined) return map;
  if (typeof organizations !== "object" || organizations === null || Array.isArray(organizations)) {
    throw new DistributedExecutionRolloutSourceConfigError("`organizations` must be an object");
  }

  for (const [organizationId, value] of Object.entries(organizations as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new DistributedExecutionRolloutSourceConfigError(
        `organization ${organizationId} must be an object`,
      );
    }
    const record = value as Record<string, unknown>;
    const mode = record.mode;
    if (mode !== "shadow" && mode !== "active" && mode !== "canary") {
      throw new DistributedExecutionRolloutSourceConfigError(
        `organization ${organizationId} mode must be "shadow", "active", or "canary"`,
      );
    }
    const workloadsRaw = record.workloads ?? [];
    if (!Array.isArray(workloadsRaw) || workloadsRaw.some((w) => typeof w !== "string")) {
      throw new DistributedExecutionRolloutSourceConfigError(
        `organization ${organizationId} workloads must be a string array`,
      );
    }
    // MIG-002: `sources` is OPTIONAL and absent means ALL sinks. An unknown kind fails the
    // parse loudly, exactly as an unknown `mode` does — an old binary reading a newer config
    // must refuse rather than silently route a sink it does not understand.
    const sourcesRaw = record.sources;
    let sources: Set<string> | undefined;
    if (sourcesRaw !== undefined) {
      if (!Array.isArray(sourcesRaw) || sourcesRaw.some((k) => typeof k !== "string")) {
        throw new DistributedExecutionRolloutSourceConfigError(
          `organization ${organizationId} sources must be a string array`,
        );
      }
      for (const kind of sourcesRaw as string[]) {
        if (kind !== "*" && !(EXECUTION_SOURCE_KINDS as readonly string[]).includes(kind)) {
          throw new DistributedExecutionRolloutSourceConfigError(
            `organization ${organizationId} sources contains an unknown execution source kind "${kind}"`,
          );
        }
      }
      sources = new Set(sourcesRaw as string[]);
    }
    map.set(organizationId, {
      mode,
      workloads: new Set(workloadsRaw as string[]),
      ...(sources ? { sources } : {}),
    });
  }
  return map;
}

/** Validate the rollout source config once at startup (loud failure on malformed input). */
export function assertDistributedExecutionRolloutSourceValid(env: Env): void {
  parseDistributedExecutionRolloutMap(env);
}

/**
 * Build the config-driven rollout source. Parsing happens ONCE at construction; the
 * returned resolvers are pure and effect-free.
 */
export function createDistributedExecutionRolloutSource(
  env: Env = process.env,
  options: {
    /**
     * Reports a malformed value ONCE per distinct bad string. A callback rather than a logger
     * import because this module's static graph is deliberately logger-free — importing the
     * logger here would bind it for every early importer, the trap `job-submission.ts` already
     * documents.
     */
    onParseError?: (message: string, rawValue: string) => void;
  } = {},
): DistributedExecutionRolloutSource {
  // MIG-002: the map and the flag are read PER CALL, memoized on the raw string, so a rollback
  // takes effect with no restart. Both move together — a half-migration (live map, captured
  // flag) is exactly the divergence this is meant to remove.
  //
  // Consistency is structural, not engineered: `index.ts` passes `resolveOrganizationPolicy`
  // and `resolveWorkloadPolicy` BY REFERENCE into the placement service and holds this same
  // object for the run seam, so there is one source of truth and one moment of reading it.
  let memoRaw: string | undefined;
  let memoMap: Map<string, OrganizationRolloutPolicy> = new Map();
  let parseCount = 0;

  function currentMap(): Map<string, OrganizationRolloutPolicy> {
    const raw = env[DISTRIBUTED_EXECUTION_ROLLOUT_ENV] ?? "";
    if (raw === memoRaw) return memoMap;
    try {
      const next = parseDistributedExecutionRolloutMap(env);
      parseCount += 1;
      memoRaw = raw;
      memoMap = next;
      return memoMap;
    } catch (error) {
      // A bad edit now lands on a RUNNING process. Fail CLOSED to legacy — the safe executor —
      // rather than throwing into a live run, and report once per distinct bad value so a
      // per-call re-read cannot flood the log. Startup validation is unchanged and still loud.
      // Storing the bad value in the memo is what bounds the report to ONCE per distinct
      // value: every later call with the same string short-circuits above and never reaches
      // here. A separate `reportedRaw` flag was tried and mutation proved it redundant —
      // dead state that reads like a guard. If the memo write below is ever removed, the
      // report floods once per run, which is what the "once per distinct bad value" test
      // exists to catch.
      memoRaw = raw;
      memoMap = new Map();
      options.onParseError?.(error instanceof Error ? error.message : String(error), raw);
      return memoMap;
    }
  }

  function organizationPolicy(organizationId: string): OrganizationRolloutPolicy | undefined {
    return currentMap().get(organizationId);
  }

  function workloadEnabled(
    policy: OrganizationRolloutPolicy | undefined,
    workloadType: string,
    sourceKind?: string,
  ): boolean {
    if (!policy) return false;
    if (!(policy.workloads.has("*") || policy.workloads.has(workloadType))) return false;
    // `sources` absent => all sinks (pre-MIG-002 behaviour). A caller that supplies no
    // sourceKind is likewise unfiltered, so existing callers are unchanged.
    if (!policy.sources || sourceKind === undefined) return true;
    return policy.sources.has("*") || policy.sources.has(sourceKind);
  }

  return {
    resolveOrganizationPolicy({ organizationId }) {
      const policy = organizationPolicy(organizationId);
      if (!policy) return { enabled: false, mode: "shadow" };
      // CLI-006 (D1): `canary` is presented to placement as `active` — that is the
      // whole mechanism by which a canary attempt becomes lease-eligible without
      // touching the E3-owned placement module. The canary DISTINCTION is carried
      // on the ownership decision + job provenance, not on the placement mode.
      return { enabled: true, mode: policy.mode === "canary" ? "active" : policy.mode };
    },
    resolveWorkloadPolicy({ organizationId, workloadType, sourceKind }) {
      // MIG-002: `sourceKind` was always on this contract (job-placement.ts:392-397) and always
      // passed by placement; it was simply discarded here.
      return workloadEnabled(organizationPolicy(organizationId), workloadType, sourceKind);
    },
    resolveRunRolloutState({ deploymentMode, organizationId, workloadType, sourceKind }) {
      const policy = organizationPolicy(organizationId);
      const decision = resolveDistributedExecutionRollout({
        deploymentMode,
        deploymentEnabled: readDistributedExecutionDeploymentFlag(env),
        organizationEnabled: policy !== undefined,
        workloadEnabled: workloadEnabled(policy, workloadType, sourceKind),
      });
      if (!decision.enabled) return "off";
      // `policy` is defined here (organizationEnabled was true).
      return policy!.mode;
    },
    __parseCountForTests: () => parseCount,
  };
}
