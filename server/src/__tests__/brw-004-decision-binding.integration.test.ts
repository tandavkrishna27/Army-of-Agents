// BRW-004 slice (d) / E8-F002 — migration 0272's CHECK, executed against a REAL Postgres.
//
// (Embedded PG; Linux CI is the formal authority, SKIPPED locally on Windows unless
// AOA_RUN_WIN_INTEGRATION=1 — the same gate the JOB-011 parity suite uses.)
//
// ★★★ WHY THIS FILE EXISTS AT ALL. The unit tests in
// `brw-004-distributed-decision-binding.test.ts` prove the SERVICE handles a null-bound decision.
// They cannot prove anything about the constraint, because they never touch Postgres: a CHECK that
// was never emitted, or emitted with a predicate that is always true, would leave every one of them
// green. `(agent_id IS NULL) = (run_id IS NULL)` is the whole reason the relaxation is safe — the
// schema comment calls it "the point" — and until something inserts a HALF-BOUND row and is
// rejected, that claim is a comment, not an enforcement.
//
// So this is the CHECK's positive control, in the strict sense the programme means:
//   * a half-bound row (agent, no run) must be REJECTED  -> the guard fires;
//   * a half-bound row (run, no agent) must be REJECTED  -> both directions, not just one;
//   * a fully-bound legacy row must be ACCEPTED          -> the guard is not simply rejecting all;
//   * a fully-null distributed row must be ACCEPTED      -> the relaxation actually happened.
//
// The last two are what stop "the CHECK works" from being indistinguishable from "the columns are
// still NOT NULL and everything fails", which is exactly how a fail-closed constraint reads when it
// is over-tight.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { setupJobControlFixture, COMPANY, type JobControlFixture } from "./helpers/job-control-fixture.js";

const AGENT = "a6000000-0000-4000-8000-0000000000b1";

let fixture: JobControlFixture | null = null;
let setupError: unknown = null;

function guard(): void {
  if (setupError) throw new Error(`fixture setup failed: ${String(setupError)}`);
}

/** Insert one decision row directly, bypassing the service, so the DB is the only judge. */
async function insertDecision(agentId: string | null, runId: string | null): Promise<void> {
  await fixture!.admin`
    INSERT INTO agent_runtime_decisions
      (id, company_id, agent_id, run_id, adapter_type, kind, status, nonce,
       prompt_hash, title, timeout_policy)
    VALUES (${randomUUID()}, ${COMPANY}, ${agentId}, ${runId}, 'claude_local', 'permission',
            'created', ${randomUUID()}, 'hash', 'Allow navigation?', 'deny')`;
}

beforeAll(async () => {
  try {
    fixture = await setupJobControlFixture("brw004-binding");
    await fixture.admin`INSERT INTO agents (id, company_id, name, kind, status, adapter_type, adapter_config)
      VALUES (${AGENT}, ${COMPANY}, 'BRW004 Agent', 'org', 'idle', 'claude_local', ${fixture.admin.json({})})`;
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  await fixture?.teardown().catch(() => {});
}, 60_000);

beforeEach(async () => {
  if (!fixture) return;
  await fixture.admin`DELETE FROM agent_runtime_trust_rules`;
  await fixture.admin`DELETE FROM agent_runtime_decisions`;
  await fixture.admin`DELETE FROM heartbeat_runs`;
});

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "BRW-004 / E8-F002 — the all-or-nothing legacy binding CHECK (migration 0272)",
  () => {
    it("★ a fully-NULL distributed decision is ACCEPTED — the relaxation actually happened", async () => {
      guard();
      // Before 0272 this was impossible: both columns were NOT NULL. If this fails, nothing
      // else in slice (d) means anything, because the aggregate still cannot hold the row the
      // shipped governance matrix designates for a browser_request.
      await insertDecision(null, null);
      const [row] = await fixture!.admin`SELECT count(*)::int AS n FROM agent_runtime_decisions`;
      expect((row as { n: number }).n).toBe(1);
    });

    it("★ a fully-BOUND legacy decision is still ACCEPTED — the CHECK is not rejecting everything", async () => {
      guard();
      const runId = randomUUID();
      await fixture!.admin`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, started_at)
        VALUES (${runId}, ${COMPANY}, ${AGENT}, 'running', now())`;
      await insertDecision(AGENT, runId);
      const [row] = await fixture!.admin`SELECT count(*)::int AS n FROM agent_runtime_decisions`;
      expect((row as { n: number }).n).toBe(1);
    });

    it("★★ a HALF-BOUND row (agent, no run) is REJECTED by the CHECK", async () => {
      guard();
      await expect(insertDecision(AGENT, null)).rejects.toThrow(
        /agent_runtime_decisions_legacy_binding_all_or_nothing/,
      );
    });

    it("★★ a HALF-BOUND row (run, no agent) is REJECTED by the CHECK — both directions", async () => {
      guard();
      // Asserting only one direction would leave `agent_id IS NOT NULL OR run_id IS NULL` — a
      // strictly weaker predicate — indistinguishable from the equality the schema declares.
      const runId = randomUUID();
      await fixture!.admin`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, started_at)
        VALUES (${runId}, ${COMPANY}, ${AGENT}, 'running', now())`;
      await expect(insertDecision(null, runId)).rejects.toThrow(
        /agent_runtime_decisions_legacy_binding_all_or_nothing/,
      );
    });

    it("★ neither rejection wrote a row — a refused insert must leave nothing behind", async () => {
      guard();
      await insertDecision(AGENT, null).catch(() => {});
      const [row] = await fixture!.admin`SELECT count(*)::int AS n FROM agent_runtime_decisions`;
      expect((row as { n: number }).n).toBe(0);
    });
  },
);

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "BRW-004 / E8-F002 hazard 10 — the trust rule's agent binding (migration 0273)",
  () => {
    // ★★★ THE SIBLING TABLE. Adversarial review of PR #356 pointed at exactly this asymmetry:
    // `agent_runtime_decisions` received the all-or-nothing CHECK and `agent_runtime_trust_rules`
    // — declared immediately below it, with the same two nullable FK columns — received nothing.
    // The relaxation made an unbound trust rule REACHABLE for the first time, through browser
    // egress, and an unbound rule was a company-wide wildcard grant.
    //
    // The service refuses to mint one (unit tests). This file proves the DB refuses to HOLD one,
    // which is the difference between "unreached" and "unrepresentable" — and it is also the only
    // check that migration 0273 was applied at all rather than merely written.
    async function insertTrustRule(agentId: string | null): Promise<void> {
      await fixture!.admin`
        INSERT INTO agent_runtime_trust_rules
          (id, company_id, agent_id, adapter_type, created_by_user_id)
        VALUES (${randomUUID()}, ${COMPANY}, ${agentId}, 'claude_local', 'founder-1')`;
    }

    it("★★ an UNBOUND trust rule is REJECTED by the database", async () => {
      guard();
      // The wildcard grant, refused at the storage layer. Postgres reports a NOT NULL violation
      // as 23502 with the column name, so the assertion names the column rather than a
      // constraint identifier that does not exist for a NOT NULL.
      await expect(insertTrustRule(null)).rejects.toThrow(/agent_id/);
    });

    it("★ an AGENT-BOUND persistent rule is still ACCEPTED — run_id stays nullable", async () => {
      guard();
      // The positive control, and it is load-bearing in a way the decisions table's is not:
      // copying the sibling's `(agent_id IS NULL) = (run_id IS NULL)` here would have REJECTED
      // this row, because a persistent grant is agent-bound and run-less by design. This is the
      // test that says the two tables need DIFFERENT invariants, not the same one.
      await insertTrustRule(AGENT);
      const [row] = await fixture!.admin`
        SELECT count(*)::int AS n FROM agent_runtime_trust_rules WHERE run_id IS NULL`;
      expect((row as { n: number }).n).toBe(1);
    });

    it("★ the refused insert left nothing behind", async () => {
      guard();
      await insertTrustRule(null).catch(() => {});
      const [row] = await fixture!.admin`SELECT count(*)::int AS n FROM agent_runtime_trust_rules`;
      expect((row as { n: number }).n).toBe(0);
    });
  },
);
