// W21 / E7-F020 — arm 2 of `capabilityProven` must count DISTRIBUTED provenance only.
//
// ★★★ THIS IS A DISCRIMINATION TEST, NOT A SUPPRESSION TEST. `return 0` would satisfy any
// suite that only checks the runtime-service row stops counting, and a capability bar nobody
// can pass gets deleted. So every arm below is paired:
//
//   NEGATIVE  — a `task_outputs` row written by the ORDINARY heartbeat path
//               (`emitRuntimeServiceTaskOutput`, the E7-F020 writer) with
//               `created_by_run_id = <this run>` must NOT be counted.
//   POSITIVE  — a `task_outputs` row of genuine distributed provenance
//               (`jobOutputBridge.projectAcceptedOutput`, driven by a REAL live lease fence
//               on this run's distributed job) MUST still be counted.
//   MIXED     — both rows present for the same run counts EXACTLY ONE.
//
// Pre-fix (predicate `eq(taskOutputs.createdByRunId, run.id)`) the NEGATIVE arm and the MIXED
// arm are RED and both POSITIVE arms behave differently — that observation is what pins the
// defect. Post-fix all of them are green.
//
// ═══════════════════════════════════════════════════════════════════════════════
// ★★★ SECOND SUBJECT, SAME FILE, ON PURPOSE — E7-F030, the sibling W21 left behind.
//
// `countProducedOutputs` (arm 2) and `listRunSecretScanSurfaces` (clause 4's task_outputs
// source) are TWO consumers of one question — "which task_outputs rows belong to this
// run?" — and W21 moved only the first. A row projected through the bridge with NO
// caller-supplied run id (exactly the `[positive B]` case below, which asserts that shape
// is SUPPORTED) counted as capability evidence and was NEVER scanned for secrets, so the
// verifier could print a clean mechanism/capability verdict over a leaked key.
//
// The two consumers want OPPOSITE error directions — the counter PRECISION, the scanner
// RECALL — so the second describe block below pins BOTH directions at once, and the
// file keeps them adjacent so the next person to "make the predicates consistent" trips
// over the pin before the edit. See the census in the store's module header.
//
// Embedded PG; Linux CI is the formal authority. SKIPPED on Windows unless
// AOA_RUN_WIN_INTEGRATION=1 (Issue #114), exactly like every sibling suite.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@armyofagents/db";
import type { SubmitJobSource } from "@armyofagents/shared";
import {
  setupJobControlFixture,
  COMPANY,
  ORG,
  type JobControlFixture,
} from "./helpers/job-control-fixture.js";
import { runInTenantReadOnly } from "../db/tenant-context.js";
import {
  jobOutputBridge,
  type BridgeActor,
  type BridgeOutputInput,
} from "../services/job-output-bridge.js";
import { emitRuntimeServiceTaskOutput } from "../services/task-output-emitters.js";
import { createDrizzleE7RunVerifierStore } from "../services/e7-distributed-run-verifier-store.js";
import {
  createE7DistributedRunVerifier,
  detectHardLeakClasses,
  type E7ProducedOutputCounts,
  type E7ScanSurface,
  type E7VerifyResult,
} from "../services/e7-distributed-run-verifier.js";

const ENABLED_ENV = { AOA_DISTRIBUTED_EXECUTION_ENABLED: "true" } as const;
const AGENT = "a8000000-0000-4000-8000-0000000000e1";
const USER = "w21-user";
const ISSUE = "a8000000-0000-4000-8000-0000000000f1";
const RUN = "a8000000-0000-4000-8000-0000000000c1";
const SERVICE = "a8000000-0000-4000-8000-0000000000d1";
const DIGEST = "c".repeat(64);
const PATCH_ARTIFACT = "a8000000-0000-4000-8000-0000000000e9";
// A recognizable leak-class value for clause 4's `provider_key` matcher
// (/\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/). NOT a credential — the same synthetic shape the
// pure verifier suite already plants (`e7-distributed-run-verifier.test.ts:39`).
const PLANTED_PROVIDER_KEY = "sk-ant-api03W21SCANNERPROOF0123456789";
const actor: BridgeActor = { kind: "user", id: USER, companyId: COMPANY };
const TASK_SOURCE: SubmitJobSource = {
  kind: "task_run",
  runId: RUN,
  issueId: ISSUE,
  assigneeAgentId: AGENT,
};

let fixture: JobControlFixture | null = null;
let setupError: unknown = null;

function guard(): void {
  if (setupError) throw new Error(`fixture setup failed: ${String(setupError)}`);
}

/** Bind the run row to a distributed job, then read the counts through the REAL store. */
async function countsForJob(jobId: string | null, attemptId: string | null): Promise<E7ProducedOutputCounts> {
  await fixture!.admin`UPDATE heartbeat_runs
    SET execution_owner = 'distributed', distributed_job_id = ${jobId}, distributed_attempt_id = ${attemptId}
    WHERE id = ${RUN}`;
  return runInTenantReadOnly(fixture!.app.db, ORG, async (_repos, tx) => {
    const store = createDrizzleE7RunVerifierStore(tx as Db);
    const run = await store.getRun(RUN);
    if (!run) throw new Error("run row missing");
    return store.countProducedOutputs(run);
  });
}

/** The E7-F020 writer, called for real — `heartbeat.ts:4524`'s emitter with this run's id. */
async function writeRuntimeServiceOutput(): Promise<void> {
  await fixture!.admin`INSERT INTO workspace_runtime_services
    (id, company_id, issue_id, scope_type, service_name, status, lifecycle, provider, started_by_run_id)
    VALUES (${SERVICE}, ${COMPANY}, ${ISSUE}, 'issue', 'dev server', 'starting', 'ephemeral', 'local', ${RUN})
    ON CONFLICT (id) DO NOTHING`;
  const emitted = await emitRuntimeServiceTaskOutput(fixture!.app.db, {
    id: SERVICE,
    companyId: COMPANY,
    issueId: ISSUE,
    serviceName: "dev server",
    provider: "local",
    status: "starting",
    startedByRunId: RUN,
  });
  // The emitter is best-effort and swallows every error, so a silent no-op would make the
  // negative arm VACUOUS. Assert the row actually landed, with the run linkage that is the
  // whole point of the finding.
  if (!emitted) throw new Error("emitRuntimeServiceTaskOutput wrote nothing — negative arm would be vacuous");
  const [row] = await fixture!.admin`SELECT count(*)::int AS n FROM task_outputs
    WHERE created_by_run_id = ${RUN} AND runtime_service_id = ${SERVICE}`;
  if ((row as { n: number }).n !== 1) {
    throw new Error("expected exactly one platform-written task_output carrying this run id");
  }
}

/**
 * Bind the run to a distributed job, then read BOTH clause-4 inputs through the REAL store:
 * the raw scan surfaces, and the full verifier verdict computed over them. The verdict is
 * what the mandate asks for — "assert clause 4 SEES it" — and the raw surfaces are kept so a
 * failure says whether the row was missed by the SCAN or lost between scan and verdict.
 */
async function scanForJob(
  jobId: string | null,
  attemptId: string | null,
): Promise<{ surfaces: readonly E7ScanSurface[]; result: E7VerifyResult }> {
  await fixture!.admin`UPDATE heartbeat_runs
    SET execution_owner = 'distributed', distributed_job_id = ${jobId}, distributed_attempt_id = ${attemptId}
    WHERE id = ${RUN}`;
  return runInTenantReadOnly(fixture!.app.db, ORG, async (_repos, tx) => {
    const store = createDrizzleE7RunVerifierStore(tx as Db);
    const run = await store.getRun(RUN);
    if (!run) throw new Error("run row missing");
    const surfaces = await store.listRunSecretScanSurfaces(run);
    const result = await createE7DistributedRunVerifier({ store }).verify({ runId: RUN });
    return { surfaces, result };
  });
}

/**
 * A COMMITTED `workspace_patch` row for one attempt of a job — arm 1's evidence.
 *
 * Planted with admin SQL rather than driven through `commitArtifactVersion`, which would need
 * a grant, an object upload and a byte-verified sha256 for a row this test only ever SELECTs.
 * The column set is copied from that sole committed-row writer
 * (`repositories/tenant/job-control.ts` `commitArtifactVersion`), including the `attempt`
 * NUMBER it always stamps — the shape assertion below is what keeps this honest.
 */
async function plantCommittedWorkspacePatch(
  jobId: string,
  attemptNumber: number,
  artifactId: string,
): Promise<void> {
  await fixture!.admin`INSERT INTO job_artifacts
    (id, organization_id, job_id, identifier, object_key, sha256, size_bytes, content_type,
     kind, sensitivity, retention, attempt, version_number, status, committed_at)
    VALUES (${artifactId}, ${ORG}, ${jobId}, ${`patch-a${attemptNumber}`},
      ${`artifacts/${jobId}/${attemptNumber}/patch`}, ${"7".repeat(64)}, 512, 'application/octet-stream',
      'workspace_patch', 'customer_content', 'job_lifetime', ${attemptNumber}, 1, 'committed',
      clock_timestamp())`;
  const [row] = await fixture!.admin`SELECT attempt, status, kind FROM job_artifacts WHERE id = ${artifactId}`;
  const planted = row as { attempt: number; status: string; kind: string };
  if (planted.attempt !== attemptNumber || planted.status !== "committed" || planted.kind !== "workspace_patch") {
    throw new Error("planted workspace_patch does not have the committed-writer shape");
  }
}

/** The clause-4 hard failures naming a specific `task_outputs` row. SHAPE only — the reason
 * string carries the matched CLASS and the row id, never the matched substring. */
function clause4HitsFor(result: E7VerifyResult, outputId: string): readonly string[] {
  return result.failures
    .filter((f) => f.clause === 4 && f.reason.includes(`task_outputs#${outputId}`))
    .map((f) => f.reason);
}

beforeAll(async () => {
  try {
    fixture = await setupJobControlFixture("w21-e7f020");
    await fixture.admin`INSERT INTO agents (id, company_id, name, kind, status, adapter_type, adapter_config)
      VALUES (${AGENT}, ${COMPANY}, 'W21 Agent', 'org', 'idle', 'claude_local', ${fixture.admin.json({})})`;
    await fixture.admin`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES (${USER}, 'W21 User', 'w21@example.test', true, now(), now())`;
    await fixture.admin`INSERT INTO company_memberships (company_id, principal_type, principal_id, status, membership_role)
      VALUES (${COMPANY}, 'user', ${USER}, 'active', 'owner')`;
    await fixture.admin`INSERT INTO issues (id, company_id, title) VALUES (${ISSUE}, ${COMPANY}, 'W21 Task')`;
    await fixture.admin`INSERT INTO heartbeat_runs (id, company_id, agent_id, status)
      VALUES (${RUN}, ${COMPANY}, ${AGENT}, 'succeeded')`;
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  await fixture?.teardown().catch(() => {});
}, 60_000);

beforeEach(async () => {
  if (!fixture) return;
  await fixture.admin`DELETE FROM task_outputs`;
  await fixture.admin`DELETE FROM workspace_runtime_services`;
});

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "E7-F020 — arm 2 counts distributed provenance only",
  () => {
    // NEGATIVE ------------------------------------------------------------
    it("[negative] a runtime-service task_output written by the platform for this run is NOT counted", async () => {
      guard();
      const { seeded } = await fixture!.activateLease(1);
      await writeRuntimeServiceOutput();
      const counts = await countsForJob(seeded.jobId, seeded.attemptId);
      expect(counts.taskOutputs).toBe(0);
      expect(counts.workspacePatchArtifacts).toBe(0);
    });

    // POSITIVE CONTROL A ---------------------------------------------------
    it("[positive] an output projected through the distributed bridge on this run's job IS counted", async () => {
      guard();
      const { seeded, identity: fence } = await fixture!.activateLease(2);
      const projected = await jobOutputBridge(fixture!.app.db, { env: ENABLED_ENV }).projectAcceptedOutput({
        source: TASK_SOURCE,
        actor,
        fence,
        acceptedEventId: randomUUID(),
        eventDigest: DIGEST,
        issueId: ISSUE,
        output: { type: "external_link", title: "W21 agent output", url: "https://example.test/w21", createdByRunId: RUN },
      });
      expect(projected.status).toBe("recorded");
      const counts = await countsForJob(seeded.jobId, seeded.attemptId);
      expect(counts.taskOutputs).toBe(1);
    });

    // POSITIVE CONTROL B ---------------------------------------------------
    it("[positive] it is counted even when the bridge caller supplied NO run id — provenance is the receipt, not the column", async () => {
      guard();
      const { seeded, identity: fence } = await fixture!.activateLease(3);
      const projected = await jobOutputBridge(fixture!.app.db, { env: ENABLED_ENV }).projectAcceptedOutput({
        source: TASK_SOURCE,
        actor,
        fence,
        acceptedEventId: randomUUID(),
        eventDigest: DIGEST,
        issueId: ISSUE,
        output: { type: "external_link", title: "W21 no-run-id output", url: "https://example.test/w21b" },
      });
      expect(projected.status).toBe("recorded");
      const [row] = await fixture!.admin`SELECT count(*)::int AS n FROM task_outputs WHERE created_by_run_id IS NULL`;
      expect((row as { n: number }).n).toBe(1);
      const counts = await countsForJob(seeded.jobId, seeded.attemptId);
      expect(counts.taskOutputs).toBe(1);
    });

    // MIXED — the arm that `return 0` cannot pass and the pre-fix predicate cannot pass ----
    it("[mixed] with BOTH rows present the count is exactly one — the distributed one", async () => {
      guard();
      const { seeded, identity: fence } = await fixture!.activateLease(4);
      await writeRuntimeServiceOutput();
      const projected = await jobOutputBridge(fixture!.app.db, { env: ENABLED_ENV }).projectAcceptedOutput({
        source: TASK_SOURCE,
        actor,
        fence,
        acceptedEventId: randomUUID(),
        eventDigest: DIGEST,
        issueId: ISSUE,
        output: { type: "external_link", title: "W21 agent output", url: "https://example.test/w21c", createdByRunId: RUN },
      });
      const [total] = await fixture!.admin`SELECT count(*)::int AS n FROM task_outputs WHERE issue_id = ${ISSUE}`;
      expect((total as { n: number }).n).toBe(2);
      const counts = await countsForJob(seeded.jobId, seeded.attemptId);
      expect(counts.taskOutputs).toBe(1);
      const [receipt] = await fixture!.admin`SELECT target_aggregate_id FROM job_projection_receipts
        WHERE projection_kind = 'output_projection'`;
      expect((receipt as { target_aggregate_id: string }).target_aggregate_id).toBe(projected.outputId);
    });

    // CROSS-JOB ------------------------------------------------------------
    it("[cross-job] a projected output does not count for a run bound to a DIFFERENT distributed job", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(5);
      await jobOutputBridge(fixture!.app.db, { env: ENABLED_ENV }).projectAcceptedOutput({
        source: TASK_SOURCE,
        actor,
        fence,
        acceptedEventId: randomUUID(),
        eventDigest: DIGEST,
        issueId: ISSUE,
        output: { type: "external_link", title: "W21 other job", url: "https://example.test/w21d", createdByRunId: RUN },
      });
      const counts = await countsForJob(randomUUID(), randomUUID());
      expect(counts.taskOutputs).toBe(0);
    });

    // NO DISTRIBUTED JOB ---------------------------------------------------
    it("[no job] an ordinary non-distributed run counts nothing, however many platform rows it wrote", async () => {
      guard();
      await fixture!.resetRuntimeRows();
      await writeRuntimeServiceOutput();
      const counts = await countsForJob(null, null);
      expect(counts.taskOutputs).toBe(0);
      expect(counts.workspacePatchArtifacts).toBe(0);
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// E7-F030 — clause 4's task_outputs scan surface is the UNION, not the counter's predicate.
//
// ★ WHY THESE LIVE BESIDE THE ARM-2 TESTS. The defect they pin is not "the scanner has the
// wrong predicate" — it is "TWO consumers of one provenance notion drifted apart, and
// nothing noticed". Splitting them into a separate file would let the next edit to arm 2
// happen without this suite in view, which is precisely how the drift happened.
//
// ★ WHICH ARM CATCHES WHICH MISTAKE:
//   [union]   RED before this fix — the reviewer-found defect itself.
//   [legacy]  GREEN before AND after — the POSITIVE CONTROL, and the more important of the
//             two: it is the only arm that reddens on the tempting "just copy the counter's
//             receipt predicate into the scanner" fix, which would silently stop scanning
//             every legacy platform writer (the mirror defect).
//   [dedupe]  a row satisfying BOTH notions is scanned ONCE.
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "E7-F030 — the secret-scan surface is the union of both provenance notions",
  () => {
    // THE DEFECT ------------------------------------------------------------
    // RED at f433c8391: the row's created_by_run_id is NULL (asserted below, the same shape
    // `[positive B]` asserts is supported), so the pre-fix `eq(createdByRunId, run.id)` scan
    // never saw it — arm 2 counted it as capability evidence while clause 4 reported clean.
    it("[union] a bridge-projected output with NO caller run id is SCANNED — its planted key reaches clause 4", async () => {
      guard();
      const { seeded, identity: fence } = await fixture!.activateLease(6);
      const projected = await jobOutputBridge(fixture!.app.db, { env: ENABLED_ENV }).projectAcceptedOutput({
        source: TASK_SOURCE,
        actor,
        fence,
        acceptedEventId: randomUUID(),
        eventDigest: DIGEST,
        issueId: ISSUE,
        output: {
          type: "external_link",
          title: "W21B leaked-summary output",
          url: "https://example.test/w21b-scan",
          // NO createdByRunId — provenance is the receipt, and the leak is in the summary.
          summary: `agent transcript tail: exporting ${PLANTED_PROVIDER_KEY} to the sandbox`,
        },
      });
      expect(projected.status).toBe("recorded");
      const outputId = projected.outputId as string;

      // Anti-vacuity: the row really is invisible to the OLD predicate. If this ever becomes
      // 0, the fixture stopped exercising the defect and the arm below proves nothing.
      const [nulls] = await fixture!.admin`SELECT count(*)::int AS n FROM task_outputs
        WHERE id = ${outputId} AND created_by_run_id IS NULL`;
      expect((nulls as { n: number }).n).toBe(1);

      const { surfaces, result } = await scanForJob(seeded.jobId, seeded.attemptId);
      expect(surfaces.some((s) => s.surface === "task_outputs" && s.fieldOrEventId === outputId)).toBe(true);
      const hits = clause4HitsFor(result, outputId);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain("provider_key");
      // SHAPE ONLY — the reason must never quote the matched value (design §6 / §8 BLOCKER 3).
      expect(hits[0]).not.toContain(PLANTED_PROVIDER_KEY);
      // And the row IS the one arm 2 counts, which is what made the gap dangerous.
      expect(result.observed.producedArtifacts.taskOutputs).toBe(1);
    });

    // POSITIVE CONTROL — green before and after; reds on a same-predicate "consistency" fix.
    it("[legacy] a platform row linked ONLY by created_by_run_id is STILL scanned", async () => {
      guard();
      const { seeded } = await fixture!.activateLease(7);
      await writeRuntimeServiceOutput();
      const [row] = await fixture!.admin`UPDATE task_outputs
        SET summary = ${`dev server env dump: ${PLANTED_PROVIDER_KEY}`}
        WHERE created_by_run_id = ${RUN} RETURNING id`;
      const outputId = (row as { id: string }).id;
      // It carries NO receipt — so a scanner narrowed to the counter's predicate loses it.
      const [receipts] = await fixture!.admin`SELECT count(*)::int AS n FROM job_projection_receipts
        WHERE target_aggregate_id = ${outputId}`;
      expect((receipts as { n: number }).n).toBe(0);

      const { surfaces, result } = await scanForJob(seeded.jobId, seeded.attemptId);
      expect(surfaces.some((s) => s.surface === "task_outputs" && s.fieldOrEventId === outputId)).toBe(true);
      expect(clause4HitsFor(result, outputId)).toHaveLength(1);
      // The counter must NOT count it — the two consumers disagreeing about THIS row is the
      // whole point, and this asserts the divergence rather than merely tolerating it.
      expect(result.observed.producedArtifacts.taskOutputs).toBe(0);
    });

    // DEDUPE ----------------------------------------------------------------
    it("[dedupe] a row satisfying BOTH notions is scanned exactly once", async () => {
      guard();
      const { seeded, identity: fence } = await fixture!.activateLease(8);
      const projected = await jobOutputBridge(fixture!.app.db, { env: ENABLED_ENV }).projectAcceptedOutput({
        source: TASK_SOURCE,
        actor,
        fence,
        acceptedEventId: randomUUID(),
        eventDigest: DIGEST,
        issueId: ISSUE,
        output: {
          type: "external_link",
          title: "W21B both-notions output",
          url: "https://example.test/w21b-both",
          summary: `both linkages: ${PLANTED_PROVIDER_KEY}`,
          createdByRunId: RUN,
        },
      });
      expect(projected.status).toBe("recorded");
      const outputId = projected.outputId as string;

      const { surfaces, result } = await scanForJob(seeded.jobId, seeded.attemptId);
      expect(surfaces.filter((s) => s.surface === "task_outputs" && s.fieldOrEventId === outputId)).toHaveLength(1);
      // One surface ⇒ one clause-4 failure. A duplicated surface would double-report the
      // same leak and inflate every count printed beside the verdict.
      expect(clause4HitsFor(result, outputId)).toHaveLength(1);
      expect(result.observed.producedArtifacts.taskOutputs).toBe(1);
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// E7-F031 — the RETRY/ATTEMPT axis. `countProducedOutputs` bound to the JOB, not the ATTEMPT.
//
// ★ THE DEFECT. A job carries `max_attempts` (default 3) and EVERY attempt shares the
// `job_id`, while a heartbeat run is bound to exactly ONE attempt (`distributed_attempt_id`,
// written once by `buildHandoffRunPatch`; the projector's `findRunForAttempt` looks the run up
// by that exact pair). Both arms of the capability counter filtered on `job_id` alone, so an
// output projected by attempt 2 — or a workspace_patch committed by attempt 2 — printed
// `capability: PROVEN` for a run bound to attempt 1 THAT PRODUCED NOTHING. Same false-PROVEN
// class as E7-F020, on a new axis: W21 replaced a column-provenance bug with a granularity bug.
//
// ★ WHY BINDING TO THE ATTEMPT IS NOT AN OVER-NARROWING. On a retried job nothing ever
// re-points `heartbeat_runs.distributed_attempt_id` at the new attempt (grep: the column has
// exactly one writer, at handoff). So the control plane ITSELF does not attribute attempt 2 to
// this run — `findRunForAttempt` finds no run for attempt 2's terminal and never finalizes it,
// and clause 3 refuses the run for want of a durable terminal. Counting attempt 2's output for
// attempt 1's run was the anomaly; excluding it agrees with every other consumer in the file.
//
// ★ THE SCANNER IS NOT TOUCHED, AND MUST NOT BE — see the `[sibling-scan]` arm.
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "E7-F031 — the capability counter binds to the run's ATTEMPT, not its job",
  () => {
    // THE DEFECT (arm 2) ----------------------------------------------------
    // RED at f171d0dad: the receipt is on attempt 2, the run is bound to attempt 1, and the
    // job-granular predicate counted it — a false PROVEN over an output-free run.
    it("[sibling arm2] an output projected by a SIBLING attempt of the same job is NOT counted", async () => {
      guard();
      const { seeded } = await fixture!.activateLease(9);
      const sibling = await fixture!.activateSiblingLease(seeded, 2, 9);
      const projected = await jobOutputBridge(fixture!.app.db, { env: ENABLED_ENV }).projectAcceptedOutput({
        source: TASK_SOURCE,
        actor,
        fence: sibling.identity,
        acceptedEventId: randomUUID(),
        eventDigest: DIGEST,
        issueId: ISSUE,
        output: { type: "external_link", title: "W21C retry output", url: "https://example.test/w21c-retry" },
      });
      expect(projected.status).toBe("recorded");
      // Anti-vacuity: the receipt really is bound to the OTHER attempt of the SAME job.
      const [receipt] = await fixture!.admin`SELECT job_id, attempt_id FROM job_projection_receipts
        WHERE projection_kind = 'output_projection'`;
      const bound = receipt as { job_id: string; attempt_id: string };
      expect(bound.job_id).toBe(seeded.jobId);
      expect(bound.attempt_id).toBe(sibling.attemptId);
      expect(bound.attempt_id).not.toBe(seeded.attemptId);

      // The run under verification is bound to attempt 1 and produced nothing of its own.
      const counts = await countsForJob(seeded.jobId, seeded.attemptId);
      expect(counts.taskOutputs).toBe(0);
    });

    // POSITIVE CONTROL — the arm that reds on an over-narrow predicate or a `return 0`.
    it("[own arm2] the SAME receipt counts for the run bound to the attempt that produced it", async () => {
      guard();
      const { seeded } = await fixture!.activateLease(10);
      const sibling = await fixture!.activateSiblingLease(seeded, 2, 10);
      await jobOutputBridge(fixture!.app.db, { env: ENABLED_ENV }).projectAcceptedOutput({
        source: TASK_SOURCE,
        actor,
        fence: sibling.identity,
        acceptedEventId: randomUUID(),
        eventDigest: DIGEST,
        issueId: ISSUE,
        output: { type: "external_link", title: "W21C own-attempt output", url: "https://example.test/w21c-own" },
      });
      const counts = await countsForJob(seeded.jobId, sibling.attemptId);
      expect(counts.taskOutputs).toBe(1);
    });

    // THE DEFECT (arm 1) ----------------------------------------------------
    // The census (D) turned this up: arm 1 is the same job-granular predicate in the same
    // PRECISION direction, and it is the OTHER half of one `arm1 < 1 && arm2 < 1` gate — so
    // fixing only arm 2 would leave the gate falsely openable by exactly the closed mechanism.
    it("[sibling arm1] a workspace_patch committed by a SIBLING attempt is NOT counted", async () => {
      guard();
      const { seeded } = await fixture!.activateLease(11);
      await fixture!.activateSiblingLease(seeded, 2, 11);
      await plantCommittedWorkspacePatch(seeded.jobId, 2, PATCH_ARTIFACT);
      const counts = await countsForJob(seeded.jobId, seeded.attemptId);
      expect(counts.workspacePatchArtifacts).toBe(0);
      expect(counts.taskOutputs).toBe(0);
    });

    // POSITIVE CONTROL for arm 1 — arm 1 must still be passable on its own attempt.
    it("[own arm1] a workspace_patch committed by the run's OWN attempt IS counted", async () => {
      guard();
      const { seeded } = await fixture!.activateLease(12);
      await plantCommittedWorkspacePatch(seeded.jobId, 1, PATCH_ARTIFACT);
      const counts = await countsForJob(seeded.jobId, seeded.attemptId);
      expect(counts.workspacePatchArtifacts).toBe(1);
    });

    // THE NULL CASE — stated, chosen, and pinned rather than left to fall through.
    it("[null attempt] a run with a job id but NO attempt id counts nothing on either arm", async () => {
      guard();
      const { seeded, identity: fence } = await fixture!.activateLease(13);
      await jobOutputBridge(fixture!.app.db, { env: ENABLED_ENV }).projectAcceptedOutput({
        source: TASK_SOURCE,
        actor,
        fence,
        acceptedEventId: randomUUID(),
        eventDigest: DIGEST,
        issueId: ISSUE,
        output: { type: "external_link", title: "W21C null-attempt", url: "https://example.test/w21c-null" },
      });
      await plantCommittedWorkspacePatch(seeded.jobId, 1, PATCH_ARTIFACT);
      // Both arms would count on a job-granular predicate; with no attempt to attribute the
      // work to, a PRECISION consumer must refuse rather than widen back to job scope.
      const counts = await countsForJob(seeded.jobId, null);
      expect(counts.taskOutputs).toBe(0);
      expect(counts.workspacePatchArtifacts).toBe(0);
      // Anti-vacuity: with the attempt id present the very same rows DO count, so the zero
      // above is the null-case decision and not a broken fixture.
      const bound = await countsForJob(seeded.jobId, seeded.attemptId);
      expect(bound.taskOutputs).toBe(1);
      expect(bound.workspacePatchArtifacts).toBe(1);
    });

    // ★★★ THE ASYMMETRY PIN, on the ATTEMPT axis. GREEN before and after this change.
    // Reds the moment someone "makes the scanner consistent" by copying the counter's new
    // attempt predicate into `listRunSecretScanSurfaces` — which would stop scanning a
    // sibling attempt's output and let a secret in attempt 2's summary go unseen while
    // verifying attempt 1. That is the mirror defect, and it is the SECOND time collapsing
    // these two consumers onto one predicate has been proposed.
    it("[sibling-scan] the SECRET SCANNER still sees a sibling attempt's output — recall is job-wide", async () => {
      guard();
      const { seeded } = await fixture!.activateLease(14);
      const sibling = await fixture!.activateSiblingLease(seeded, 2, 14);
      const projected = await jobOutputBridge(fixture!.app.db, { env: ENABLED_ENV }).projectAcceptedOutput({
        source: TASK_SOURCE,
        actor,
        fence: sibling.identity,
        acceptedEventId: randomUUID(),
        eventDigest: DIGEST,
        issueId: ISSUE,
        output: {
          type: "external_link",
          title: "W21C sibling-scan output",
          url: "https://example.test/w21c-sibling-scan",
          summary: `retry transcript tail: ${PLANTED_PROVIDER_KEY}`,
        },
      });
      const outputId = projected.outputId as string;
      const { surfaces, result } = await scanForJob(seeded.jobId, seeded.attemptId);
      expect(surfaces.some((s) => s.surface === "task_outputs" && s.fieldOrEventId === outputId)).toBe(true);
      expect(clause4HitsFor(result, outputId)).toHaveLength(1);
      // …and the counter, on the very same row, refuses. The divergence is asserted, not
      // merely tolerated: one row, scanned by clause 4 and NOT counted by clause 6.
      expect(result.observed.producedArtifacts.taskOutputs).toBe(0);
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// E7-F030 (residual) — the COLUMN-set recall gap in `listRunSecretScanSurfaces` (2).
//
// The row-set gap was fixed at f171d0dad and the column-set gap was RECORDED rather than
// fixed. An adversarial checker then measured it: a key planted in `title` reaches a row that
// IS surfaced, and is NOT scanned, so `detectHardLeakClasses` returns nothing. `title` (NOT
// NULL) and `url` — plus `provider`, `external_id` and `health_status` — are all caller-
// authored free text that `BridgeOutputInput` passes straight through to the row.
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "E7-F030 residual — every caller-authored task_outputs column is scanned",
  () => {
    // RED at f171d0dad, every arm: the scan text was `summary + metadata` only.
    const LEAKY_OUTPUTS: ReadonlyArray<{ column: string; output: BridgeOutputInput }> = [
      {
        column: "title",
        output: { type: "external_link", title: `W21C ${PLANTED_PROVIDER_KEY}`, url: "https://example.test/w21c-col" },
      },
      {
        column: "url",
        output: {
          type: "external_link",
          title: "W21C url-scan output",
          url: `https://example.test/w21c-col?token=${PLANTED_PROVIDER_KEY}`,
        },
      },
      {
        column: "provider",
        output: { type: "external_link", title: "W21C provider-scan", url: null, provider: PLANTED_PROVIDER_KEY },
      },
      {
        column: "externalId",
        output: { type: "external_link", title: "W21C external-id-scan", url: null, externalId: PLANTED_PROVIDER_KEY },
      },
      {
        column: "healthStatus",
        output: { type: "external_link", title: "W21C health-scan", url: null, healthStatus: PLANTED_PROVIDER_KEY },
      },
    ];
    for (const { column, output } of LEAKY_OUTPUTS) {
      it(`[column] a key planted in \`${column}\` on a bridge-projected row reaches clause 4`, async () => {
        guard();
        const { seeded, identity: fence } = await fixture!.activateLease(15);
        const projected = await jobOutputBridge(fixture!.app.db, { env: ENABLED_ENV }).projectAcceptedOutput({
          source: TASK_SOURCE,
          actor,
          fence,
          acceptedEventId: randomUUID(),
          eventDigest: DIGEST,
          issueId: ISSUE,
          // The leak is in THIS column and nowhere else — no summary, no metadata — so a
          // hit can only come from the column under test.
          output,
        });
        expect(projected.status).toBe("recorded");
        const outputId = projected.outputId as string;

        // Anti-vacuity: the value really landed in that column, and summary/metadata are empty.
        const [stored] = await fixture!.admin`SELECT summary, metadata FROM task_outputs WHERE id = ${outputId}`;
        const row = stored as { summary: string | null; metadata: unknown };
        expect(row.summary).toBeNull();
        expect(row.metadata).toBeNull();

        const { surfaces, result } = await scanForJob(seeded.jobId, seeded.attemptId);
        const surface = surfaces.find((s) => s.surface === "task_outputs" && s.fieldOrEventId === outputId);
        expect(surface).toBeDefined();
        expect(detectHardLeakClasses(surface!.text)).toContain("provider_key");
        const hits = clause4HitsFor(result, outputId);
        expect(hits).toHaveLength(1);
        expect(hits[0]).toContain("provider_key");
        expect(hits[0]).not.toContain(PLANTED_PROVIDER_KEY);
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // W21D / E7-F033 — THE PRECISION HALF. The five arms above prove RECALL five
    // times and precision ZERO times, and a scanner proven only for recall drifts
    // into a denial of service on its own users. This is the MIRROR of E7-F020: a
    // false FAIL rather than a false PASS, and it lands on the exact runs the
    // campaign will try first.
    //
    // Every arm below is the same column carrying a value an ORDINARY run legitimately
    // writes, asserted to produce NO hard leak class and NO clause-4 failure. Paired
    // with the recall arm above it, so a fix here can never silently become a
    // suppression: narrowing a matcher until it stops firing reds the recall arm,
    // and deleting a column from the scan reds it too.
    // ═══════════════════════════════════════════════════════════════════════════
    const LEGITIMATE_OUTPUTS: ReadonlyArray<{ column: string; output: BridgeOutputInput }> = [
      {
        // A branch name is what `emitBranchTaskOutput`-shaped callers put in `title`.
        column: "title",
        output: { type: "branch", title: "replatform/w21d-arm2-provenance", url: null },
      },
      {
        // ★ THE ONE THAT MATTERED. A declared dev service whose URL is a database —
        // `workspaceRuntime.services[]` → `emitRuntimeServiceTaskOutput` copies
        // `row.url` straight through (task-output-emitters.ts:100). No credentials,
        // no secret, loopback host.
        column: "url",
        output: { type: "preview_url", title: "dev db", url: "postgres://localhost:5432/dev" },
      },
      {
        column: "provider",
        output: { type: "runtime_service", title: "dev server", url: null, provider: "local" },
      },
      {
        // The literal shape `emitRuntimeServiceTaskOutput` mints for every service row.
        column: "externalId",
        output: {
          type: "runtime_service",
          title: "dev server",
          url: null,
          externalId: `runtime-service:${SERVICE}`,
        },
      },
      {
        column: "healthStatus",
        output: { type: "runtime_service", title: "dev server", url: null, healthStatus: "healthy" },
      },
    ];
    for (const { column, output } of LEGITIMATE_OUTPUTS) {
      it(`[precision] a legitimate \`${column}\` value on a bridge-projected row does NOT trip clause 4`, async () => {
        guard();
        const { seeded, identity: fence } = await fixture!.activateLease(16);
        const projected = await jobOutputBridge(fixture!.app.db, { env: ENABLED_ENV }).projectAcceptedOutput({
          source: TASK_SOURCE,
          actor,
          fence,
          acceptedEventId: randomUUID(),
          eventDigest: DIGEST,
          issueId: ISSUE,
          output,
        });
        expect(projected.status).toBe("recorded");
        const outputId = projected.outputId as string;

        const { surfaces, result } = await scanForJob(seeded.jobId, seeded.attemptId);
        // Anti-vacuity: the row really IS surfaced, so an empty class list is a
        // PRECISION result and not a row the scanner never saw.
        const surface = surfaces.find((s) => s.surface === "task_outputs" && s.fieldOrEventId === outputId);
        expect(surface).toBeDefined();
        expect(surface!.text).toContain(output.title);
        expect(detectHardLeakClasses(surface!.text)).toEqual([]);
        expect(clause4HitsFor(result, outputId)).toEqual([]);
      });
    }

    // The composite: ONE row carrying a legitimate value in EVERY newly scanned column
    // at once — the realistic declared-dev-service output, end to end.
    it("[precision] a wholly legitimate runtime-service row leaves clause 4 clean", async () => {
      guard();
      const { seeded, identity: fence } = await fixture!.activateLease(17);
      const projected = await jobOutputBridge(fixture!.app.db, { env: ENABLED_ENV }).projectAcceptedOutput({
        source: TASK_SOURCE,
        actor,
        fence,
        acceptedEventId: randomUUID(),
        eventDigest: DIGEST,
        issueId: ISSUE,
        output: {
          type: "preview_url",
          title: "replatform/w21d-arm2-provenance",
          url: "postgres://localhost:5432/dev",
          provider: "local",
          externalId: `runtime-service:${SERVICE}`,
          healthStatus: "healthy",
          summary: "dev database service started on port 5432; migrations applied",
          metadata: { port: 5432, lifecycle: "ephemeral", scopeType: "issue", providerRef: null },
        },
      });
      expect(projected.status).toBe("recorded");
      const outputId = projected.outputId as string;

      const { surfaces, result } = await scanForJob(seeded.jobId, seeded.attemptId);
      const surface = surfaces.find((s) => s.surface === "task_outputs" && s.fieldOrEventId === outputId);
      expect(surface).toBeDefined();
      expect(surface!.text).toContain("postgres://localhost:5432/dev");
      expect(detectHardLeakClasses(surface!.text)).toEqual([]);
      expect(clause4HitsFor(result, outputId)).toEqual([]);
      expect(result.failures.filter((f) => f.clause === 4)).toEqual([]);
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // …AND THE RECALL THAT THE E7-F033 NARROWING MUST NOT COST. The fix narrows
    // `connection_string` from "any URI of these schemes" to "a URI carrying a
    // credential". If that narrowing ever drifts into a suppression — someone
    // trims the query-param alternative, or the userinfo alternative stops
    // crossing `@` — these arms go red. A precision fix without them is
    // indistinguishable from deleting the matcher.
    // ═══════════════════════════════════════════════════════════════════════════
    const CREDENTIALED_URIS: ReadonlyArray<{ shape: string; url: string }> = [
      // (a) userinfo with a password component — the classic leaked DSN.
      { shape: "user:password@", url: "postgres://aoa:W21DsyntheticPw@db.internal:5432/prod" },
      // (a′) password-only userinfo. Not a corner case: many clients emit it.
      { shape: ":password@", url: "rediss://:W21DsyntheticPw@cache.internal:6379" },
      // (b) credential-bearing query parameter — libpq accepts this form, so the
      //     userinfo alternative ALONE would have lost a real leak.
      { shape: "?password=", url: "postgres://db.internal:5432/prod?sslmode=require&password=W21DsyntheticPw" },
    ];
    for (const { shape, url } of CREDENTIALED_URIS) {
      it(`[credential] a connection URI carrying \`${shape}\` still hard-fails clause 4`, async () => {
        guard();
        const { seeded, identity: fence } = await fixture!.activateLease(18);
        const projected = await jobOutputBridge(fixture!.app.db, { env: ENABLED_ENV }).projectAcceptedOutput({
          source: TASK_SOURCE,
          actor,
          fence,
          acceptedEventId: randomUUID(),
          eventDigest: DIGEST,
          issueId: ISSUE,
          output: { type: "preview_url", title: "dev db", url },
        });
        expect(projected.status).toBe("recorded");
        const outputId = projected.outputId as string;

        const { surfaces, result } = await scanForJob(seeded.jobId, seeded.attemptId);
        const surface = surfaces.find((s) => s.surface === "task_outputs" && s.fieldOrEventId === outputId);
        expect(surface).toBeDefined();
        expect(detectHardLeakClasses(surface!.text)).toContain("connection_string");
        const hits = clause4HitsFor(result, outputId);
        expect(hits).toHaveLength(1);
        expect(hits[0]).toContain("connection_string");
        // SHAPE only — the verdict never quotes the credential (design §6 / §8 BLOCKER 3).
        expect(hits[0]).not.toContain("W21DsyntheticPw");
      });
    }

    // The DELIBERATE boundary, asserted so a reader knows it was chosen and not missed:
    // a bare username in the userinfo is not credential material, so it does not hard-fail.
    it("[boundary] a URI with a username but NO password does not hard-fail", async () => {
      guard();
      const { seeded, identity: fence } = await fixture!.activateLease(19);
      const projected = await jobOutputBridge(fixture!.app.db, { env: ENABLED_ENV }).projectAcceptedOutput({
        source: TASK_SOURCE,
        actor,
        fence,
        acceptedEventId: randomUUID(),
        eventDigest: DIGEST,
        issueId: ISSUE,
        output: { type: "preview_url", title: "dev db", url: "postgres://aoa@localhost:5432/dev" },
      });
      expect(projected.status).toBe("recorded");
      const outputId = projected.outputId as string;

      const { surfaces, result } = await scanForJob(seeded.jobId, seeded.attemptId);
      const surface = surfaces.find((s) => s.surface === "task_outputs" && s.fieldOrEventId === outputId);
      expect(surface).toBeDefined();
      expect(surface!.text).toContain("postgres://aoa@localhost:5432/dev");
      expect(detectHardLeakClasses(surface!.text)).toEqual([]);
      expect(clause4HitsFor(result, outputId)).toEqual([]);
    });
  },
);
