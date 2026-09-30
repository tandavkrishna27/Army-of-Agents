/**
 * Wave-3→4 gate clause 3 — the rollback path's limits.
 *
 * HISTORY, kept because it is the point. This file's G1 block used to pin the OPPOSITE of what
 * it pins now: that the rollout map was captured at construction, so rollback needed a restart.
 * Its failure message said "if this assertion now fails, the map has been made live — which is
 * an improvement, but the rollback runbook … must be corrected in the same change."
 *
 * MIG-002 made the map live. The pin fired, named the two documents to fix, and they were fixed
 * in that commit. The liveness assertions now live in `rollout-dial-live.test.ts` (M1/M2), which
 * is their natural home; what remains here is the part MIG-002 did NOT change — the flag's
 * behaviour at the hook, and the fact that it still cannot unregister the worker control plane.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDistributedExecutionRolloutSource } from "../config/distributed-execution-rollout-source.js";
import { createHeartbeatDistributedRolloutHook } from "../services/heartbeat-distributed-rollout.js";

const ORG = "11111111-1111-4111-8111-111111111111";

function rolloutJson(mode: string | null): string {
  return JSON.stringify(mode === null ? { organizations: {} } : {
    organizations: { [ORG]: { mode, workloads: ["batch"] } },
  });
}

function resolve(source: ReturnType<typeof createDistributedExecutionRolloutSource>): string {
  return source.resolveRunRolloutState({
    deploymentMode: "cloud_auth",
    organizationId: ORG,
    workloadType: "batch",
  });
}

// ─── G2 ──────────────────────────────────────────────────────────────────────
describe("G2 — the deployment flag IS live at the heartbeat hook", () => {
  function hook(env: Record<string, string | undefined>) {
    return createHeartbeatDistributedRolloutHook({
      env,
      deploymentMode: "cloud_auth",
      rolloutSource: createDistributedExecutionRolloutSource(env),
      resolveOrganizationId: async () => ORG,
      convertOrchestrator: { convertRunToJob: async () => ({ converted: false, reason: "disabled" }) },
      comparator: { compare: () => ({}) as never },
    });
  }

  it("returns off on the NEXT call after the flag is unset, with no restart", async () => {
    const env: Record<string, string | undefined> = {
      AOA_DISTRIBUTED_EXECUTION_ENABLED: "1",
      AOA_DISTRIBUTED_EXECUTION_ROLLOUT: rolloutJson("canary"),
    };
    const h = hook(env);
    expect((await h.resolveRunRolloutState({ companyId: "c-1" })).state).toBe("canary");

    env.AOA_DISTRIBUTED_EXECUTION_ENABLED = "0";

    // The hook checks the flag ITSELF, before consulting the source at all. That mattered
    // more before MIG-002 (when the source's own copy was stale); it still matters because
    // flag-first is what guarantees no Organization is resolved for a flag-off deployment.
    const after = await h.resolveRunRolloutState({ companyId: "c-1" });
    expect(after.state).toBe("off");
    // Flag-first: no Organization is resolved when the flag is off.
    expect(after.organizationId).toBeNull();
  });

  it("both levers are live now — what still differs is SCOPE, not latency", async () => {
    // Before MIG-002 these two edits had different latency: the flag was live at the hook, the
    // map needed a restart. Both are live now, so the operator-facing distinction is scope —
    // the flag stops every Organization, a map edit stops one.
    const env: Record<string, string | undefined> = {
      AOA_DISTRIBUTED_EXECUTION_ENABLED: "1",
      AOA_DISTRIBUTED_EXECUTION_ROLLOUT: rolloutJson("canary"),
    };
    const h = hook(env);
    const source = createDistributedExecutionRolloutSource(env);

    env.AOA_DISTRIBUTED_EXECUTION_ROLLOUT = rolloutJson(null); // one Organization, live
    expect((await h.resolveRunRolloutState({ companyId: "c-1" })).state).toBe("off");
    expect(resolve(source)).toBe("off");

    env.AOA_DISTRIBUTED_EXECUTION_ROLLOUT = rolloutJson("canary");
    expect((await h.resolveRunRolloutState({ companyId: "c-1" })).state).toBe("canary");

    env.AOA_DISTRIBUTED_EXECUTION_ENABLED = "0"; // everything, live
    expect((await h.resolveRunRolloutState({ companyId: "c-1" })).state).toBe("off");
  });
});

// ─── MIG-002 seam ────────────────────────────────────────────────────────────
const HEARTBEAT_SRC = readFileSync(
  fileURLToPath(new URL("../services/heartbeat.ts", import.meta.url)),
  "utf8",
);

describe("MIG-002 — the org heartbeat seam names its own sink", () => {
  function hookWithSources(sources: string[]) {
    const env: Record<string, string | undefined> = {
      AOA_DISTRIBUTED_EXECUTION_ENABLED: "1",
      AOA_DISTRIBUTED_EXECUTION_ROLLOUT: JSON.stringify({
        organizations: { [ORG]: { mode: "canary", workloads: ["batch"], sources } },
      }),
    };
    return createHeartbeatDistributedRolloutHook({
      env,
      deploymentMode: "cloud_auth",
      rolloutSource: createDistributedExecutionRolloutSource(env),
      resolveOrganizationId: async () => ORG,
      convertOrchestrator: { convertRunToJob: async () => ({ converted: false, reason: "disabled" }) },
      comparator: { compare: () => ({}) as never },
    });
  }

  it("is OFF for an Organization canaried only for Commander", async () => {
    // The Wave-4 ordering in one assertion: Commander can be canaried without arming the org
    // heartbeat. Before MIG-002 this was inexpressible — every sink resolved to "batch".
    const h = hookWithSources(["commander_turn"]);
    expect((await h.resolveRunRolloutState({ companyId: "c-1", sourceKind: "task_run" })).state).toBe("off");
  });

  it("is ON once task_run joins the list", async () => {
    const h = hookWithSources(["commander_turn", "task_run"]);
    expect((await h.resolveRunRolloutState({ companyId: "c-1", sourceKind: "task_run" })).state).toBe("canary");
  });

  it("and heartbeat.ts actually PASSES its sink — the resolver cannot filter what it is not told", () => {
    // A behavioural test of the hook proves the filter works; only this proves the one
    // production caller uses it. Without it the seam would silently opt into every sink.
    const callAt = HEARTBEAT_SRC.indexOf("distributedRolloutHook.resolveRunRolloutState({");
    expect(callAt).toBeGreaterThan(-1);
    const call = HEARTBEAT_SRC.slice(callAt, callAt + 500);
    expect(
      call,
      "the org heartbeat must identify itself as task_run, or an Organization opted in for one " +
        "sink would arm this one too",
    ).toMatch(/sourceKind:\s*"task_run"/);
  });
});

// ─── G3 ──────────────────────────────────────────────────────────────────────
const APP_SRC = readFileSync(fileURLToPath(new URL("../app.ts", import.meta.url)), "utf8");

describe("G3 — unsetting the flag does not unregister the worker control plane", () => {
  it("gates the worker control routes at app construction, not per request", () => {
    // This is why the flag is NOT the headline rollback lever: it stops the control plane
    // minting new distributed work from the heartbeat, while workers keep polling and leasing
    // until a restart. The genuinely live stop for that half is the REL-004 kill switch.
    expect(APP_SRC).toMatch(/if \(opts\.distributedExecutionEnabled\) \{/);
    const gateAt = APP_SRC.indexOf("if (opts.distributedExecutionEnabled) {");
    const routesAt = APP_SRC.indexOf("api.use(workerControlRoutes({");
    expect(gateAt).toBeGreaterThan(-1);
    expect(routesAt).toBeGreaterThan(gateAt);
    // `opts.` — a value passed in at construction, never `process.env` read per request.
    expect(
      APP_SRC,
      "if the worker-control gate ever reads process.env per request, the flag becomes a real " +
        "master switch and step 2 of the rollback runbook can be simplified",
    ).not.toMatch(/workerControlRoutes[\s\S]{0,400}process\.env\.AOA_DISTRIBUTED_EXECUTION_ENABLED/);
  });
});
