/**
 * Unit tests for `synthesizeThreadDeliveryRefs` (Viewer Upgrade Phase 7B, Task 3).
 *
 * The helper synthesizes the NAVIGATIONAL ShowRefs a crew run delivers onto its
 * originating Discussion thread when the run finishes. It reads:
 *   1. the issue row (for the task's primary artifact `issues.artifactId`)
 *   2. the task's `task_outputs` via `taskOutputService.listForIssue`
 * and emits:
 *   - always ONE `task` ref (referenced), provenance surface:"discussion"
 *   - one ref per task_output, mapped FIELD-AWARE over the real 9-value enum
 *     (artifactId → artifact, url → url, else → output-by-row-id)
 *   - one `artifact` ref for the task's primary artifact (if any)
 * then dedups via `mergeOutputRefs` and caps at MAX_OUTPUT_REFS_PER_MESSAGE.
 *
 * Aggregate semantics: the refs describe the task's CURRENT products; the
 * provenance identifies WHO delivered (run/agent/thread), not per-product
 * authorship — so every ref carries action:"referenced".
 *
 * Mock-db pattern mirrors crew-budget.test.ts: mock `@armyofagents/db` +
 * `drizzle-orm` via the shared Proxy/operator helpers, then drive the service
 * with a sequence-based mock DB. The helper reuses `taskOutputService`
 * (`listForIssue`), which imports the full task_outputs table surface — so the
 * mock exports every table that module names.
 */

import { describe, it, expect } from "vitest";
import { MAX_OUTPUT_REFS_PER_MESSAGE } from "@armyofagents/shared";
import {
  makeTableProxy,
  drizzleOperatorStubs,
} from "../../__tests__/helpers/drizzle-mock.js";
import { vi } from "vitest";

vi.mock("@armyofagents/db", () => ({
  // Tables the helper touches directly:
  issues: makeTableProxy("issues"),
  taskOutputs: makeTableProxy("task_outputs"),
  // Tables `task-outputs.ts` imports at module load (unused by listForIssue,
  // but named in its import list — provide them so the mock is complete):
  agents: makeTableProxy("agents"),
  artifacts: makeTableProxy("artifacts"),
  artifactVersions: makeTableProxy("artifact_versions"),
  assets: makeTableProxy("assets"),
  executionWorkspaces: makeTableProxy("execution_workspaces"),
  heartbeatRuns: makeTableProxy("heartbeat_runs"),
  workspaceRuntimeServices: makeTableProxy("workspace_runtime_services"),
}));

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

import { synthesizeThreadDeliveryRefs } from "../viewer-ref-synthesis.js";

// ---------------------------------------------------------------------------
// Sequence-based mock DB.
//   select #0 → the issue row (helper reads it first, for issues.artifactId)
//   select #1 → the task_outputs rows (via taskOutputService.listForIssue)
// Every chain method is a no-op pass-through; `.then` consumes the next preset.
// ---------------------------------------------------------------------------

type MockRow = Record<string, unknown>;

function createSequenceDb(selects: MockRow[][]) {
  let selectIdx = 0;
  const selectCalls: { fromTable?: string }[] = [];

  function tableNameOf(value: unknown): string | undefined {
    if (value && typeof value === "object") {
      const meta = (value as Record<string, unknown>)["_"];
      if (meta && typeof meta === "object") {
        const name = (meta as Record<string, unknown>).name;
        if (typeof name === "string") return name;
      }
    }
    return undefined;
  }

  function makeSelectChain(): any {
    const call: { fromTable?: string } = {};
    selectCalls.push(call);
    const chain: any = {};
    for (const m of ["where", "orderBy", "limit"]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.from = (table: unknown) => {
      call.fromTable = tableNameOf(table);
      return chain;
    };
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(resolve(selects[selectIdx++] ?? []));
    return chain;
  }

  return {
    select: (..._args: unknown[]) => makeSelectChain(),
    selectCalls,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPANY_ID = "co-1";
const ISSUE_ID = "issue-1";
const THREAD_ID = "thread-1";
const RUN_ID = "run-1";
const AGENT_ID = "agent-1";

function issueRow(overrides: Partial<MockRow> = {}): MockRow {
  return { id: ISSUE_ID, artifactId: null, ...overrides };
}

function outputRow(overrides: Partial<MockRow>): MockRow {
  return {
    id: overrides.id ?? "to-x",
    type: "artifact",
    artifactId: null,
    artifactVersionId: null,
    assetId: null,
    url: null,
    title: "Output",
    ...overrides,
  };
}

async function run(selects: MockRow[][], args?: Partial<Parameters<typeof synthesizeThreadDeliveryRefs>[0]>) {
  const db = createSequenceDb(selects);
  return synthesizeThreadDeliveryRefs({
    db: db as any,
    companyId: COMPANY_ID,
    issueId: ISSUE_ID,
    threadId: THREAD_ID,
    runId: RUN_ID,
    agentId: AGENT_ID,
    ...args,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("synthesizeThreadDeliveryRefs", () => {
  it("always emits exactly one task ref with discussion provenance (empty issue)", async () => {
    const refs = await run([[issueRow()], []]);
    expect(refs).toHaveLength(1);
    const task = refs[0];
    expect(task.kind).toBe("task");
    expect(task.id).toBe(ISSUE_ID);
    expect(task.action).toBe("referenced");
    if (task.v !== 2) throw new Error("expected v2");
    expect(task.provenance).toMatchObject({
      surface: "discussion",
      entityId: THREAD_ID,
      runId: RUN_ID,
      agentId: AGENT_ID,
    });
    expect(typeof task.provenance?.seq).toBe("number");
    expect(typeof task.provenance?.emittedAt).toBe("string");
    // valid ISO
    expect(Number.isNaN(Date.parse(task.provenance!.emittedAt))).toBe(false);
  });

  it("maps artifact + artifact_version (has artifactId) → kind:artifact (+versionId)", async () => {
    const refs = await run([
      [issueRow()],
      [
        outputRow({ id: "to-a", type: "artifact", artifactId: "art-1", artifactVersionId: null }),
        outputRow({ id: "to-b", type: "artifact_version", artifactId: "art-2", artifactVersionId: "ver-2" }),
      ],
    ]);
    const byId = Object.fromEntries(refs.map((r) => [r.id, r]));
    expect(byId["art-1"].kind).toBe("artifact");
    expect(byId["art-1"].versionId ?? null).toBe(null);
    expect(byId["art-2"].kind).toBe("artifact");
    expect(byId["art-2"].versionId).toBe("ver-2");
  });

  it("maps preview_url / pull_request / branch / commit / external_link (has url) → kind:url, id=url", async () => {
    const rows = [
      outputRow({ id: "to-p", type: "preview_url", url: "https://preview.example/1" }),
      outputRow({ id: "to-pr", type: "pull_request", url: "https://github.com/o/r/pull/1" }),
      outputRow({ id: "to-br", type: "branch", url: "https://github.com/o/r/tree/feat" }),
      outputRow({ id: "to-co", type: "commit", url: "https://github.com/o/r/commit/abc" }),
      outputRow({ id: "to-el", type: "external_link", url: "https://example.com/doc" }),
    ];
    const refs = await run([[issueRow()], rows]);
    const urlRefs = refs.filter((r) => r.kind === "url");
    expect(urlRefs).toHaveLength(5);
    // A url ref's id IS the URL string (per showRefV2Schema).
    expect(urlRefs.map((r) => r.id).sort()).toEqual(
      rows.map((r) => r.url as string).sort(),
    );
  });

  it("maps detected_file / runtime_service (asset-bearing / no artifactId+url) → kind:output by row id", async () => {
    const refs = await run([
      [issueRow()],
      [
        outputRow({ id: "to-df", type: "detected_file", assetId: "asset-1" }),
        outputRow({ id: "to-rs", type: "runtime_service", url: null, artifactId: null }),
      ],
    ]);
    const df = refs.find((r) => r.id === "to-df");
    const rs = refs.find((r) => r.id === "to-rs");
    expect(df?.kind).toBe("output");
    expect(rs?.kind).toBe("output");
  });

  it("degrades a malformed row (preview_url with null url) to kind:output by row id — no crash", async () => {
    const refs = await run([
      [issueRow()],
      [outputRow({ id: "to-bad", type: "preview_url", url: null })],
    ]);
    const bad = refs.find((r) => r.id === "to-bad");
    expect(bad).toBeDefined();
    expect(bad?.kind).toBe("output");
    // still exactly task + the fallback output ref
    expect(refs).toHaveLength(2);
  });

  it("emits an artifact ref for the task's primary artifact (issues.artifactId)", async () => {
    const refs = await run([[issueRow({ artifactId: "task-art" })], []]);
    const art = refs.find((r) => r.kind === "artifact");
    expect(art?.id).toBe("task-art");
    expect(refs).toHaveLength(2); // task + task-artifact
  });

  it("dedups the same artifact reached via a task_output AND the task's primary artifact → one ref", async () => {
    const refs = await run([
      [issueRow({ artifactId: "shared-art" })],
      [outputRow({ id: "to-a", type: "artifact", artifactId: "shared-art", artifactVersionId: null })],
    ]);
    const artRefs = refs.filter((r) => r.kind === "artifact");
    expect(artRefs).toHaveLength(1);
    expect(artRefs[0].id).toBe("shared-art");
    // task + one deduped artifact
    expect(refs).toHaveLength(2);
  });

  it("dedups by artifact id even when the task_output carries a version (no double chip)", async () => {
    // The common attach_task_artifact case: a task_output artifact with a
    // non-null version + the same id as issues.artifactId (null version). The
    // dedup key differs by version, so guard by artifact id → ONE chip (the
    // richer versioned ref survives).
    const refs = await run([
      [issueRow({ artifactId: "shared-art" })],
      [outputRow({ id: "to-a", type: "artifact", artifactId: "shared-art", artifactVersionId: "ver-9" })],
    ]);
    const artRefs = refs.filter((r) => r.kind === "artifact");
    expect(artRefs).toHaveLength(1);
    expect(artRefs[0].id).toBe("shared-art");
    expect((artRefs[0] as { versionId?: string }).versionId).toBe("ver-9");
    expect(refs).toHaveLength(2); // task + one artifact
  });

  it("caps the total at MAX_OUTPUT_REFS_PER_MESSAGE (task ref survives the cap)", async () => {
    const many = Array.from({ length: MAX_OUTPUT_REFS_PER_MESSAGE + 10 }, (_, i) =>
      outputRow({ id: `to-${i}`, type: "external_link", url: `https://example.com/${i}` }),
    );
    const refs = await run([[issueRow()], many]);
    expect(refs).toHaveLength(MAX_OUTPUT_REFS_PER_MESSAGE);
    // the task ref is emitted first, so it must survive the cap
    expect(refs.some((r) => r.kind === "task" && r.id === ISSUE_ID)).toBe(true);
  });

  it("assigns a distinct seq per emitted ref", async () => {
    const refs = await run([
      [issueRow({ artifactId: "task-art" })],
      [outputRow({ id: "to-a", type: "artifact", artifactId: "art-1" })],
    ]);
    const seqs = refs.map((r) => (r.v === 2 ? r.provenance?.seq : undefined));
    // all defined + unique
    expect(seqs.every((s) => typeof s === "number")).toBe(true);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("all synthesized refs carry action:'referenced' (aggregate semantics — not per-run authorship)", async () => {
    const refs = await run([
      [issueRow({ artifactId: "task-art" })],
      [
        outputRow({ id: "to-a", type: "artifact", artifactId: "art-1" }),
        outputRow({ id: "to-u", type: "preview_url", url: "https://p/1" }),
        outputRow({ id: "to-o", type: "detected_file", assetId: "asset-1" }),
      ],
    ]);
    expect(refs.every((r) => r.action === "referenced")).toBe(true);
  });
});
