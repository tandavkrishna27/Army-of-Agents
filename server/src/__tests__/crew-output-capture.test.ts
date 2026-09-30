/**
 * U6.5 — Crew A+ capture: sandbox working dir -> task_outputs, artifacts
 * founder-gated.
 *
 * Unit-level: drives `captureCrewOutputs` against a hand-built
 * `SandboxFileMovementRunner` double (same shape as
 * sandbox-file-movement-diff.test.ts's fake) plus a STUBBED
 * `taskOutputService` (mocked module) and a fake `db.insert()` that records
 * WHICH table object each call targeted, by identity, against the real
 * `assets`/`artifacts`/`artifactVersions` table exports. That identity check
 * is what proves the Decision #67 invariant: this module must never insert
 * an `artifacts` or `artifact_versions` row itself — the unit stub is
 * false-green re: the `heartbeat_runs` FK (see the wave header), which is why
 * `crew-output-capture.integration.test.ts` re-proves the FK path on real
 * Postgres.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { assets, artifacts, artifactVersions } from "@armyofagents/db";
import type {
  SandboxExecuteInput,
  SandboxExecuteResult,
  SandboxFileMovementRunner,
} from "../services/sandbox-file-movement.js";

const mocks = vi.hoisted(() => ({
  putFile: vi.fn(async (input: { originalFilename: string; contentType: string; body: Buffer }) => ({
    provider: "local",
    objectKey: `agent-outputs/${input.originalFilename}`,
    contentType: input.contentType,
    byteSize: input.body.length,
    sha256: "stored-sha",
    originalFilename: input.originalFilename,
  })),
  upsertForIssue: vi.fn(
    async (companyId: string, issueId: string, input: Record<string, unknown>) => ({
      id: `output-${Math.random().toString(36).slice(2)}`,
      companyId,
      issueId,
      ...input,
    }),
  ),
}));

vi.mock("../storage/index.js", () => ({
  getStorageService: () => ({ putFile: mocks.putFile }),
}));

vi.mock("../services/task-outputs.js", () => ({
  taskOutputService: () => ({ upsertForIssue: mocks.upsertForIssue }),
}));

const REMOTE_CWD = "/home/user/aoa-workspace";

/** Mirrors sandbox-file-movement-diff.test.ts's fake runner double. */
function makeSandboxRunner(files: Record<string, Buffer>): {
  runner: SandboxFileMovementRunner;
  calls: SandboxExecuteInput[];
} {
  const paths = Object.keys(files);
  const calls: SandboxExecuteInput[] = [];
  const runner: SandboxFileMovementRunner = {
    async execute(input): Promise<SandboxExecuteResult> {
      calls.push(input);
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
  return { runner, calls };
}

/** Fake db.insert() that records which real table object each call targeted. */
function buildDb(insertedTables: string[]) {
  let seq = 0;
  return {
    insert: (table: unknown) => {
      if (table === assets) insertedTables.push("assets");
      else if (table === artifacts) insertedTables.push("artifacts");
      else if (table === artifactVersions) insertedTables.push("artifact_versions");
      else insertedTables.push("unknown");
      return {
        values: (vals: Record<string, unknown>) => ({
          returning: async () => [{ id: `asset-${++seq}`, ...vals }],
        }),
      };
    },
  };
}

beforeEach(() => {
  mocks.putFile.mockClear();
  mocks.upsertForIssue.mockClear();
});

describe("captureCrewOutputs (U6.5)", () => {
  it("captures each produced file to task_outputs with createdByRunId:null + metadata.crewRunId, and never touches artifacts/artifact_versions", async () => {
    const { captureCrewOutputs } = await import(
      "../services/internal-agent/aoa-agents/crew-output-capture.js"
    );
    const insertedTables: string[] = [];
    const db = buildDb(insertedTables);
    const { runner } = makeSandboxRunner({
      "src/a.ts": Buffer.from("export const a = 1;\n"),
      "docs/readme.md": Buffer.from("# hi\n"),
    });
    const runId = "run-abc";
    const agentId = "agent-xyz";

    const result = await captureCrewOutputs({
      db: db as never,
      companyId: "company-1",
      issueId: "issue-1",
      agentId,
      runId,
      runner,
      remoteCwd: REMOTE_CWD,
    });

    // Returned shape: Array<{ path; type? }>, non-empty.
    expect(result.length).toBe(2);
    expect(result.map((r) => r.path).sort()).toEqual(["docs/readme.md", "src/a.ts"]);

    // Shape passed to upsertForIssue for EACH file.
    expect(mocks.upsertForIssue).toHaveBeenCalledTimes(2);
    const upsertCalls = mocks.upsertForIssue.mock.calls.map(
      (c) => c[2] as Record<string, unknown>,
    );
    expect(upsertCalls.map((c) => c.type)).toEqual(["detected_file", "detected_file"]);
    expect(upsertCalls.map((c) => c.createdByAgentId)).toEqual([agentId, agentId]);
    expect(upsertCalls.map((c) => c.createdByRunId)).toEqual([null, null]);
    expect(upsertCalls.map((c) => (c.metadata as Record<string, unknown> | undefined)?.crewRunId)).toEqual([
      runId,
      runId,
    ]);
    expect(upsertCalls.map((c) => c.reviewState)).toEqual(["needs_review", "needs_review"]);

    // Decision #67 — the security/decision invariant: only `assets` is ever
    // inserted by this module; `artifacts`/`artifact_versions` are NEVER
    // touched (founder-gated confirmation is a separate, later step).
    expect(insertedTables).toContain("assets");
    expect(insertedTables).not.toContain("artifact_versions");
    expect(insertedTables).not.toContain("artifacts");
  });

  it("guards issueId == null (thread-only crew runs) — returns [] without calling collectSandboxDiff or upsertForIssue", async () => {
    const { captureCrewOutputs } = await import(
      "../services/internal-agent/aoa-agents/crew-output-capture.js"
    );
    const insertedTables: string[] = [];
    const db = buildDb(insertedTables);
    const { runner, calls } = makeSandboxRunner({ "src/a.ts": Buffer.from("x\n") });

    const result = await captureCrewOutputs({
      db: db as never,
      companyId: "company-1",
      issueId: null,
      agentId: "agent-xyz",
      runId: "run-abc",
      runner,
      remoteCwd: REMOTE_CWD,
    });

    expect(result).toEqual([]);
    expect(calls.length).toBe(0);
    expect(mocks.upsertForIssue).not.toHaveBeenCalled();
    expect(insertedTables).toEqual([]);
  });

  it("never throws — a per-file capture failure is skipped and the other file still lands", async () => {
    const { captureCrewOutputs } = await import(
      "../services/internal-agent/aoa-agents/crew-output-capture.js"
    );
    const insertedTables: string[] = [];
    const db = buildDb(insertedTables);
    const { runner } = makeSandboxRunner({
      "bad.txt": Buffer.from("will fail to store\n"),
      "good.txt": Buffer.from("stores fine\n"),
    });

    mocks.putFile.mockImplementationOnce(async () => {
      throw new Error("storage unavailable");
    });

    const result = await captureCrewOutputs({
      db: db as never,
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-xyz",
      runId: "run-abc",
      runner,
      remoteCwd: REMOTE_CWD,
    });

    // One file failed (skipped), the other still landed — partial success,
    // never a throw.
    expect(result.length).toBe(1);
    expect(mocks.upsertForIssue).toHaveBeenCalledTimes(1);
  });

  it("never throws — a whole-batch failure (runner lacks readFiles) returns [] instead of throwing", async () => {
    const { captureCrewOutputs } = await import(
      "../services/internal-agent/aoa-agents/crew-output-capture.js"
    );
    const insertedTables: string[] = [];
    const db = buildDb(insertedTables);
    const { runner: base } = makeSandboxRunner({ "src/a.ts": Buffer.from("x\n") });
    const runner: SandboxFileMovementRunner = { execute: base.execute, writeFiles: base.writeFiles };
    // readFiles intentionally omitted — collectSandboxDiff throws
    // "does not support readFiles" once it has candidate paths.

    await expect(
      captureCrewOutputs({
        db: db as never,
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-xyz",
        runId: "run-abc",
        runner,
        remoteCwd: REMOTE_CWD,
      }),
    ).resolves.toEqual([]);

    expect(mocks.upsertForIssue).not.toHaveBeenCalled();
    expect(insertedTables).toEqual([]);
  });
});
