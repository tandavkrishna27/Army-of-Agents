/**
 * U6.5 — Crew A+ capture: real-Postgres proof of the crew run-id FK path.
 *
 * The unit suite (crew-output-capture.test.ts) stubs `taskOutputService`
 * entirely, so it never exercises `task_outputs.createdByRunId`'s FK to
 * `heartbeat_runs` or `taskOutputService.upsertForIssue`'s pre-insert
 * `assertCompanyOwnedRef` assertion against that table — a unit-only suite
 * here would be FALSE-GREEN (see the wave header + crew-output-capture.ts's
 * module doc): a crew run id is minted into `internal_agent_runs`, a
 * DIFFERENT table, so passing it as `createdByRunId` would FK-fail (and the
 * assertion 404s first) on a real database. This suite drives
 * `captureCrewOutputs` against the REAL `taskOutputService(db)` on embedded
 * Postgres and proves:
 *   1. the null-run-id + `metadata.crewRunId` path persists cleanly, and
 *   2. the negative control — passing the crew run id AS `createdByRunId`
 *      directly — is REJECTED with the real assert message.
 *
 * Skipped on Windows by default (CI's `runneradmin` account can't start
 * embedded-postgres — Issue #114); Linux CI is the authoritative gate. On a
 * Windows dev box set `AOA_RUN_WIN_INTEGRATION=1` to run it for real — the
 * UTF-8 initdbFlags below make the cluster locale-safe. Modeled on
 * crew-run-log-pointer.integration.test.ts / w3a-crew-loopback.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  internalAgentRuns,
  type Db,
} from "@armyofagents/db";
import { taskOutputService } from "../services/task-outputs.js";
import type { SandboxExecuteResult, SandboxFileMovementRunner } from "../services/sandbox-file-movement.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let storageDir = "";
let db: Db;
let setupError: unknown = null;
let setupFailed = false;

/** Fail LOUDLY and ONCE when embedded-postgres never came up (mirrors crew-run-log-pointer). */
function assertSetupOk(): void {
  const dbReady = (db as Db | undefined) !== undefined;
  if (!setupFailed && dbReady) return;
  throw new Error(
    `embedded-postgres setup failed (see the console.error above): ${
      setupError instanceof Error ? setupError.message : String(setupError)
    }`,
  );
}

// Offset away from the other suites' embedded-postgres port ranges.
const PORT = 62200 + Math.floor(Math.random() * 400);

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []) as Array<
    Record<string, unknown>
  >;
}

// companies.issue_prefix is globally unique, so seeds are numbered rather than randomized.
let seedCounter = 0;

/** Seed a company + one crew agent — the FK parents of an internal_agent_runs row + task_outputs.createdByAgentId. */
async function seedCompanyAndCrewAgent(label: string): Promise<{
  companyId: string;
  agentId: string;
}> {
  const companyId = randomUUID();
  seedCounter += 1;
  await db.execute(sql`
    INSERT INTO companies (organization_id, id, name, issue_prefix)
    VALUES ('00000000-0000-0000-0000-000000000001', ${companyId}, ${`U6.5 ${label} Co`}, ${`U65${seedCounter}`})
  `);
  const [agent] = rowsOf(
    await db.execute(sql`
      INSERT INTO agents (id, company_id, name, kind, status)
      VALUES (gen_random_uuid(), ${companyId}, ${`Engineer ${label}`}, 'aoa', 'idle')
      RETURNING id
    `),
  );
  return { companyId, agentId: String(agent.id) };
}

/** Seed a minimal issues row (only company_id + title are NOT NULL). */
async function seedIssue(companyId: string, title: string): Promise<string> {
  const [issue] = rowsOf(
    await db.execute(sql`
      INSERT INTO issues (id, company_id, title)
      VALUES (gen_random_uuid(), ${companyId}, ${title})
      RETURNING id
    `),
  );
  return String(issue.id);
}

/** Insert a crew run row into internal_agent_runs — NOT heartbeat_runs (the whole point of U6.5). */
async function seedCrewRun(companyId: string, agentId: string): Promise<string> {
  const [run] = await db
    .insert(internalAgentRuns)
    .values({
      companyId,
      agentId,
      triggerType: "sub_agent",
      triggerSource: "discussion_entry",
      status: "running",
    })
    .returning({ id: internalAgentRuns.id });
  return run!.id;
}

const REMOTE_CWD = "/home/user/aoa-workspace";

/** A minimal sandbox double serving two produced files to collectSandboxDiff. */
function makeSandboxRunner(files: Record<string, Buffer>): SandboxFileMovementRunner {
  const paths = Object.keys(files);
  return {
    async execute(input): Promise<SandboxExecuteResult> {
      const script = typeof input.args?.[1] === "string" ? input.args[1] : "";
      if (script.includes("diff --name-only HEAD")) {
        return { exitCode: 0, signal: null, timedOut: false, stdout: paths.join("\n"), stderr: "" };
      }
      if (script.includes("ls-files --others --exclude-standard")) {
        return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
      }
      return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: `unrecognized: ${script}` };
    },
    async writeFiles() {
      // not exercised by captureCrewOutputs
    },
    async readFiles(input) {
      return input.paths.map((p) => {
        const rel = p.slice(REMOTE_CWD.length + 1);
        return { path: p, content: files[rel] ?? Buffer.alloc(0) };
      });
    },
  };
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-u65-crew-output-capture-integ-"));
    storageDir = await mkdtemp(join(tmpdir(), "aoa-u65-storage-"));
    // Point the storage service's local-disk provider at a throwaway dir
    // BEFORE getStorageService() is first called (loadConfig() reads this at
    // call time, and the service caches by config signature) — real bytes
    // are written by captureCrewOutputs's storage.putFile call, and this
    // keeps them out of the operator's real ~/.aoa.
    process.env.AOA_STORAGE_LOCAL_DIR = storageDir;

    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
      // Force UTF-8 so migration SQL containing non-Latin1 characters applies.
      // Without this, initdb inherits the host locale (WIN1252 on Windows) and
      // the `postgres` DB rejects those bytes.
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
  } catch (err) {
    setupError = err;
    setupFailed = true;
    // eslint-disable-next-line no-console
    console.error("[crew-output-capture] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  delete process.env.AOA_STORAGE_LOCAL_DIR;
  try {
    if (pg) await pg.stop();
  } catch {
    /* ignore */
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}, 60_000);

describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
)("captureCrewOutputs (U6.5, real PostgreSQL)", () => {
  it("persists task_outputs rows with createdByRunId:null + metadata.crewRunId (the FK the unit stub can't prove)", async () => {
    assertSetupOk();

    const { companyId, agentId } = await seedCompanyAndCrewAgent("persist");
    const issueId = await seedIssue(companyId, "Build the export pipeline");
    const crewRunId = await seedCrewRun(companyId, agentId);

    const { captureCrewOutputs } = await import(
      "../services/internal-agent/aoa-agents/crew-output-capture.js"
    );

    const runner = makeSandboxRunner({
      "src/export.ts": Buffer.from("export function run() {}\n"),
      "docs/notes.md": Buffer.from("# Export pipeline notes\n"),
    });

    const captured = await captureCrewOutputs({
      db,
      companyId,
      issueId,
      agentId,
      runId: crewRunId,
      runner,
      remoteCwd: REMOTE_CWD,
    });

    expect(captured.length).toBe(2);
    expect(captured.map((c) => c.path).sort()).toEqual(["docs/notes.md", "src/export.ts"]);

    const rows = await taskOutputService(db).listForIssue(companyId, issueId);
    expect(rows).toHaveLength(2);
    // A crew run id passed as createdByRunId would FK-fail (heartbeat_runs) —
    // this proves the null-run-id + metadata.crewRunId path persists cleanly.
    expect(rows.every((r) => r.createdByRunId === null)).toBe(true);
    expect(rows.every((r) => (r.metadata as Record<string, unknown> | null)?.crewRunId === crewRunId)).toBe(
      true,
    );
    expect(rows.every((r) => r.createdByAgentId === agentId)).toBe(true);
    expect(rows.every((r) => r.reviewState === "needs_review")).toBe(true);
    expect(rows.every((r) => r.type === "detected_file")).toBe(true);
    // Decision #67 — never an artifact/artifact_version row.
    expect(rows.every((r) => r.artifactId === null)).toBe(true);
    expect(rows.every((r) => r.artifactVersionId === null)).toBe(true);
  }, 60_000);

  it("negative control: passing the crew run id AS createdByRunId is REJECTED (proves the FK divergence is real)", async () => {
    assertSetupOk();

    const { companyId, agentId } = await seedCompanyAndCrewAgent("negctrl");
    const issueId = await seedIssue(companyId, "Wire the retry queue");
    const crewRunId = await seedCrewRun(companyId, agentId);

    const { captureCrewOutputs } = await import(
      "../services/internal-agent/aoa-agents/crew-output-capture.js"
    );
    const runner = makeSandboxRunner({ "src/retry.ts": Buffer.from("retry();\n") });
    await captureCrewOutputs({
      db,
      companyId,
      issueId,
      agentId,
      runId: crewRunId,
      runner,
      remoteCwd: REMOTE_CWD,
    });
    const rows = await taskOutputService(db).listForIssue(companyId, issueId);
    expect(rows.length).toBeGreaterThan(0);
    const assetId = rows[0]!.assetId as string;

    // A crew run id lives in internal_agent_runs, NOT heartbeat_runs.
    // upsertForIssue's pre-insert assertCompanyOwnedRef(db, heartbeatRuns, …)
    // must 404 before any insert/FK is even attempted.
    await expect(
      taskOutputService(db).upsertForIssue(companyId, issueId, {
        type: "detected_file",
        provider: "aoa",
        assetId,
        title: "x",
        status: "active",
        reviewState: "none",
        isPrimary: false,
        healthStatus: "unknown",
        createdByRunId: crewRunId,
      }),
    ).rejects.toThrow(/Heartbeat run/);
  }, 60_000);
});
