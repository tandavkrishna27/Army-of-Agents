// server/src/services/e7-distributed-run-verifier-store.ts
//
// evidence-verifier A — drizzle wiring for the read-only run-verifier store.
//
// Kept OUT of the pure `e7-distributed-run-verifier.ts` acceptance module so its
// fail-first unit tests never load drizzle internals (CLAUDE.md Test Patterns /
// drizzle-ESM split), exactly as `canary-preflight-store.ts` keeps drizzle out of
// `canary-preflight.ts`. This is the ONLY file that imports the schema.
//
// SECURITY (Decision #104): every method returns already-fetched plain data. NO key
// value crosses the port as a parameter; the pure service matches leak-CLASS patterns
// over the raw-at-rest scan text and discards it. The store exposes ONLY SELECTs, so
// A structurally cannot mutate state as a side effect of being consulted.
//
// TENANT: methods read by run/attempt/job id (all globally unique) and RETURN each
// row's company_id / organization_id; the pure service asserts tenant consistency
// (run.company_id vs every corroborating row). The distributed kernel tables carry
// FORCE RLS + the aoa_app policy, so the CLI must open the DB with a role/tenant
// context that can see the run's tenant rows — otherwise clause 5 fails SAFE-CLOSED
// (missing corroboration → refuse to bless), never a false PASS.
//
// ═══════════════════════════════════════════════════════════════════════════════
// ★★★ PROVENANCE CENSUS — "which rows belong to this run", per consumer.
//
// W21 narrowed ONE consumer (arm 2 of `countProducedOutputs`) onto a receipt join and
// left its sibling in `listRunSecretScanSurfaces` on `created_by_run_id`, so a receipt-
// linked row with a NULL run id counted as capability evidence and was never scanned for
// secrets (E7-F030, found in review of PR #385). The two consumers had drifted because
// the notion was never written down in one place. It is written down here.
//
// W21C then found that the census itself had a blind spot: it reasoned about WHICH LINKAGE
// each consumer used and never about AT WHAT GRANULARITY. Both arms of the capability counter
// were bound to the JOB while a run is bound to one ATTEMPT of it, so a retry attempt's work
// printed `capability: PROVEN` for a run that produced nothing (E7-F031). The census below
// therefore carries the attempt axis explicitly for every row.
//
// ★ THE NOTION IS NOT CENTRALISABLE INTO ONE PREDICATE, and that is the point. Each
// consumer's correct predicate is chosen by its ERROR DIRECTION:
//
//   PRECISION consumers (a wrong row → a false PASS / false PROVEN → must EXCLUDE when unsure)
//   RECALL    consumers (a missed row → a missed secret / missed refusal → must INCLUDE when unsure)
//
// ★★ THE CENSUS HAS THREE AXES, because it has now been wrong on two of them. The ROW-LINKAGE
// axis ("which linkage column") was the only one the first census reasoned about, and it missed
// both of the others:
//
//   ROW LINKAGE  — receipt join vs `created_by_run_id` vs a PK.            (E7-F030, fixed)
//   GRANULARITY  — JOB-wide vs this run's ATTEMPT. A job carries
//                  `max_attempts` (default 3) and every attempt shares the
//                  job_id, while a run is bound to exactly ONE attempt.    (E7-F031, fixed)
//   COLUMN SET   — which of a row's columns actually reach the scan text.  (E7-F030, fixed)
//
// The granularity axis is NOT cosmetic and it flips direction with the consumer, exactly as
// the row axis does: for a PRECISION consumer, job-wide means another attempt's work is
// credited to this run (a false PROVEN); for a RECALL consumer, attempt-narrow means another
// attempt's leak goes unscanned (a missed hard-fail). Same fact, opposite verdicts.
//
// | # | consumer                                | linkage used                                    | direction | granularity | right? |
// |---|-----------------------------------------|-------------------------------------------------|-----------|-------------|--------|
// | 1 | getRun                                  | heartbeat_runs.id = runId (PK)                  | exact     | RUN (= one attempt) | yes — it IS the subject |
// | 2 | getAttempt                              | job_attempts.id = run.distributed_attempt_id    | precision | attempt | yes — the service re-checks company_id and job_id against the run (clause 5), so a dangling/mismatched id REFUSES |
// | 3 | listLeases                              | leases.attempt_id                               | precision | attempt | yes — clause 5 counts corroboration; a sibling attempt's lease would be a false PASS ("this attempt was leased"). Tenant-filtered in the service |
// | 4 | listJobEvents                           | job_events.attempt_id                           | BOTH      | attempt | SPLIT — right for clause 5 (precision: a sibling attempt's `attempt_started` must not corroborate THIS attempt), WRONG for clause 4 (recall: on a retried job, attempt 2's event payloads are never scanned while verifying attempt 1). Filed as E7-F032, NOT fixed here — see the note below |
// | 5 | getAttemptTerminalReceipt               | job_projection_receipts.attempt_id + kind       | precision | attempt | yes |
// | 6 | listRunSecretScanSurfaces (1) heartbeat | heartbeat_runs.id (PK)                          | exact     | RUN (= one attempt) | yes — the run's own columns are the run's own |
// | 7 | listRunSecretScanSurfaces (2) outputs   | ★ UNION: applied output_projection receipt on   | RECALL    | JOB-wide (2a) + run (2b) | yes — and the JOB-wide half is DELIBERATE on the attempt axis too: a sibling attempt's output is still scanned. It was `created_by_run_id` alone — E7-F030 |
// |   |                                         |   run.distributed_job_id  OR  created_by_run_id |           |         |        |
// | 8 | listRunSecretScanSurfaces (3) artifacts | job_artifacts.job_id = run.distributed_job_id   | recall    | JOB-wide | yes — job_id is the ONLY linkage the table has (no run column), and job-wide is the correct recall breadth; the `attempt` column is deliberately NOT filtered |
// | 9 | countProducedOutputs arm 1              | committed workspace_patch job_artifact on       | PRECISION | attempt | yes, AS OF E7-F031. It was job-wide: a patch committed by attempt 2 proved capability for a run bound to attempt 1 |
// |   |                                         |   job_id, joined to the run's attempt NUMBER    |           |         |        |
// |10 | countProducedOutputs arm 2              | applied output_projection receipt on job_id     | PRECISION | attempt | yes, AS OF E7-F031. E7-F020 fixed its linkage and left it job-granular. DO NOT widen it to #7's union, and DO NOT copy its attempt conjunct into #7 |
// |   |                                         |   AND attempt_id = run.distributed_attempt_id   |           |         |        |
//
// #7 and #10 read the same table for opposite purposes and MUST stay divergent ON BOTH AXES:
// #10 is receipt-linked AND attempt-bound; #7 is union-linked AND job-wide. The divergence is
// the correct state; what was missing was a written reason, which is now at the #7 call site.
//
// ★ THE ONE MISMATCH THIS CENSUS PASS FOUND AND DID NOT FIX — row 4, filed as E7-F032. Row 4's
// old cell claimed "attempt_id is the only linkage the table has, and it is exact, so the two
// directions do not conflict here". That is true on the row axis and FALSE on the attempt axis:
// clause 5 wants this attempt's events and clause 4 wants the whole job's. Not fixed here
// because separating them needs a SECOND store method and widens what can hard-fail clause 4
// for every run, which wants its own pinning test and its own review — the same reason the
// column-set residual was deferred out of W21B rather than smuggled in. The sentence that
// claimed no conflict is corrected above, which is the load-bearing half: a census that
// asserts a coverage it does not have is worse than one that admits the gap.
//
// ★★ W21D APPLIED THAT SENTENCE TO THIS FILE AND THE FILE FAILED IT. Row 9's call-site
// comment warranted its attempt join by calling `commitArtifactVersion` "the sole writer" of
// `status='committed'`. There are TWO: `stageJobInputFiles` writes committed job_artifacts
// rows FENCELESS (leaseId/fenceToken NULL) on the same job_id and the same attempt number.
// The COUNT was and is right — those rows are `kind='staged_input'` — but the WARRANT was a
// coverage claim the census did not have, and it pointed at a remedy E7-F015 records as
// REFUTED. Corrected in full at the row-9 call site; no predicate changed.
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// ★★ CITE THIS FILE BY SYMBOL, NOT BY LINE (W21D).
//
// MEASURED at W21D: THIRTY line-pinned citations of the form
// `e7-distributed-run-verifier-store.ts:NNN` exist across THIRTEEN files, and every one was
// anchored to the pre-W21 layout. W21B and W21C moved every anchor 180-290 lines
// (`countProducedOutputs` 198 → 387, arm 1's `workspace_patch` conjunct 207 → 473, arm 2
// 213-216 → 514+). THREE sit in files this branch never otherwise touches, so nobody opened
// them while editing: a PRODUCTION comment in `packages/worker-daemon/src/lease/artifact-export.ts`,
// the LIVE wiring register `scripts/gate-clause-wiring.json`, and `scripts/finding-ownership.json`
// (E7-F015/F016/F019). Following the old `:207` today lands a reader inside
// `getAttemptTerminalReceipt` — a different function answering a different question.
//
// ★ NO POSITIONAL GUARD WAS ADDED, DELIBERATELY, and the argument is not a new one: this repo
// has already settled it. `scripts/lib/gate-clause-wiring.mjs` ("DOES NOT: pin LINE NUMBERS")
// states that a line citation rots on every unrelated edit above it, and that a guard which
// reds on unrelated edits gets switched off — this repo's own stated calibration. A
// content-checking variant is positional too and inherits the same failure mode, and it would
// red on the very sweep that FIXES the citations. So line pins stay author/review
// responsibility, exactly as that register says, and the durable fix is to stop minting them.
//
// ★ THE ANCHORS. Cite these NAMES; they do not move on an unrelated edit and they grep in one
// step. If you add a consumer, add its name here rather than a line number:
//
//   getRun / getAttempt / listLeases / listJobEvents / getAttemptTerminalReceipt
//   listRunSecretScanSurfaces  — clause 4's non-event scan surfaces (three sources:
//                                heartbeat_runs raw fields, the task_outputs UNION, job_artifacts)
//   countProducedOutputs       — clause 6. "arm 1" = committed `workspace_patch` job_artifacts
//                                joined to the run's attempt; "arm 2" = APPLIED
//                                `output_projection` receipt on task_outputs, job AND attempt
//   scanColumns                — the caller-authored task_outputs column set (W21B)
//
// Historical line pins inside DATED findings/result documents are left as written: they record
// what was measured on a given day, and rewriting them to today's layout would falsify the
// measurement rather than repair the citation. The LIVE registers and PRODUCTION comments were
// converted to symbols; the dated records carry a note pointing here instead.
// ═══════════════════════════════════════════════════════════════════════════════

import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  heartbeatRuns,
  jobAttempts,
  leases,
  jobEvents,
  jobProjectionReceipts,
  taskOutputs,
  jobArtifacts,
} from "@armyofagents/db";
import type {
  E7RunVerifierStore,
  E7RunRow,
  E7AttemptRow,
  E7LeaseRow,
  E7JobEventRow,
  E7AttemptTerminalReceiptRow,
  E7ScanSurface,
  E7ProducedOutputCounts,
} from "./e7-distributed-run-verifier.js";

function textOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/** The caller-authored columns of one `task_outputs` row, as clause 4 reads them. */
interface TaskOutputScanRow {
  readonly title: string | null;
  readonly url: string | null;
  readonly provider: string | null;
  readonly externalId: string | null;
  readonly healthStatus: string | null;
  readonly summary: string | null;
  readonly metadata: unknown;
}

/** One scan string per row. Space-joined so a matcher can never span two columns and
 * manufacture a hit out of two innocuous halves. */
function taskOutputScanText(row: TaskOutputScanRow): string {
  return [row.title, row.url, row.provider, row.externalId, row.healthStatus, row.summary, row.metadata]
    .map(textOf)
    .join(" ")
    .trim();
}

export function createDrizzleE7RunVerifierStore(db: Db): E7RunVerifierStore {
  return {
    getRun: async (runId: string): Promise<E7RunRow | null> => {
      const rows = await db
        .select({
          id: heartbeatRuns.id,
          companyId: heartbeatRuns.companyId,
          executionOwner: heartbeatRuns.executionOwner,
          distributedJobId: heartbeatRuns.distributedJobId,
          distributedAttemptId: heartbeatRuns.distributedAttemptId,
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          error: heartbeatRuns.error,
          finishedAt: heartbeatRuns.finishedAt,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1);
      return rows[0] ?? null;
    },

    getAttempt: async (attemptId: string): Promise<E7AttemptRow | null> => {
      const rows = await db
        .select({
          id: jobAttempts.id,
          organizationId: jobAttempts.organizationId,
          companyId: jobAttempts.companyId,
          jobId: jobAttempts.jobId,
          status: jobAttempts.status,
        })
        .from(jobAttempts)
        .where(eq(jobAttempts.id, attemptId))
        .limit(1);
      return rows[0] ?? null;
    },

    listLeases: async (attemptId: string): Promise<readonly E7LeaseRow[]> => {
      const rows = await db
        .select({ id: leases.id, companyId: leases.companyId, status: leases.status })
        .from(leases)
        .where(eq(leases.attemptId, attemptId));
      return rows;
    },

    listJobEvents: async (attemptId: string): Promise<readonly E7JobEventRow[]> => {
      const rows = await db
        .select({
          eventId: jobEvents.eventId,
          companyId: jobEvents.companyId,
          eventType: jobEvents.eventType,
          payload: jobEvents.event,
        })
        .from(jobEvents)
        .where(eq(jobEvents.attemptId, attemptId));
      return rows;
    },

    getAttemptTerminalReceipt: async (
      attemptId: string,
    ): Promise<E7AttemptTerminalReceiptRow | null> => {
      const rows = await db
        .select({
          projectionKind: jobProjectionReceipts.projectionKind,
          status: jobProjectionReceipts.status,
          companyId: jobProjectionReceipts.companyId,
        })
        .from(jobProjectionReceipts)
        .where(
          and(
            eq(jobProjectionReceipts.attemptId, attemptId),
            eq(jobProjectionReceipts.projectionKind, "attempt_terminal"),
          ),
        );
      if (rows.length === 0) return null;
      // Prefer an APPLIED receipt when one exists; otherwise surface a pending row so
      // the service can honestly report "receipt present but not applied".
      return rows.find((r) => r.status === "applied") ?? rows[0];
    },

    listRunSecretScanSurfaces: async (run: E7RunRow): Promise<readonly E7ScanSurface[]> => {
      const surfaces: E7ScanSurface[] = [];

      // (1) heartbeat_runs raw-at-rest text fields for THIS run (re-read; getRun
      // returns only the decision fields). detected_outputs is the agent-authored
      // field most likely to leak (§8 LOW 10).
      const runRows = await db
        .select({
          stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
          stderrExcerpt: heartbeatRuns.stderrExcerpt,
          error: heartbeatRuns.error,
          promptSnapshot: heartbeatRuns.promptSnapshot,
          detectedOutputs: heartbeatRuns.detectedOutputs,
          resultJson: heartbeatRuns.resultJson,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          usageJson: heartbeatRuns.usageJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run.id))
        .limit(1);
      const hb = runRows[0];
      if (hb) {
        for (const [field, value] of Object.entries(hb)) {
          const text = textOf(value);
          if (text) surfaces.push({ surface: "heartbeat_runs", fieldOrEventId: field, text });
        }
      }

      // (2) task_outputs belonging to this run — the UNION of BOTH provenance notions,
      //     de-duplicated by row id.
      //
      // ★★★ DO NOT "MAKE THIS CONSISTENT" WITH `countProducedOutputs`. STOP AND READ.
      // The two consumers of "which task_outputs rows belong to this run" want OPPOSITE
      // error directions, so one predicate cannot serve both:
      //
      //   * the COUNTER (arm 2 of clause 6) wants PRECISION. Over-counting prints a false
      //     `capability: PROVEN` over a row the platform wrote, which is E7-F020 — the whole
      //     reason arm 2 was narrowed to the fenced `output_projection` receipt. A row it is
      //     unsure about must NOT be counted.
      //   * this SCANNER (clause 4) wants RECALL. Under-scanning means a recognizable secret
      //     in a row's summary/metadata never reaches clause 4 and the verifier reports a
      //     clean mechanism/capability verdict OVER A LEAKED SECRET. Scanning a row that
      //     turns out not to belong to this run costs one redundant regex pass, and if it
      //     did trip a matcher it fails CLOSED (refuse to bless), never a false PASS.
      //
      // So: narrowing this to the receipt join (the "consistency" fix) would silently stop
      // scanning every legacy platform writer — including `emitRuntimeServiceTaskOutput`,
      // the one that needs nobody to do anything — and widening the counter to this union
      // would re-open E7-F020. Both directions are regressions. A positive control in
      // `e7-f020-arm2-provenance.integration.test.ts` reds on the first; the `[negative]`
      // and `[mixed]` arms there red on the second.
      //
      // ★ THE DEFECT THIS FIXES (E7-F030, introduced by W21 and caught in review). W21 moved
      // arm 2 onto the receipt and left this sibling on `created_by_run_id`. A row projected
      // through `jobOutputBridge.projectAcceptedOutput` with NO caller-supplied run id — the
      // case W21's own `[positive B]` test asserts is SUPPORTED — counted as capability
      // evidence and was never scanned for secrets.
      //
      // ★ TWO QUERIES PLUS A MERGE, deliberately, not one clever `OR`. A single statement
      // needs a LEFT JOIN with a four-conjunct ON clause, `OR r.id IS NOT NULL`, and a
      // DISTINCT over a jsonb column, and it has to degrade correctly when the run has no
      // `distributed_job_id`. Two SELECTs into a Map keyed by row id says exactly what it
      // means and is de-duplicated by construction.
      //
      // ★ NO COMPANY CONJUNCT ON (2a), unlike the counter's. Same reason: for a scanner a
      // cross-tenant row is a redundant scan whose worst case is an over-strict refusal,
      // while for the counter it would be an over-count. (RLS makes it moot in practice —
      // the CLI opens the DB in the run's tenant context — but the asymmetry is intentional.)
      // ★ NO ATTEMPT CONJUNCT ON (2a) EITHER, and this is now a THIRD asymmetry to preserve.
      // `countProducedOutputs` binds to `run.distributed_attempt_id` (E7-F031); this scanner
      // deliberately stays JOB-wide, so a secret in a SIBLING retry attempt's output is still
      // seen while verifying attempt 1. Narrowing it to the run's attempt is the same mirror
      // defect one axis over: the counter must not credit another attempt's work, and the
      // scanner must not miss another attempt's leak. `[sibling-scan]` in
      // `e7-f020-arm2-provenance.integration.test.ts` reds if this is "made consistent".
      const scanRows = new Map<string, TaskOutputScanRow>();

      // ★ THE SCANNED COLUMN SET IS EVERY CALLER-AUTHORED COLUMN, not just summary+metadata
      // (E7-F030's measured residual, fixed here). `BridgeOutputInput`
      // (`job-output-bridge.ts:68-87`) passes `title` (NOT NULL), `url`, `provider`,
      // `externalId` and `healthStatus` straight through to the row alongside `summary` and
      // `metadata` — all of them free text an agent's output event can set. A key planted in
      // `title` reached a row that was fetched and then contributed NO scan text at all,
      // because the concatenation only read the two columns. `type`, `status`, `reviewState`
      // and `isPrimary` are NOT included: they are closed enums / a boolean
      // (`validators/task-output.ts`) and cannot carry a value. Recall direction — the cost of
      // a wider column set is redundant regex passes over short enum-ish strings, and the hard
      // matchers (provider-key / e2b / connection-string / PEM) cannot be tripped by 'aoa' or
      // 'unknown'.
      const scanColumns = {
        id: taskOutputs.id,
        title: taskOutputs.title,
        url: taskOutputs.url,
        provider: taskOutputs.provider,
        externalId: taskOutputs.externalId,
        healthStatus: taskOutputs.healthStatus,
        summary: taskOutputs.summary,
        metadata: taskOutputs.metadata,
      } as const;

      // (2a) RECEIPT provenance — the rows arm 2 counts. Present here so a distributed
      // output is scanned whatever its `created_by_run_id` says (including NULL).
      if (run.distributedJobId) {
        const projected = await db
          .select(scanColumns)
          .from(taskOutputs)
          .innerJoin(jobProjectionReceipts, eq(jobProjectionReceipts.targetAggregateId, taskOutputs.id))
          .where(
            and(
              eq(jobProjectionReceipts.jobId, run.distributedJobId),
              eq(jobProjectionReceipts.projectionKind, "output_projection"),
              eq(jobProjectionReceipts.aggregateKind, "task_outputs"),
              eq(jobProjectionReceipts.status, "applied"),
            ),
          );
        for (const o of projected) scanRows.set(o.id, o);
      }

      // (2b) COLUMN provenance — every legacy platform writer that stamps this run's id
      // (`emitRuntimeServiceTaskOutput`, `POST /api/issues/:issueId/outputs`, …). Arm 2
      // deliberately stopped counting these; clause 4 must NOT stop scanning them.
      const columnLinked = await db
        .select(scanColumns)
        .from(taskOutputs)
        .where(eq(taskOutputs.createdByRunId, run.id));
      for (const o of columnLinked) scanRows.set(o.id, o);

      for (const [id, o] of scanRows) {
        const text = taskOutputScanText(o);
        if (text) surfaces.push({ surface: "task_outputs", fieldOrEventId: id, text });
      }

      // (3) job_artifacts for the distributed job (job id linkage). identifier /
      // object_key are the agent-influenced text; kind/status are enums.
      if (run.distributedJobId) {
        const artifacts = await db
          .select({ id: jobArtifacts.id, identifier: jobArtifacts.identifier, objectKey: jobArtifacts.objectKey })
          .from(jobArtifacts)
          .where(eq(jobArtifacts.jobId, run.distributedJobId));
        for (const a of artifacts) {
          const text = `${textOf(a.identifier)} ${textOf(a.objectKey)}`.trim();
          if (text) surfaces.push({ surface: "job_artifacts", fieldOrEventId: a.id, text });
        }
      }

      // NOTE — the run-summary `issue_comments` body is deliberately NOT scanned here.
      // A run-summary comment carries NO column identifying the RUN that authored it — it
      // is issue-scoped with authorType='system' (the one run↔comment pointer that exists,
      // heartbeat_runs.issueCommentSatisfiedByCommentId, is the reverse ask-human-ANSWER
      // link, not a run-summary key, and is unused in server/src). So attributing a summary
      // to THIS distributed run is indirect and would risk scanning a SIBLING run's summary
      // on the same task — a cross-run false HARD-fail. The comment body is a derived VIEW
      // of data A already scans at its SOURCE (detected_outputs above, task_outputs,
      // run.error), so nothing leak-relevant is lost. Scoped SHOULD-surface per design §7
      // open-Q2. Revisit if a run→summary-comment key is added.

      return surfaces;
    },

    countProducedOutputs: async (run: E7RunRow): Promise<E7ProducedOutputCounts> => {
      // ═══════════════════════════════════════════════════════════════════════════
      // ★★★ BOTH ARMS BIND TO THE RUN'S ATTEMPT, NOT ITS JOB (E7-F031).
      //
      // A job carries `max_attempts` (jobs.ts — NOT NULL, default 3) and EVERY attempt of it
      // shares the `job_id`. A heartbeat run is bound to exactly ONE attempt: `heartbeat_runs
      // .distributed_attempt_id`, written once by `buildHandoffRunPatch` and read as an exact
      // pair by the projector's `findRunForAttempt` (`heartbeat.ts:7061-7068`). The lifecycle
      // contract says the same thing in words — "the run is one attempt, not the source of
      // truth" (docs/architecture/distributed-execution-lifecycles.md, legacy concept mapping).
      //
      // Both arms filtered on `job_id` alone, so a workspace_patch committed by attempt 2, or
      // an output projected by attempt 2, printed `capability: PROVEN` for a run bound to
      // attempt 1 THAT PRODUCED NOTHING. That is the E7-F020 false-PROVEN class again on the
      // RETRY axis: W21 replaced a column-provenance bug with a granularity bug.
      //
      // ★ THIS IS NOT AN OVER-NARROWING, and the reason is measurable rather than aesthetic.
      // Nothing re-points `distributed_attempt_id` at a retry attempt — the column has exactly
      // ONE writer in the tree and it runs at handoff. So on a retried job the control plane
      // itself does not attribute attempt 2 to this run: `findRunForAttempt` finds no run for
      // attempt 2's terminal, the run is never finalized from it, and clause 3 refuses the run
      // for want of a durable terminal. Counting attempt 2's work for attempt 1's run was the
      // anomaly. And the arm stays PASSABLE: the `[own arm2]` / `[own arm1]` positive controls
      // in `e7-f020-arm2-provenance.integration.test.ts` count a real receipt and a real
      // committed patch on the run's own attempt.
      //
      // ★ THE NULL CASE FAILS CLOSED, deliberately. A run with a `distributed_job_id` and NO
      // `distributed_attempt_id` counts 0 on both arms instead of widening back to job scope.
      // Reachable only on a partially-written row (the sole writer sets both atomically), and
      // clause 2 already REFUSES such a row for incomplete evidence binding — so printing
      // PROVEN beside that refusal, on work no attempt of this run can be shown to have done,
      // is precisely the false-PROVEN this closes. A precision consumer excludes when unsure.
      //
      // ★ THE SECRET SCANNER IS NOT CHANGED AND MUST NOT BE. External review asked for this
      // predicate on `listRunSecretScanSurfaces` too; that would be a REGRESSION. See the
      // census (#7/#8) and the "DO NOT MAKE THIS CONSISTENT" block at that call site.
      // ═══════════════════════════════════════════════════════════════════════════
      const attemptId = run.distributedAttemptId;
      let workspacePatchArtifacts = 0;
      if (run.distributedJobId && attemptId) {
        // `job_artifacts.attempt` is the attempt NUMBER, not an id, so the binding goes
        // through `job_attempts`. Every `status='committed'` row carries it.
        //
        // ★★ THE COMMITTED-STATUS WRITER CENSUS IS **TWO**, NOT ONE (corrected W21D, E7-F033).
        // This comment used to warrant the attempt join by calling `commitArtifactVersion`
        // "the sole writer of that status". That is FALSE, and the false half was the
        // load-bearing half:
        //
        //   1. `commitArtifactVersion` (`repositories/tenant/job-control.ts:2779-2784`) —
        //      FENCED. Stamps `attempt: input.attemptNumber`, `leaseId` and `fenceToken`
        //      from the live fence, and `job_artifacts_committed_identity_uidx` is keyed on
        //      the attempt.
        //   2. `stageJobInputFiles` (`services/job-input-staging.ts:372-386`) — **FENCELESS**.
        //      Writes `status: "committed"` with `leaseId: null, fenceToken: null`, on the
        //      SAME `job_id` and the SAME attempt NUMBER this run is bound to, for every task
        //      run that stages inputs (`run-execution-owner.ts:361-368`). No fence has ever
        //      existed for that attempt at that point, by design.
        //
        // ★ THE COUNT IS UNCHANGED AND CORRECT — it is the WARRANT that was wrong. Writer 2's
        // rows carry `kind = 'staged_input'` (`job-input-staging.ts:64`), and the `kind` conjunct
        // below excludes them. So ARM 1'S PRECISION RESTS ON THE `kind` CONJUNCT ALONE. It does
        // NOT rest on "committed implies fenced", which is simply not true of this table.
        //
        // ★★★ WHY SAYING THIS PRECISELY MATTERS MORE THAN A COMMENT USUALLY DOES. A reader who
        // believed "committed implies fenced" would conclude the `kind` conjunct is redundant
        // and drop it. `scripts/finding-ownership.json` (E7-F015) records that exact remedy as
        // REFUTED and "strictly worse than the forgery this finding names" — dropping `kind`
        // leaves `job_id` + `status='committed'`, which writer 2 satisfies on every converted
        // run, so arm 1 would count THE RUN'S OWN INPUT as agent capability, with no export and
        // no producer. The old sentence would have led a reader straight into it.
        //
        // The thin `authorizeArtifactCommit` rows that leave `attempt` NULL also leave `status`
        // NULL, so they were never counted here in the first place.
        const artifactRows = await db
          .select({ id: jobArtifacts.id })
          .from(jobArtifacts)
          .innerJoin(
            jobAttempts,
            and(
              eq(jobAttempts.jobId, jobArtifacts.jobId),
              eq(jobAttempts.attemptNumber, jobArtifacts.attempt),
            ),
          )
          .where(
            and(
              eq(jobArtifacts.jobId, run.distributedJobId),
              eq(jobArtifacts.kind, "workspace_patch"),
              eq(jobArtifacts.status, "committed"),
              eq(jobAttempts.id, attemptId),
              eq(jobAttempts.companyId, run.companyId),
            ),
          );
        workspacePatchArtifacts = new Set(artifactRows.map((r) => r.id)).size;
      }
      // ARM 2 — task_outputs of DISTRIBUTED PROVENANCE, and nothing else (E7-F020).
      //
      // ★★★ WHY THE PREDICATE IS A RECEIPT JOIN AND NOT `created_by_run_id = run.id`.
      // The old predicate was the whole of arm 2 and it filtered on NOTHING but a run
      // linkage that ANY writer of `task_outputs` can set. `upsertTaskOutputForIssue`
      // (`services/task-outputs.ts:135`) is the single INSERT into the table, and
      // enumerating ITS callers — not grepping for the column name — closes the writer
      // census. Eleven production call sites; ten legacy, four of those able to carry a
      // `heartbeat_runs` id, TWO of them able to fire for a handed-off run:
      //
      //   * `task-output-emitters.ts:113` `emitRuntimeServiceTaskOutput`, reached from
      //     `ensureRuntimeServicesForRun` (`heartbeat.ts:4524`) BEFORE the handoff, on the
      //     DEFAULT isolated-workspace configuration, whenever the run declares one
      //     `workspaceRuntime.services[]` entry — nobody has to do anything (E7-F020);
      //   * `routes/task-outputs.ts:54` `POST /api/issues/:issueId/outputs`, which takes
      //     `createdByRunId` from the request body (E7-F015).
      //
      // Both wrote a row this counter read as "the agent produced something". Neither
      // does now: the predicate below does not read `created_by_run_id` at all.
      //
      // WHAT IT ADMITS — exactly one writer. `jobOutputBridge.projectAcceptedOutput`
      // (`job-output-bridge.ts:303`) is the ONLY code in the tree that writes a
      // `job_projection_receipts` row with `projection_kind = 'output_projection'` and
      // `aggregate_kind = 'task_outputs'` (`:306-315`), and it writes it in the SAME
      // tenant transaction as the output, with `target_aggregate_id` = the row it just
      // wrote. `recordGovernedProjection` is the sole INSERT path for that receipt
      // (`repositories/tenant/job-control.ts:3794`) and it runs `guardActiveFence` FIRST,
      // so `job_id` / `attempt_id` are the control plane's LIVE fence — server-verified,
      // never a caller's assertion. So a counted row exists only because a distributed
      // attempt on THIS run's job had an accepted output event projected under an active
      // lease fence. That is provenance, not a heuristic over `type` or `provider`.
      //
      // WHAT IT EXCLUDES — every one of the ten legacy callers, including both live
      // writers above. None of them writes a receipt and none of them can: the receipt
      // insert is fence-guarded on a live distributed attempt, which a pre-handoff
      // heartbeat emitter and an HTTP route do not have.
      //
      // ★ FAIL-CLOSED IN BOTH DIRECTIONS, deliberately. A run missing EITHER distributed id
      // counts 0 without issuing a query — no distributed job, no distributed output; no
      // attempt, nothing to attribute an output to (E7-F031's null case) — which also closes
      // E7-F020's weaker form (pointing the verifier at an ORDINARY heartbeat run used to
      // print `capability: PROVEN`). The company conjuncts mean a tenant mismatch UNDER-counts
      // rather than over-counts.
      //
      // ★ TWO BOUNDED NOTES, stated rather than hidden. (a) One output row can carry more
      // than one receipt — `upsertTaskOutputForIssue` UPDATES in place on
      // (company, issue, provider, external_id), so two accepted events with the same
      // provider identity link the same row twice — so rows are DEDUPED by id; arm 2 is a
      // count of ROWS, as it always was. (b) A quarantined (stale/losing) output still
      // carries a receipt and is still counted: it is a real agent output that reached
      // AoA, which is exactly what this arm asks.
      //
      // ★ WHAT THIS DOES NOT BUY, and it is most of what there is: E7-F018 measured that
      // NO checked-in configuration makes any run a distributed run, and that
      // `projectAcceptedOutput` has ZERO production callers. So this predicate admits a
      // writer nothing calls, on a path nothing arms: arm 2 reads 0 on every real run
      // today. The gate is now correctly CLOSED where it was falsely open. It is not
      // working, and `capabilityProven` still gates nothing (no workflow or script reads
      // it). Do not read a change here as progress toward a green campaign.
      let distributedTaskOutputs = 0;
      if (run.distributedJobId && attemptId) {
        const outputRows = await db
          .select({ id: taskOutputs.id })
          .from(taskOutputs)
          .innerJoin(
            jobProjectionReceipts,
            eq(jobProjectionReceipts.targetAggregateId, taskOutputs.id),
          )
          .where(
            and(
              eq(jobProjectionReceipts.jobId, run.distributedJobId),
              // E7-F031 — the attempt conjunct. `attempt_id` is NOT NULL on every receipt and
              // comes from the control plane's LIVE fence (`recordGovernedProjection` runs
              // `guardActiveFence` first), so it is a server-verified fact about WHICH attempt
              // produced the output, never a caller's assertion. The job conjunct is kept
              // beside it: the pair is the receipt's composite tenant FK to the attempt, and
              // keeping both means a mismatched pair selects nothing rather than trusting one.
              eq(jobProjectionReceipts.attemptId, attemptId),
              eq(jobProjectionReceipts.projectionKind, "output_projection"),
              eq(jobProjectionReceipts.aggregateKind, "task_outputs"),
              eq(jobProjectionReceipts.status, "applied"),
              eq(jobProjectionReceipts.companyId, run.companyId),
              eq(taskOutputs.companyId, run.companyId),
            ),
          );
        distributedTaskOutputs = new Set(outputRows.map((r) => r.id)).size;
      }
      return { workspacePatchArtifacts, taskOutputs: distributedTaskOutputs };
    },
  };
}
