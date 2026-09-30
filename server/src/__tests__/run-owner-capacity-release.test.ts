/**
 * A converted attempt that is never placed holds an org capacity slot FOREVER, and that slot
 * throttles the Organization's LEGACY runs.
 *
 * The chain, each link verified:
 *   1. the convert's submit claims a slot — `job-submission.ts:296-303` calls
 *      `admitAttemptCapacity`, which sets `job_attempts.capacity_claim_state = 'held'`;
 *   2. `resolveExecutionOwner` returns `legacy("placement_not_leasable")` when placement
 *      declines (`run-execution-owner.ts:232-237`) and releases nothing;
 *   3. the attempt is then inert — never leased, so never terminalized — and the only
 *      releases are attempt-terminal, cancel-finalize, and the lease reaper
 *      (`createJobControlSweeper`, which has ZERO production callers);
 *   4. the org's capacity count is `count(*) WHERE capacity_claim_state = 'held'`
 *      (`org-concurrency.ts:116-121`), and the LEGACY heartbeat claims against that same
 *      budget via `claimQueuedRunsWithOrgCapacity` (`heartbeat.ts:2748`).
 *
 * So the first thing an operator does — arm a canary before a worker is enrolled — leaks a slot
 * on every run, and the symptom is the Organization's ordinary legacy work quietly slowing down.
 *
 * Placement declining after a successful convert is a NORMAL outcome (no eligible worker yet,
 * requirements mismatch, capacity), so this is reachable today and is not created by MIG-002's
 * live dial — the dial only adds one more way to reach it.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRunExecutionOwnerResolver } from "../services/run-execution-owner.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const ACTOR = { companyId: "22222222-2222-4222-8222-222222222222" } as never;
const SOURCE = {
  kind: "task_run",
  runId: "r-1",
  issueId: "i-1",
  assigneeAgentId: "a-1",
} as never;

function resolver(overrides: {
  disposition?: string;
  leaseEligible?: boolean;
  placeThrows?: boolean;
  releaseCapacity?: ReturnType<typeof vi.fn>;
  converted?: boolean;
}) {
  const releaseCapacity = overrides.releaseCapacity ?? vi.fn(async () => ({ released: true }));
  return {
    releaseCapacity,
    resolver: createRunExecutionOwnerResolver({
      resolveRunRolloutState: () => "canary",
      preflight: { check: async () => ({ ok: true }) } as never,
      convert: {
        convertRunToJob: async () =>
          overrides.converted === false
            ? { converted: false, reason: "submit_failed" }
            : {
                converted: true,
                reason: "submitted",
                response: { jobId: "j-1", attemptId: "at-1" },
              },
      } as never,
      placement: {
        place: async () => {
          if (overrides.placeThrows) throw new Error("placement exploded");
          return {
            disposition: overrides.disposition ?? "not_selected",
            leaseEligible: overrides.leaseEligible ?? false,
          };
        },
      },
      releaseCapacity,
    } as never),
  };
}

const RESOLVE_INPUT = {
  source: SOURCE,
  actor: ACTOR,
  organizationId: ORG,
  workloadType: "batch",
  idempotencyKey: "k-1",
  rolloutState: "canary",
} as never;

describe("a converted-but-unplaced attempt must not keep its capacity slot", () => {
  it("releases the slot when placement declines", async () => {
    const { resolver: r, releaseCapacity } = resolver({ disposition: "not_selected" });
    const owner = await r.resolve(RESOLVE_INPUT);

    expect(owner.owner).toBe("legacy");
    expect((owner as { reason: string }).reason).toBe("placement_not_leasable");
    // The run executes on legacy — that half was always right. What was missing is that the
    // durable attempt it left behind was still counted against the org's cap.
    expect(releaseCapacity).toHaveBeenCalledTimes(1);
    expect(releaseCapacity.mock.calls[0]?.[0]).toMatchObject({
      attemptId: "at-1",
      organizationId: ORG,
    });
  });

  it("releases the slot when placement selects but the attempt is not lease-eligible", async () => {
    // The CLI-005 inert state: a job exists, placement selected it, but it never becomes
    // leasable. Same leak, different disposition.
    const { resolver: r, releaseCapacity } = resolver({
      disposition: "selected",
      leaseEligible: false,
    });
    const owner = await r.resolve(RESOLVE_INPUT);
    expect(owner.owner).toBe("legacy");
    expect(releaseCapacity).toHaveBeenCalledTimes(1);
  });

  it("releases the slot when placement THROWS after a successful convert", async () => {
    // The catch-all returns legacy("transfer_error"). The convert already claimed the slot,
    // so the same leak applies to the failure path — arguably the likelier one.
    const { resolver: r, releaseCapacity } = resolver({ placeThrows: true });
    const owner = await r.resolve(RESOLVE_INPUT);
    expect(owner.owner).toBe("legacy");
    expect((owner as { reason: string }).reason).toBe("transfer_error");
    expect(releaseCapacity).toHaveBeenCalledTimes(1);
  });

  it("does NOT release when the attempt is going to be executed distributed", async () => {
    // Releasing a live attempt's slot would let the org over-subscribe its cap — the exact
    // inverse defect, and a worse one.
    const { resolver: r, releaseCapacity } = resolver({
      disposition: "selected",
      leaseEligible: true,
    });
    const owner = await r.resolve(RESOLVE_INPUT);
    expect(owner.owner).toBe("distributed");
    expect(releaseCapacity).not.toHaveBeenCalled();
  });

  it("does NOT release when there was no convert, because no slot was ever claimed", async () => {
    const { resolver: r, releaseCapacity } = resolver({ converted: false });
    const owner = await r.resolve(RESOLVE_INPUT);
    expect(owner.owner).toBe("legacy");
    expect((owner as { reason: string }).reason).toBe("convert_failed");
    expect(releaseCapacity).not.toHaveBeenCalled();
  });

  it("a failing release never changes the ownership decision", async () => {
    // Best-effort: the run has already been decided legacy. A release failure must not turn
    // that into a throw, or a capacity-table hiccup would fail live runs.
    const releaseCapacity = vi.fn(async () => {
      throw new Error("capacity table unavailable");
    });
    const { resolver: r } = resolver({ disposition: "not_selected", releaseCapacity });
    const owner = await r.resolve(RESOLVE_INPUT);
    expect(owner.owner).toBe("legacy");
    expect((owner as { reason: string }).reason).toBe("placement_not_leasable");
  });

  it("is inert when no releaseCapacity dep is composed", async () => {
    // A deployment that has not wired the release must behave exactly as before rather than
    // crashing — the same fail-safe posture as the optional ownerResolver itself.
    const r = createRunExecutionOwnerResolver({
      resolveRunRolloutState: () => "canary",
      preflight: { check: async () => ({ ok: true }) },
      convert: {
        convertRunToJob: async () => ({
          converted: true,
          reason: "submitted",
          response: { jobId: "j-1", attemptId: "at-1" },
        }),
      },
      placement: { place: async () => ({ disposition: "not_selected", leaseEligible: false }) },
    } as never);
    const owner = await r.resolve(RESOLVE_INPUT);
    expect(owner.owner).toBe("legacy");
  });
});

// ─── the wiring ──────────────────────────────────────────────────────────────
// A release that nothing composes is a fix that never runs — this session has found that
// shape four times. Pin the composition, the way the shadow port and the reaper are pinned.
describe("the composition root actually wires the release", () => {
  const SRC = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");

  it("passes releaseCapacity to the owner resolver exactly once", () => {
    expect(SRC.match(/releaseCapacity:/g) ?? []).toHaveLength(1);
  });

  it("routes it through a tenant transaction, because job_attempts is RLS-protected", () => {
    const at = SRC.indexOf("releaseCapacity:");
    const block = SRC.slice(at, at + 700);
    expect(block).toContain("runInTenant(appDb, organizationId");
    expect(block).toContain("releaseAttemptCapacity(tx,");
  });
});
