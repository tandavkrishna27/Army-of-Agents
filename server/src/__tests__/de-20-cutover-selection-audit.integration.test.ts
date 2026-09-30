/**
 * DE-20, `audit` clause — SELECTION HALF (conjunct 4a). BOTH arms of the cutover
 * decision leave a durable row, so "the cutover selected legacy" stops being
 * indistinguishable from "this run was never a cutover candidate".
 *
 * ★ WHAT THIS TEST IS FOR, MEASURED AT SOURCE AT `6b39c77f6`.
 * `docs/architecture/distributed-execution-threat-controls.json` DE-20 asserts
 * "cutover selection and rollback transitions are audited". The SELECTION
 * conjunct was HALF delivered. ★ THE LINE NUMBERS BELOW ARE AT THE BASE COMMIT
 * `6b39c77f6`, BEFORE this change; the numbers AFTER it follow, because this very
 * edit SHIFTS the lines it cites and a unit that moves a line and then recites the
 * old number is exactly how this register went stale twice.
 *   - a DISTRIBUTED selection wrote one `distributed_execution_handoff`
 *     `heartbeat_run_events` row — the `appendRunEvent(...)` call inside
 *     `markRunHandedOffToDistributed` (`heartbeat.ts`, ~`:6994` at HEAD).
 *     ★ CITED BY SYMBOL: the `:6986` this line used to carry was itself stale,
 *     computed as base + a delta rather than measured;
 *   - a LEGACY selection wrote NOTHING DURABLE. `canaryExecutionOwner` was
 *     assigned at `heartbeat.ts:5315-5336` (base), `shouldSuppressLegacyExecution`
 *     (`:5399` base -> `:5457` now) returned false, and control fell through to
 *     `adapter.execute` (`:5453` base -> `:5511` now). The only trace was a
 *     `logger.info` line. The new append is at `:5388`.
 * Both base line numbers were re-verified at source rather than inherited from the
 * register, and both were exact; the post-change numbers were re-measured after.
 *
 * ★★★ WHAT THIS FILE DOES NOT PROVE. DE-20's `audit` clause is a CONJUNCTION:
 * "cutover selection AND ROLLBACK TRANSITIONS are audited". The ROLLBACK conjunct
 * (4b) is VACUOUS and is untouched here — `createDistributedExecutionDrain`
 * (`server/src/services/job-distributed-drain.ts:114`) has zero production
 * callers, so removing an organization from the rollout dial cancels nothing in
 * flight and there is no rollback transition to record. That conjunct belongs to
 * `E0-F013` Decision 1 and `E0-F014`. An arm below PINS the zero-caller fact, so
 * the day a caller appears this file goes red naming it rather than quietly
 * leaving the clause half-audited.
 *   ⇒ **DE-20 DOES NOT CLOSE ON THIS FILE AND STAYS `partial`.**
 * Nor does this touch the separately-amended `revocation` clause.
 *
 * ★ WHY THE WRITER IS PROVOKED DIRECTLY AND THE POSITION IS ASSERTED
 * STRUCTURALLY. `executeRun` is ~2,700 lines with a dependency surface that is
 * impractical to instantiate in-process — the standing CLI-003/005/006
 * limitation, recorded as Risk #2 in CLI-006's design and honoured by
 * `cli-006-seam-suppression.test.ts`, which asserts the suppression RETURN's
 * position against the source for exactly this reason. So this file proves the
 * two halves that can each be proven:
 *   1. THE ROW. `buildCutoverSelectionEvent` + the real `heartbeat_run_events`
 *      table on real PostgreSQL, for BOTH arms, with the real payload.
 *   2. THE POSITION. The call site sits AFTER `canaryExecutionOwner` is assigned
 *      and BEFORE `shouldSuppressLegacyExecution` reads it — asserted against
 *      `heartbeat.ts` itself, by byte offset. That ordering is what makes "both
 *      arms are audited" structural: no arm of the cutover can reach the
 *      executor without passing this write.
 *
 * ★ WHY THE OWNER CONNECTION AND NOT `aoa_app`, STATED BECAUSE IT DIFFERS FROM
 * ITS SIBLING FILES. `heartbeat_run_events` is NOT in the tenant-kernel grant set
 * (`server/src/db/job-control-legacy-grants.ts` grants `aoa_app` only
 * `heartbeat_runs`), and `heartbeatService` is constructed in
 * `server/src/index.ts:1539` with the ORDINARY product `db`, not
 * `distributedExecutionDatabases.appDb`. The owner connection IS the real role
 * for this writer, so using it is fidelity and not a shortcut. An arm below
 * asserts BOTH facts against the live database, so a future migration that moves
 * `heartbeat_run_events` into the kernel fails here naming the change.
 *
 * Real Postgres (embedded-postgres + the committed migration chain). No stubs on
 * the event builder and none on the table.
 *
 * Skipped on Windows CI by default (Issue #114); Linux CI `push` is the
 * authoritative gate. On a Windows dev box set `AOA_RUN_WIN_INTEGRATION=1`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import postgres, { type Sql } from "postgres";
import { applyPendingMigrations } from "@armyofagents/db";
import {
  CUTOVER_SELECTION_EVENT_TYPE,
  buildCutoverSelectionEvent,
} from "../services/cutover-selection-audit.js";
import type { RunExecutionOwner } from "../services/run-execution-owner.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "de200000-0000-4000-8000-000000000000";
const COMPANY = "de200000-0000-4000-8000-000000000001";
const AGENT = "de200000-0000-4000-8000-000000000002";
const RUN_DISTRIBUTED = "de200000-0000-4000-8000-00000000000a";
const RUN_LEGACY = "de200000-0000-4000-8000-00000000000b";
const JOB = "de200000-0000-4000-8000-00000000000c";
const ATTEMPT = "de200000-0000-4000-8000-00000000000d";

const HEARTBEAT_SOURCE = new URL("../services/heartbeat.ts", import.meta.url);

const SERVER_SRC = fileURLToPath(new URL("..", import.meta.url));

/** Strip line comments and block comments so a symbol NAMED IN PROSE is not
 * counted as a caller. This is the whole difference between a census and a grep,
 * and the first draft of the rollback arm below got it wrong. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * How many files under `server/src` REFERENCE `symbol` in code (not prose),
 * excluding tests and excluding the file that DECLARES it. This is the
 * measurement the register's "zero production callers" claim actually makes.
 */
function productionCallerCount(symbol: string): number {
  const declRe = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class)\\s+${symbol}\\b`);
  const useRe = new RegExp(`\\b${symbol}\\b`);
  let count = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      const code = stripComments(readFileSync(full, "utf8"));
      if (declRe.test(code)) continue; // the declaration site is not a caller
      if (useRe.test(code)) count += 1;
    }
  };
  walk(SERVER_SRC);
  return count;
}

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

interface EventRow {
  run_id: string;
  seq: number;
  event_type: string;
  stream: string | null;
  level: string | null;
  message: string | null;
  payload: Record<string, unknown> | null;
}

integration("DE-20 (selection half) — BOTH arms of the cutover leave a durable row", () => {
  let embedded: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let db: Sql | null = null;
  let setupError: unknown = null;

  function ctx() {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    if (!db) throw new Error("test setup incomplete");
    return db;
  }

  /** The real append, against the real table, with the real builder's output. */
  async function appendSelection(runId: string, owner: RunExecutionOwner): Promise<void> {
    const sql = ctx();
    const event = buildCutoverSelectionEvent(owner);
    const maxRows = await sql<{ value: number | null }[]>`
      SELECT max(seq) AS value FROM heartbeat_run_events WHERE run_id = ${runId}`;
    const seq = (maxRows[0]?.value ?? 0) + 1;
    await sql`INSERT INTO heartbeat_run_events
      (company_id, run_id, agent_id, seq, event_type, stream, level, message, payload)
      VALUES (${COMPANY}, ${runId}, ${AGENT}, ${seq}, ${event.eventType}, ${event.stream},
        ${event.level}, ${event.message}, ${event.payload})`;
  }

  async function selectionRowsFor(runId: string): Promise<EventRow[]> {
    const sql = ctx();
    return (await sql<EventRow[]>`
      SELECT run_id, seq, event_type, stream, level, message, payload
      FROM heartbeat_run_events
      WHERE run_id = ${runId} AND event_type = ${CUTOVER_SELECTION_EVENT_TYPE}
      ORDER BY seq`) as unknown as EventRow[];
  }

  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-de020-"));
      const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
      const port = await allocateEmbeddedPgPort();
      embedded = new EmbeddedPostgres({
        databaseDir: join(dataDir, "db"), user: "test", password: "test", port,
        persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"],
      });
      await embedded.initialise();
      await embedded.start();
      const adminUrl = `postgres://test:test@127.0.0.1:${port}/postgres`;
      await applyPendingMigrations(adminUrl);
      db = postgres(adminUrl, { max: 4 });
      await db`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'DE-20 org', 'de-020-org')`;
      await db`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'DE-20 company', 'D020')`;
      await db`INSERT INTO agents (id, company_id, name, adapter_type, status)
        VALUES (${AGENT}, ${COMPANY}, 'DE-20 agent', 'claude_local', 'idle')`;
      for (const runId of [RUN_DISTRIBUTED, RUN_LEGACY]) {
        await db`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, started_at)
          VALUES (${runId}, ${COMPANY}, ${AGENT}, 'running', clock_timestamp())`;
      }
    } catch (error) {
      setupError = error;
    }
  }, 180_000);

  afterAll(async () => {
    await db?.end().catch(() => {});
    await embedded?.stop().catch(() => {});
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  it("setup: neither run has a selection event yet", async () => {
    ctx();
    expect(await selectionRowsFor(RUN_DISTRIBUTED)).toHaveLength(0);
    expect(await selectionRowsFor(RUN_LEGACY)).toHaveLength(0);
  });

  it("★ THE ARM THAT ALREADY WORKED — a DISTRIBUTED selection writes a durable selection row naming the job and attempt", async () => {
    await appendSelection(RUN_DISTRIBUTED, { owner: "distributed", jobId: JOB, attemptId: ATTEMPT });

    const rows = await selectionRowsFor(RUN_DISTRIBUTED);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.event_type).toBe(CUTOVER_SELECTION_EVENT_TYPE);
    expect(row.stream).toBe("system");
    expect(row.payload?.owner).toBe("distributed");
    expect(row.payload?.jobId).toBe(JOB);
    expect(row.payload?.attemptId).toBe(ATTEMPT);
    // No legacy reason on this arm — the fields are not stamped, they are read
    // from the decision.
    expect(row.payload?.reason).toBeNull();
  });

  it("★★★ THE ARM THAT WROTE NOTHING — a LEGACY selection now writes a durable row, and it says WHY legacy was chosen", async () => {
    await appendSelection(RUN_LEGACY, {
      owner: "legacy",
      reason: "workload_unavailable",
      detail: "instructions_unreadable: bundle missing",
    });

    const rows = await selectionRowsFor(RUN_LEGACY);
    // THE assertion this file exists for. Before the wiring this was zero.
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.event_type).toBe(CUTOVER_SELECTION_EVENT_TYPE);
    expect(row.payload?.owner).toBe("legacy");
    // ★ WHY. Without this the legacy row would say a selection happened and never
    // say why — the count-only shape this crossing already had at the metric
    // layer, and the exact blindness heartbeat.ts's own comment names for the log.
    expect(row.payload?.reason).toBe("workload_unavailable");
    expect(row.payload?.detail).toBe("instructions_unreadable: bundle missing");
    // A legacy selection has no distributed job, and the row says so rather than
    // carrying a stale or invented id.
    expect(row.payload?.jobId).toBeNull();
    expect(row.payload?.attemptId).toBeNull();
  });

  it("★ THE TWO ARMS ARE TOLD APART — one query answers 'which owner did the cutover select for this run', for every run", async () => {
    const sql = ctx();
    const rows = await sql<{ run_id: string; owner: string }[]>`
      SELECT run_id, payload->>'owner' AS owner
      FROM heartbeat_run_events
      WHERE event_type = ${CUTOVER_SELECTION_EVENT_TYPE}
      ORDER BY run_id`;
    const byRun = new Map(rows.map((r) => [r.run_id, r.owner]));
    expect(byRun.get(RUN_DISTRIBUTED)).toBe("distributed");
    expect(byRun.get(RUN_LEGACY)).toBe("legacy");
    // ★ And this is the property the whole conjunct is about: a run that stayed
    // legacy is now DISTINGUISHABLE from a run that was never a candidate, which
    // has NO row at all.
    expect(byRun.size).toBe(2);
  });

  it("★ THE BUILDER IS TOTAL — every legacy reason declared in the source produces a record, so a new reason cannot silently write nothing", () => {
    // Read the union from the declaration rather than restating it: the same
    // technique `cli-006-seam-suppression.test.ts` uses, and for the same reason
    // — a compile-time union has no runtime residue.
    const source = readFileSync(new URL("../services/run-execution-owner.ts", import.meta.url), "utf8");
    const start = source.indexOf("export type LegacyOwnerReason =");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf(";", start));
    const reasons = [...block.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1]!);
    // ANTI-VACUITY — a malformed parse yields a short list, which would make the
    // loop below pass by doing nothing.
    expect(reasons.length).toBeGreaterThanOrEqual(3);
    for (const reason of reasons) {
      const event = buildCutoverSelectionEvent({ owner: "legacy", reason } as RunExecutionOwner);
      expect(event.eventType).toBe(CUTOVER_SELECTION_EVENT_TYPE);
      expect(event.payload.owner).toBe("legacy");
      expect(event.payload.reason).toBe(reason);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE POSITION. `executeRun` cannot be instantiated in-process, so the
  // ordering property is asserted against the source — the same technique, and
  // the same justification, as `cli-006-seam-suppression.test.ts`.
  // ───────────────────────────────────────────────────────────────────────────

  it("★★★ THE POSITION IS THE FIX — the append sits AFTER the owner is assigned and BEFORE the suppression branch reads it, so NO arm of the cutover can reach the executor unaudited", () => {
    const source = readFileSync(HEARTBEAT_SOURCE, "utf8");

    const assignment = source.indexOf("canaryExecutionOwner = canaryWorkload.ok");
    const append = source.indexOf("buildCutoverSelectionEvent(canaryExecutionOwner)");
    const suppression = source.indexOf("if (shouldSuppressLegacyExecution(canaryExecutionOwner))");
    const adapterExecute = source.indexOf("adapterResult = await adapter.execute({");

    // ANTI-VACUITY — every anchor must be found. `indexOf` returns -1 on a miss,
    // and -1 < everything, so an unfound anchor would satisfy the ordering
    // assertions below by accident. This is the guard against that.
    expect(assignment).toBeGreaterThan(-1);
    expect(append).toBeGreaterThan(-1);
    expect(suppression).toBeGreaterThan(-1);
    expect(adapterExecute).toBeGreaterThan(-1);

    // The ordering itself.
    expect(append).toBeGreaterThan(assignment);
    expect(append).toBeLessThan(suppression);
    expect(append).toBeLessThan(adapterExecute);

    // ★ EXACTLY ONE call site. Two would reintroduce the defect: a per-arm writer
    // is precisely how one arm ends up audited and the other does not.
    const callSites = source.split("buildCutoverSelectionEvent(").length - 1;
    expect(callSites).toBe(1);
  });

  it("★★★ THE SEQ COMES FROM THE IN-PROCESS COUNTER, NOT A `max(seq)` READ — a max-based append would silently collide with the very next lifecycle event on the LEGACY arm", () => {
    // Codex P2 on PR #409, verified at source and fixed. At the append site the
    // local counter is already 2 (the "run started" lifecycle event consumed 1)
    // while the durable max is 1, so `projectionSeqBase(max) + 1` ALSO yields 2 and
    // leaves the counter untouched — the next `seq++` event reuses 2.
    // `heartbeat_run_events` carries only a NON-UNIQUE `(run_id, seq)` index, so
    // nothing errors: two rows silently interleave and a resume-by-seq reader can
    // drop one. It bites ONLY the legacy arm, because the distributed arm returns
    // at the suppression seam and never appends again — i.e. exactly the arm this
    // change adds. Asserted structurally, for the same reason the position is.
    const source = readFileSync(HEARTBEAT_SOURCE, "utf8");
    const appendIdx = source.indexOf("buildCutoverSelectionEvent(canaryExecutionOwner)");
    expect(appendIdx).toBeGreaterThan(-1);
    const stmtStart = source.lastIndexOf("await appendRunEvent(", appendIdx);
    expect(stmtStart).toBeGreaterThan(-1);
    const stmt = source.slice(stmtStart, appendIdx);
    // It takes the shared counter...
    expect(stmt).toContain("seq++");
    // ...and NOT a per-append max read, which is right in
    // `markRunHandedOffToDistributed` (outside `executeRun`, no counter in scope)
    // and wrong here.
    expect(stmt).not.toContain("projectionSeqBase");

    // ANTI-VACUITY — `markRunHandedOffToDistributed` really does still use the
    // max-based form, so this arm asserts a DIFFERENCE between two real call sites
    // rather than a property no site has.
    const handoffIdx = source.indexOf('eventType: "distributed_execution_handoff"');
    expect(handoffIdx).toBeGreaterThan(-1);
    const handoffStmt = source.slice(source.lastIndexOf("await appendRunEvent(", handoffIdx), handoffIdx);
    expect(handoffStmt).toContain("projectionSeqBase");
  });

  it("★★★ THE ROLLBACK CONJUNCT IS STILL VACUOUS, AND THAT IS PINNED BY A REAL CENSUS — `createDistributedExecutionDrain` still has ZERO production callers, so DE-20 does NOT close", () => {
    // DE-20's audit clause is "cutover selection AND rollback transitions". This
    // file delivers the first. The second cannot be delivered because the
    // TRANSITION DOES NOT OCCUR: the org-wide drain has no caller, so removing an
    // organization from the rollout dial cancels nothing in flight — it only
    // changes what the NEXT wake resolves. If a caller ever appears, this arm goes
    // red NAMING the change rather than leaving the clause quietly half-audited.
    //
    // ★ WHY A CENSUS AND NOT A `not.toContain` ON ONE FILE. The first version of
    // this arm asserted `heartbeat.ts` does not contain the symbol — and it went
    // RED against the wiring in this very PR, because the wiring's own COMMENT
    // names the symbol while explaining that it has no callers. A prose match is
    // not a caller census. This strips comments first and walks the whole of
    // `server/src`, which is what the register's claim actually means.
    expect(productionCallerCount("createDistributedExecutionDrain")).toBe(0);
  });

  it("ANTI-VACUITY FOR THE CENSUS — the same census returns NON-ZERO for a symbol that genuinely has production callers", () => {
    // Without this, a census that silently matched nothing (a bad regex, a wrong
    // root, a comment-stripper that ate the code) would report every symbol as
    // uncalled and the arm above would pass by being broken.
    expect(productionCallerCount("shouldSuppressLegacyExecution")).toBeGreaterThan(0);
    expect(productionCallerCount("buildCutoverSelectionEvent")).toBeGreaterThan(0);
  });

  it("★ STORAGE POSTURE — `heartbeat_run_events` is outside the tenant kernel and is written by the OWNER connection, which is what production does", async () => {
    const sql = ctx();
    // (1) The table is not RLS-forced, against a positive control that a
    // kernel table on the SAME database is.
    const rows = await sql<{ relname: string; relforcerowsecurity: boolean }[]>`
      SELECT relname, relforcerowsecurity FROM pg_class
      WHERE relname IN ('heartbeat_run_events', 'job_attempts')`;
    const byName = new Map(rows.map((r) => [r.relname, r.relforcerowsecurity]));
    expect(byName.get("heartbeat_run_events")).toBe(false);
    expect(byName.get("job_attempts")).toBe(true);

    // (2) And the grant set really does exclude it, which is why this file uses
    // the owner connection rather than `aoa_app`. Read from the grant module
    // itself so a future grant addition fails here rather than making this file's
    // rationale silently wrong.
    const grants = readFileSync(
      new URL("../db/job-control-legacy-grants.ts", import.meta.url),
      "utf8",
    );
    expect(grants).toContain("heartbeat_runs:");
    expect(grants).not.toContain("heartbeat_run_events:");
  });
});
