// JOB-011 — legacy product-approval / runtime-decision / completion parity (embedded PG;
// Linux CI is the formal authority, SKIPPED locally on Windows unless
// AOA_RUN_WIN_INTEGRATION=1).
//
// The bridge drives the EXISTING approval / runtime-decision authorities inside the ONE
// authoritative tenant transaction, writes a JOB-005 receipt linking the EXISTING
// aggregate (never a second one), and queues ONLY the E1 result control. These cases
// prove the load-bearing invariants: exactly-once (receipt-before-create dedup),
// fail-before-effect on an invalid default, source-scoped disposition
// (drive/inert/not_applicable), the E1 result binds to its request/action, active
// rollback writes nothing, and park_run ends the attempt + queues the compute-release.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  matchRuntimeDecisionResultToRequestV1,
  productApprovalAuthorizesActionV1,
  runtimeDecisionResultV1Schema,
} from "@armyofagents/worker-protocol";
import type { SubmitJobSource } from "@armyofagents/shared";
import {
  setupJobControlFixture,
  COMPANY,
  type JobControlFixture,
} from "./helpers/job-control-fixture.js";
import { jobApprovalBridge, type BridgeActor } from "../services/job-approval-bridge.js";

const ENABLED_ENV = { AOA_DISTRIBUTED_EXECUTION_ENABLED: "true" } as const;
const AGENT = "a6000000-0000-4000-8000-0000000000a1";
const USER = "job011-user";
const actor: BridgeActor = { kind: "user", id: USER, companyId: COMPANY };

let fixture: JobControlFixture | null = null;
let setupError: unknown = null;

function bridge() {
  return jobApprovalBridge(fixture!.app.db, { env: ENABLED_ENV });
}
function guard(): void {
  if (setupError) throw new Error(`fixture setup failed: ${String(setupError)}`);
}
async function count(table: string, where: string): Promise<number> {
  const [row] = await fixture!.admin.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`);
  return (row as { n: number }).n;
}
async function seedRun(runId: string): Promise<void> {
  await fixture!.admin`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, started_at)
    VALUES (${runId}, ${COMPANY}, ${AGENT}, 'running', now())`;
}

beforeAll(async () => {
  try {
    fixture = await setupJobControlFixture("job011-parity");
    await fixture.admin`INSERT INTO agents (id, company_id, name, kind, status, adapter_type, adapter_config)
      VALUES (${AGENT}, ${COMPANY}, 'J011 Agent', 'org', 'idle', 'claude_local', ${fixture.admin.json({})})`;
    // A human owner is required so createPrompt's hub-item emit can route to a founder.
    await fixture.admin`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES (${USER}, 'J011 User', 'j011@example.test', true, now(), now())`;
    await fixture.admin`INSERT INTO company_memberships (company_id, principal_type, principal_id, status, membership_role)
      VALUES (${COMPANY}, 'user', ${USER}, 'active', 'owner')`;
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  await fixture?.teardown().catch(() => {});
}, 60_000);

beforeEach(async () => {
  if (!fixture) return;
  // Reset the governance aggregates (agent_runtime_decisions + trust rules cascade
  // from heartbeat_runs; approvals + notifications are independent). Keep the agent.
  await fixture.admin`DELETE FROM agent_runtime_decisions`;
  await fixture.admin`DELETE FROM agent_runtime_trust_rules`;
  await fixture.admin`DELETE FROM approvals`;
  await fixture.admin`DELETE FROM notifications`;
  await fixture.admin`DELETE FROM heartbeat_runs`;
});

const TASK_SOURCE: SubmitJobSource = { kind: "task_run", runId: "seed", issueId: "seed", assigneeAgentId: AGENT };
const CREW_SOURCE: SubmitJobSource = { kind: "crew_run", crewRunId: "seed" };
const BROWSER_SOURCE: SubmitJobSource = { kind: "browser_request", browserRequestId: "seed", parentJobId: null };
const ONE_SHOT_SOURCE: SubmitJobSource = { kind: "one_shot", operationId: "seed", operationKind: "extraction" };
const COMMANDER_SOURCE: SubmitJobSource = { kind: "commander_turn", internalAgentRunId: "seed", conversationId: "seed" };

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "JOB-011 approval / runtime-decision / completion parity",
  () => {
    it("[runtime] task_run: create is exactly-once, resolve applies + queues a matching E1 result", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(1);
      const runId = randomUUID();
      const nonce = randomUUID();
      await seedRun(runId);
      const idem = randomUUID();
      const open = {
        source: TASK_SOURCE, actor, fence, idempotencyKey: idem,
        runtimeDecision: {
          agentId: AGENT, runId, adapterType: "claude_local", kind: "work_question" as const,
          nonce, title: "Approve deploy?", promptText: "Ship it?",
          options: [{ optionId: "yes", label: "Yes", value: "yes", isDefault: false }],
          timeoutPolicy: "cancel_run" as const,
        },
      };

      const first = await bridge().openGovernedDecision(open);
      expect(first.status).toBe("created");
      expect(first.aggregateId).toBeTruthy();
      expect(await count("agent_runtime_decisions", `run_id = '${runId}'`)).toBe(1);
      expect(await count("job_projection_receipts", `projection_kind = 'runtime_decision'`)).toBe(1);

      // EXACTLY-ONCE: the receipt fast-path returns the SAME aggregate without a second
      // create (approvals.create has no native dedup; the receipt identity is the guard).
      const replay = await bridge().openGovernedDecision(open);
      expect(replay.status).toBe("replayed");
      expect(replay.aggregateId).toBe(first.aggregateId);
      expect(await count("agent_runtime_decisions", `run_id = '${runId}'`)).toBe(1);
      expect(await count("job_projection_receipts", `projection_kind = 'runtime_decision'`)).toBe(1);

      // RESOLVE (allow): flips the receipt applied + queues ONE runtime_decision_result.
      const resolved = await bridge().resolveGovernedDecision({
        source: TASK_SOURCE, actor, fence, idempotencyKey: idem,
        runtimeDecision: {
          decisionId: first.aggregateId!, nonce, expectedSourceRevision: 0,
          kind: "work_question", answer: { selected: "yes" }, actorUserId: USER,
        },
      });
      expect(resolved.status).toBe("resolved");
      expect(await count("job_projection_receipts", `projection_kind = 'runtime_decision' AND status = 'applied'`)).toBe(1);
      expect(await count("job_control_commands", `command_kind = 'runtime_decision_result'`)).toBe(1);

      // The queued E1 result binds to the request the server minted.
      const [ctrl] = await fixture!.admin`SELECT command FROM job_control_commands WHERE command_kind = 'runtime_decision_result' LIMIT 1`;
      const result = runtimeDecisionResultV1Schema.parse((ctrl as { command: Record<string, unknown> }).command.result);
      const [row] = await fixture!.admin`SELECT id, nonce, prompt_hash, source_revision, expires_at, timeout_policy FROM agent_runtime_decisions WHERE id = ${first.aggregateId!}`;
      const r = row as { id: string; nonce: string; prompt_hash: string; source_revision: number; expires_at: Date; timeout_policy: string };
      const request = {
        decisionKind: "work_question" as const,
        requestId: r.id, nonce: r.nonce, requestDigest: r.prompt_hash,
        schemaVersion: 1, sourceRevision: r.source_revision,
        expiresAt: new Date(r.expires_at).toISOString(), timeoutPolicy: r.timeout_policy,
      };
      expect(matchRuntimeDecisionResultToRequestV1(request as never, result)).toEqual({ ok: true });
    });

    it("[runtime] browser_request: a permission DENY resolves to an E1 result carrying deny", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(2);
      const runId = randomUUID();
      const nonce = randomUUID();
      await seedRun(runId);
      const open = await bridge().openGovernedDecision({
        source: BROWSER_SOURCE, actor, fence, idempotencyKey: randomUUID(),
        runtimeDecision: {
          agentId: AGENT, runId, adapterType: "claude_local", kind: "permission" as const,
          nonce, title: "Allow egress?", toolName: "download", networkTarget: "example.test",
          timeoutPolicy: "deny" as const,
        },
      });
      expect(open.status).toBe("created");
      const resolved = await bridge().resolveGovernedDecision({
        source: BROWSER_SOURCE, actor, fence, idempotencyKey: randomUUID(),
        runtimeDecision: {
          decisionId: open.aggregateId!, nonce, expectedSourceRevision: 0,
          kind: "permission", decision: "deny", actorUserId: USER,
        },
      });
      expect(resolved.status).toBe("resolved");
      const [ctrl] = await fixture!.admin`SELECT command FROM job_control_commands WHERE command_kind = 'runtime_decision_result' LIMIT 1`;
      const result = runtimeDecisionResultV1Schema.parse((ctrl as { command: Record<string, unknown> }).command.result);
      expect((result as { decision?: string }).decision).toBe("deny");
    });

    it("[product] crew_run: create is exactly-once, approve applies + queues a bound product result", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(3);
      const idem = randomUUID();
      const threadId = randomUUID();
      const governedActionRef = { kind: "crew_dispatch", id: threadId };
      const open = {
        source: CREW_SOURCE, actor, fence, idempotencyKey: idem,
        productApproval: {
          type: "crew_dispatch", title: "Dispatch crew", payload: { threadId, taskIds: [] },
          requestedByUserId: USER, governedActionRef, approvalVersion: 1,
        },
      };

      const first = await bridge().openGovernedDecision(open);
      expect(first.status).toBe("created");
      expect(await count("approvals", `type = 'crew_dispatch'`)).toBe(1);
      expect(await count("job_projection_receipts", `projection_kind = 'product_approval'`)).toBe(1);

      const replay = await bridge().openGovernedDecision(open);
      expect(replay.status).toBe("replayed");
      expect(replay.aggregateId).toBe(first.aggregateId);
      expect(await count("approvals", `type = 'crew_dispatch'`)).toBe(1);
      expect(await count("job_projection_receipts", `projection_kind = 'product_approval'`)).toBe(1);

      const resolved = await bridge().resolveGovernedDecision({
        source: CREW_SOURCE, actor, fence, idempotencyKey: idem,
        productApproval: {
          approvalId: first.aggregateId!, decision: "approved", decidedByUserId: USER,
          approvalKind: "crew_dispatch", approvalVersion: 1, governedActionRef,
        },
      });
      expect(resolved.status).toBe("resolved");
      expect(await count("approvals", `id = '${first.aggregateId}' AND status = 'approved'`)).toBe(1);
      expect(await count("job_projection_receipts", `projection_kind = 'product_approval' AND status = 'applied'`)).toBe(1);
      expect(await count("job_control_commands", `command_kind = 'product_approval_result'`)).toBe(1);

      const [ctrl] = await fixture!.admin`SELECT command FROM job_control_commands WHERE command_kind = 'product_approval_result' LIMIT 1`;
      const result = (ctrl as { command: { result: Parameters<typeof productApprovalAuthorizesActionV1>[0] } }).command.result;
      // The E1 result authorizes EXACTLY the bound governed action, and nothing else.
      expect(productApprovalAuthorizesActionV1(result, governedActionRef)).toBe(true);
      expect(productApprovalAuthorizesActionV1(result, { kind: "crew_dispatch", id: randomUUID() })).toBe(false);
    });

    it("[product] crew_run: a rejection queues an E1 result carrying rejected (no dispatch)", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(4);
      const idem = randomUUID();
      const threadId = randomUUID();
      const open = await bridge().openGovernedDecision({
        source: CREW_SOURCE, actor, fence, idempotencyKey: idem,
        productApproval: {
          type: "crew_dispatch", title: "Dispatch crew", payload: { threadId, taskIds: [] },
          requestedByUserId: USER, governedActionRef: { kind: "crew_dispatch", id: threadId }, approvalVersion: 1,
        },
      });
      const resolved = await bridge().resolveGovernedDecision({
        source: CREW_SOURCE, actor, fence, idempotencyKey: idem,
        productApproval: {
          approvalId: open.aggregateId!, decision: "rejected", decidedByUserId: USER,
          approvalKind: "crew_dispatch", approvalVersion: 1, governedActionRef: { kind: "crew_dispatch", id: threadId },
        },
      });
      expect(resolved.status).toBe("resolved");
      expect(await count("approvals", `id = '${open.aggregateId}' AND status = 'rejected'`)).toBe(1);
      const [ctrl] = await fixture!.admin`SELECT command FROM job_control_commands WHERE command_kind = 'product_approval_result' LIMIT 1`;
      const decision = (ctrl as { command: { result: { decision: string } } }).command.result.decision;
      expect(decision).toBe("rejected");
    });

    it("[fail-before-effect] an invalid continue_with_default (no default option) writes NOTHING", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(5);
      const runId = randomUUID();
      const nonce = randomUUID();
      await seedRun(runId);
      await expect(
        bridge().openGovernedDecision({
          source: TASK_SOURCE, actor, fence, idempotencyKey: randomUUID(),
          runtimeDecision: {
            agentId: AGENT, runId, adapterType: "claude_local", kind: "work_question" as const,
            nonce, title: "Bad", promptText: "?",
            // continue_with_default REQUIRES exactly one isDefault option — zero fails.
            options: [{ optionId: "a", label: "A", value: "a", isDefault: false }],
            timeoutPolicy: "continue_with_default" as const,
          },
        }),
      ).rejects.toThrow();
      expect(await count("agent_runtime_decisions", `run_id = '${runId}'`)).toBe(0);
      expect(await count("job_projection_receipts", `projection_kind = 'runtime_decision'`)).toBe(0);
      expect(await count("job_control_commands", `command_kind = 'runtime_decision_result'`)).toBe(0);
    });

    it("[fail-before-effect] a forbidden persistent allow_always default writes NOTHING", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(6);
      const runId = randomUUID();
      await seedRun(runId);
      await expect(
        bridge().openGovernedDecision({
          source: BROWSER_SOURCE, actor, fence, idempotencyKey: randomUUID(),
          runtimeDecision: {
            agentId: AGENT, runId, adapterType: "claude_local", kind: "permission" as const,
            nonce: randomUUID(), title: "Bad grant", toolName: "download",
            timeoutPolicy: "continue_with_default" as const,
            // allow_always is NOT an auto-selected timeout default — the enum rejects it.
            defaultDecision: "allow_always" as unknown as "deny",
          },
        }),
      ).rejects.toThrow();
      expect(await count("agent_runtime_decisions", `run_id = '${runId}'`)).toBe(0);
    });

    it("[not_applicable] one_shot mints nothing", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(7);
      const out = await bridge().openGovernedDecision({ source: ONE_SHOT_SOURCE, actor, fence, idempotencyKey: randomUUID() });
      expect(out.status).toBe("not_applicable");
      expect(await count("job_projection_receipts", `1 = 1`)).toBe(0);
    });

    it("[inert] commander_turn is shadow — mints nothing", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(8);
      const out = await bridge().openGovernedDecision({ source: COMMANDER_SOURCE, actor, fence, idempotencyKey: randomUUID() });
      expect(out.status).toBe("inert");
      expect(await count("job_projection_receipts", `1 = 1`)).toBe(0);
      expect(await count("agent_runtime_decisions", `1 = 1`)).toBe(0);
    });

    it("[active rollback] a pre-commit failure leaves 0 aggregates + 0 receipts", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(9);
      const runId = randomUUID();
      const nonce = randomUUID();
      await seedRun(runId);
      // Force the receipt INSERT to fail AFTER the decision + fast-path — the whole
      // authoritative tenant transaction rolls back, so neither the decision nor the
      // receipt survive.
      await fixture!.admin.unsafe(`
        CREATE OR REPLACE FUNCTION j011_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'forced receipt failure'; END $$;
        DROP TRIGGER IF EXISTS j011_fail_receipt_trg ON job_projection_receipts;
        CREATE TRIGGER j011_fail_receipt_trg BEFORE INSERT ON job_projection_receipts
          FOR EACH ROW EXECUTE FUNCTION j011_fail_receipt();
      `);
      try {
        await expect(
          bridge().openGovernedDecision({
            source: TASK_SOURCE, actor, fence, idempotencyKey: randomUUID(),
            runtimeDecision: {
              agentId: AGENT, runId, adapterType: "claude_local", kind: "work_question" as const,
              nonce, title: "Rollback", promptText: "?", options: [], timeoutPolicy: "cancel_run" as const,
            },
          }),
        ).rejects.toThrow();
      } finally {
        await fixture!.admin.unsafe(`DROP TRIGGER IF EXISTS j011_fail_receipt_trg ON job_projection_receipts`);
      }
      expect(await count("agent_runtime_decisions", `run_id = '${runId}'`)).toBe(0);
      expect(await count("job_projection_receipts", `projection_kind = 'runtime_decision'`)).toBe(0);
    });

    it("[park_run] ends the fenced attempt / releases compute via a queued cancel control", async () => {
      guard();
      const { identity: fence, seeded } = await fixture!.activateLease(10);
      const out = await bridge().parkRun({
        actor, jobId: seeded.jobId, reason: "park_run", graceful: true, commandId: randomUUID(),
      });
      // A fenced worker holds the lease → cancel_requested + ONE cancel control queued
      // (the worker is told to stop; no managed compute is held while parked).
      expect(out.parked).toBe(true);
      expect(["queued", "already_requested"]).toContain(out.status);
      expect(await count("job_control_commands", `command_kind = 'cancel' AND lease_id = '${fence.leaseId}'`)).toBe(1);
      const [job] = await fixture!.admin`SELECT status FROM jobs WHERE id = ${seeded.jobId}`;
      expect((job as { status: string }).status).toBe("cancel_requested");
    });

    it("[park_run] does not mint a retry attempt (no auto-resume)", async () => {
      guard();
      // HONEST parity: park CANCELS the run (legacy fallbackPolicyOutcome returns
      // parked:true, cancelsRun:true — agent-runtime-decisions.ts:690) and does NOT
      // auto-retry. Drive the REAL parkRun and prove it mints NO attempt N+1: the job is
      // driven cancel_requested (fenced worker) and the reaper's cancel branch can never
      // resume it. A legitimate later resume rides a FRESH fence via the future
      // work-question continuation flow (out of JOB-011 scope).
      const { identity: fence, seeded } = await fixture!.activateLease(11, { maxAttempts: 3 });
      const before = await count("job_attempts", `job_id = '${seeded.jobId}'`);
      expect(before).toBe(1);

      const out = await bridge().parkRun({
        actor, jobId: seeded.jobId, reason: "park_run", graceful: true, commandId: randomUUID(),
      });
      expect(out.parked).toBe(true);
      // NO attempt N+1: the attempt count for THIS job stays 1 (park never allocates a retry).
      expect(await count("job_attempts", `job_id = '${seeded.jobId}'`)).toBe(before);
      expect(await count("job_attempts", `job_id = '${seeded.jobId}' AND attempt_number = 2`)).toBe(0);
      // The job is cancel_requested (fenced worker) or already terminal — never resumed.
      const [job] = await fixture!.admin`SELECT status FROM jobs WHERE id = ${seeded.jobId}`;
      expect(["cancel_requested", "cancelled"]).toContain((job as { status: string }).status);
      void fence;
    });

    it("[toctou] two concurrent product creates with the same idempotencyKey yield ONE approval", async () => {
      guard();
      // Fix 2 regression: the product_approval create path holds NO native dedup on
      // approvals.create; without lockActiveFence FIRST, two concurrent same-fence/same-key
      // creates both pass the receipt fast-path (0 rows) and both create an approval → a
      // live orphaned 2nd approval a founder could approve (duplicate crew_dispatch). The
      // lease lock serializes them: the 2nd blocks until the 1st commits its receipt, then
      // reads it and replays.
      //
      // Naked Promise.all is timing-dependent (the 1st tx usually commits before the 2nd
      // reads, hiding the race). To make the race DETERMINISTIC we hold a FOR UPDATE lock
      // on the SAME lease row from a side transaction: both bridge calls then block —
      // WITHOUT the fix, each blocks only at its LATER recordGovernedProjection guard,
      // AFTER it has already created an approval (→ 2 approvals when released); WITH the
      // fix, each blocks at lockActiveFence BEFORE its receipt read, so releasing the lock
      // lets the 1st create+commit and the 2nd read the receipt and replay (→ 1 approval).
      const { identity: fence } = await fixture!.activateLease(12);
      const idem = randomUUID();
      const threadId = randomUUID();
      const open = {
        source: CREW_SOURCE, actor, fence, idempotencyKey: idem,
        productApproval: {
          type: "crew_dispatch", title: "Dispatch crew", payload: { threadId, taskIds: [] },
          requestedByUserId: USER, governedActionRef: { kind: "crew_dispatch", id: threadId }, approvalVersion: 1,
        },
      };

      // Hold the lease lock from a side (superuser) transaction until both bridge calls
      // have reached their blocked state, forcing genuine overlap at the create window.
      let signalHeld!: () => void;
      const held = new Promise<void>((r) => { signalHeld = r; });
      let release!: () => void;
      const releaseP = new Promise<void>((r) => { release = r; });
      const holder = fixture!.admin.begin(async (sql) => {
        await sql`SELECT id FROM leases WHERE id = ${fence.leaseId} FOR UPDATE`;
        signalHeld();
        await releaseP;
      });
      await held;

      const pending = Promise.all([
        bridge().openGovernedDecision(open),
        bridge().openGovernedDecision(open),
      ]);
      // Give both calls time to reach their blocked state (create-then-block without the
      // fix; block-before-read with it) before releasing the lease lock. Hold well under
      // the app pool's 750ms lock_timeout (client.ts) so the blocked FOR UPDATE waits it
      // out rather than being cancelled — yet long enough (~250ms >> the few ms each call
      // needs on localhost) for both to be parked on the lease lock.
      await new Promise((r) => setTimeout(r, 250));
      release();
      await holder;
      const [a, b] = await pending;

      // One create, one replay — both resolve to the SAME aggregate.
      expect(new Set([a.status, b.status])).toEqual(new Set(["created", "replayed"]));
      expect(a.aggregateId).toBe(b.aggregateId);
      expect(await count("approvals", `company_id = '${COMPANY}' AND type = 'crew_dispatch'`)).toBe(1);
      expect(await count("job_projection_receipts", `company_id = '${COMPANY}' AND projection_kind = 'product_approval'`)).toBe(1);
    });

    it("[replay] resolving the same runtime decision twice queues ONE result control", async () => {
      guard();
      // Fix 4 regression: an idempotent answer-replay (same answerIdempotencyKey) returns
      // the already-answered row without throwing and markGovernedProjectionApplied is a
      // no-op — a FRESH randomUUID() commandId would defeat the (org, lease, command id)
      // dedup and queue a SECOND runtime_decision_result. The deterministic commandId
      // (= decision id) makes the replay dedup to ONE control command for the lease.
      const { identity: fence } = await fixture!.activateLease(13);
      const runId = randomUUID();
      const nonce = randomUUID();
      await seedRun(runId);
      const open = await bridge().openGovernedDecision({
        source: TASK_SOURCE, actor, fence, idempotencyKey: randomUUID(),
        runtimeDecision: {
          agentId: AGENT, runId, adapterType: "claude_local", kind: "work_question" as const,
          nonce, title: "Approve deploy?", promptText: "Ship it?",
          options: [{ optionId: "yes", label: "Yes", value: "yes", isDefault: false }],
          timeoutPolicy: "cancel_run" as const,
        },
      });
      expect(open.status).toBe("created");
      const answerKey = randomUUID();
      const resolveInput = {
        source: TASK_SOURCE, actor, fence, idempotencyKey: randomUUID(),
        runtimeDecision: {
          decisionId: open.aggregateId!, nonce, expectedSourceRevision: 0,
          kind: "work_question" as const, answer: { selected: "yes" }, actorUserId: USER,
          answerIdempotencyKey: answerKey,
        },
      };
      const first = await bridge().resolveGovernedDecision(resolveInput);
      const second = await bridge().resolveGovernedDecision(resolveInput);
      expect(first.status).toBe("resolved");
      expect(second.status).toBe("resolved");
      // The replay dedups: EXACTLY one runtime_decision_result queued for this lease.
      expect(await count("job_control_commands", `command_kind = 'runtime_decision_result' AND lease_id = '${fence.leaseId}'`)).toBe(1);
      // Both resolves reference the SAME deterministic control command id (= decision id).
      expect(first.controlCommandId).toBe(second.controlCommandId);
      expect(first.controlCommandId).toBe(open.aggregateId);
    });
  },
);
