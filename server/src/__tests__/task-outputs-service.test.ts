import { describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  agents: makeTableProxy("agents"),
  artifacts: makeTableProxy("artifacts"),
  artifactVersions: makeTableProxy("artifact_versions"),
  assets: makeTableProxy("assets"),
  executionWorkspaces: makeTableProxy("execution_workspaces"),
  heartbeatRuns: makeTableProxy("heartbeat_runs"),
  issues: makeTableProxy("issues"),
  taskOutputs: makeTableProxy("task_outputs"),
  workspaceRuntimeServices: makeTableProxy("workspace_runtime_services"),
}));

import { taskOutputService } from "../services/task-outputs.js";

type MockRow = Record<string, unknown>;

const companyId = "company-1";
const issueId = "issue-1";
const projectId = "project-1";

function issueRow(overrides: MockRow = {}) {
  return {
    id: issueId,
    companyId,
    projectId,
    ...overrides,
  };
}

function outputRow(overrides: MockRow = {}) {
  const now = new Date("2026-05-25T00:00:00.000Z");
  return {
    id: "output-1",
    companyId,
    projectId,
    issueId,
    type: "artifact",
    provider: "aoa",
    externalId: null,
    artifactId: "artifact-1",
    artifactVersionId: null,
    assetId: null,
    executionWorkspaceId: null,
    runtimeServiceId: null,
    url: null,
    title: "Plan",
    status: "active",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeDb(input: {
  selectRows?: MockRow[][];
  insertRows?: MockRow[][];
  updateRows?: MockRow[][];
}) {
  let selectIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;
  const insertValues: unknown[] = [];
  const updateValues: unknown[] = [];

  const chain = (rows: () => MockRow[]) => {
    const obj: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy", "limit", "values", "set", "returning"]) {
      obj[method] = (arg?: unknown) => {
        if (method === "values") insertValues.push(arg);
        if (method === "set") updateValues.push(arg);
        return obj;
      };
    }
    obj.then = (resolve: (value: MockRow[]) => unknown) => Promise.resolve(resolve(rows()));
    return obj;
  };

  const db = {
    select: () => chain(() => input.selectRows?.[selectIdx++] ?? []),
    insert: () => chain(() => input.insertRows?.[insertIdx++] ?? []),
    update: () => chain(() => input.updateRows?.[updateIdx++] ?? []),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };

  return { db, insertValues, updateValues };
}

describe("taskOutputService", () => {
  it("lists outputs by company and task ordered by latest update", async () => {
    const rows = [outputRow({ id: "output-2" }), outputRow()];
    const { db } = makeDb({ selectRows: [rows] });

    const result = await taskOutputService(db as never).listForIssue(companyId, issueId);

    expect(result).toEqual(rows);
  });

  it("creates an output using the task company and project", async () => {
    const created = outputRow({ type: "preview_url", url: "https://preview.example.test" });
    const mock = makeDb({
      selectRows: [[issueRow()]],
      insertRows: [[created]],
    });

    const result = await taskOutputService(mock.db as never).upsertForIssue(companyId, issueId, {
      type: "preview_url",
      title: "Preview",
      url: "https://preview.example.test",
    });

    expect(result).toEqual(created);
    expect(mock.insertValues[0]).toMatchObject({
      companyId,
      projectId,
      issueId,
      type: "preview_url",
      title: "Preview",
      url: "https://preview.example.test",
    });
  });

  it("updates an existing provider external id instead of inserting a duplicate", async () => {
    const existing = outputRow({ id: "existing", externalId: "pr-42", type: "pull_request" });
    const updated = outputRow({
      id: "existing",
      externalId: "pr-42",
      type: "pull_request",
      status: "merged",
    });
    const mock = makeDb({
      selectRows: [[issueRow()], [existing]],
      updateRows: [[updated]],
    });

    const result = await taskOutputService(mock.db as never).upsertForIssue(companyId, issueId, {
      type: "pull_request",
      provider: "github",
      externalId: "pr-42",
      title: "PR #42",
      status: "merged",
      url: "https://github.com/acme/repo/pull/42",
    });

    expect(result).toEqual(updated);
    expect(mock.insertValues).toHaveLength(0);
    expect(mock.updateValues[0]).toMatchObject({
      type: "pull_request",
      provider: "github",
      externalId: "pr-42",
      status: "merged",
    });
  });

  it("keeps provider external id upserts scoped to a single task", async () => {
    const created = outputRow({
      id: "new-output",
      externalId: "preview-1",
      type: "preview_url",
      url: "https://preview.example.test",
    });
    const mock = makeDb({
      // The scoped lookup for this issue must not see an output with the same
      // external id from a different task.
      selectRows: [[issueRow()], []],
      insertRows: [[created]],
    });

    const result = await taskOutputService(mock.db as never).upsertForIssue(companyId, issueId, {
      type: "preview_url",
      provider: "local_process",
      externalId: "preview-1",
      title: "Preview",
      url: "https://preview.example.test",
    });

    expect(result).toEqual(created);
    expect(mock.updateValues).toHaveLength(0);
    expect(mock.insertValues[0]).toMatchObject({
      issueId,
      provider: "local_process",
      externalId: "preview-1",
    });
  });

  it("rejects linked artifacts that belong to another company", async () => {
    const mock = makeDb({
      selectRows: [
        [issueRow()],
        [{ id: "artifact-1", companyId: "other-company" }],
      ],
      insertRows: [[outputRow({ artifactId: "artifact-1" })]],
    });

    await expect(
      taskOutputService(mock.db as never).upsertForIssue(companyId, issueId, {
        type: "artifact",
        title: "Cross-company artifact",
        artifactId: "artifact-1",
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(mock.insertValues).toHaveLength(0);
  });

  it("throws not found when the task is not in the company", async () => {
    const { db } = makeDb({ selectRows: [[]] });

    await expect(
      taskOutputService(db as never).upsertForIssue(companyId, issueId, {
        type: "artifact",
        title: "Plan",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("clears sibling primaries before setting a new primary", async () => {
    const updated = outputRow({ id: "output-2", isPrimary: true });
    const mock = makeDb({
      selectRows: [[outputRow({ id: "output-2" })]],
      updateRows: [[], [updated]],
    });

    const result = await taskOutputService(mock.db as never).updateMutable(companyId, "output-2", {
      isPrimary: true,
      title: "Primary output",
    });

    expect(result).toEqual(updated);
    expect(mock.updateValues[0]).toMatchObject({ isPrimary: false });
    expect(mock.updateValues[1]).toMatchObject({ isPrimary: true, title: "Primary output" });
  });
});
