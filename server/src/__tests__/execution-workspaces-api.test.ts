import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  desc: vi.fn((col: any) => ({ desc: col })),
  inArray: vi.fn((col: any, vals: any) => ({ inArray: [col, vals] })),
}));

vi.mock("@armyofagents/db", () => ({
  executionWorkspaces: {
    id: "ew_id",
    companyId: "ew_company_id",
    projectId: "ew_project_id",
    projectWorkspaceId: "ew_project_workspace_id",
    sourceIssueId: "ew_source_issue_id",
    mode: "ew_mode",
    strategyType: "ew_strategy_type",
    name: "ew_name",
    status: "ew_status",
    cwd: "ew_cwd",
    repoUrl: "ew_repo_url",
    baseRef: "ew_base_ref",
    branchName: "ew_branch_name",
    providerType: "ew_provider_type",
    providerRef: "ew_provider_ref",
    derivedFromExecutionWorkspaceId: "ew_derived_from",
    lastUsedAt: "ew_last_used_at",
    openedAt: "ew_opened_at",
    closedAt: "ew_closed_at",
    cleanupEligibleAt: "ew_cleanup_eligible_at",
    cleanupReason: "ew_cleanup_reason",
    metadata: "ew_metadata",
    createdAt: "ew_created_at",
    updatedAt: "ew_updated_at",
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWorkspaceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: null,
    sourceIssueId: "issue-1",
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "eng-42-fix-auth",
    status: "active",
    cwd: "/workspaces/eng-42",
    repoUrl: null,
    baseRef: "main",
    branchName: "ENG-42-fix-auth",
    providerType: "git_worktree",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date("2026-04-04T10:00:00Z"),
    openedAt: new Date("2026-04-04T09:00:00Z"),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    metadata: null,
    createdAt: new Date("2026-04-04T09:00:00Z"),
    updatedAt: new Date("2026-04-04T10:00:00Z"),
    ...overrides,
  };
}

/** Sequence-based mock DB following the discussions-service test pattern. */
function createSequenceDb(selectQueue: any[][]) {
  let selectIdx = 0;

  function makeSelectChain() {
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn((fn: (rows: any[]) => any) =>
        Promise.resolve(fn(selectQueue[selectIdx++] ?? [])),
      ),
    };
  }

  const db: any = {
    select: vi.fn(() => makeSelectChain()),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockReturnThis(),
          then: vi.fn((fn: (rows: any[]) => any) =>
            Promise.resolve(fn(selectQueue[selectIdx++] ?? [])),
          ),
        })),
      })),
    })),
  };

  return db;
}

// ── Import the service under test ─────────────────────────────────────────────

import { executionWorkspaceService, toWorkspaceRuntimeService } from "../services/execution-workspaces.js";
import { resolveRuntimeProcessOwnerId } from "../services/runtime-process-owner.js";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("executionWorkspaceService", () => {
  describe("list", () => {
    it("returns mapped ExecutionWorkspace array for a company", async () => {
      const row = makeWorkspaceRow();
      const db = createSequenceDb([[row]]);
      const svc = executionWorkspaceService(db);

      const results = await svc.list("company-1");

      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(1);
      const ws = results[0]!;
      expect(ws.id).toBe("ws-1");
      expect(ws.companyId).toBe("company-1");
      expect(ws.status).toBe("active");
      expect(ws.branchName).toBe("ENG-42-fix-auth");
    });

    it("returns empty array when no workspaces exist", async () => {
      const db = createSequenceDb([[]]);
      const svc = executionWorkspaceService(db);

      const results = await svc.list("company-1");
      expect(results).toHaveLength(0);
    });

    it("maps null optional fields correctly", async () => {
      const row = makeWorkspaceRow({ projectWorkspaceId: null, branchName: null, cwd: null });
      const db = createSequenceDb([[row]]);
      const svc = executionWorkspaceService(db);

      const results = await svc.list("company-1");
      const ws = results[0]!;
      expect(ws.projectWorkspaceId).toBeNull();
      expect(ws.branchName).toBeNull();
      expect(ws.cwd).toBeNull();
    });
  });

  describe("getById", () => {
    it("returns an ExecutionWorkspace when found", async () => {
      const row = makeWorkspaceRow();
      const db = createSequenceDb([[row]]);
      const svc = executionWorkspaceService(db);

      const result = await svc.getById("ws-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("ws-1");
      expect(result!.mode).toBe("isolated_workspace");
      expect(result!.strategyType).toBe("git_worktree");
    });

    it("returns null when workspace is not found", async () => {
      const db = createSequenceDb([[]]);
      const svc = executionWorkspaceService(db);

      const result = await svc.getById("nonexistent");
      expect(result).toBeNull();
    });

    it("maps dates correctly", async () => {
      const lastUsedAt = new Date("2026-04-04T10:00:00Z");
      const openedAt = new Date("2026-04-04T09:00:00Z");
      const row = makeWorkspaceRow({ lastUsedAt, openedAt });
      const db = createSequenceDb([[row]]);
      const svc = executionWorkspaceService(db);

      const result = await svc.getById("ws-1");
      expect(result!.lastUsedAt).toEqual(lastUsedAt);
      expect(result!.openedAt).toEqual(openedAt);
      expect(result!.closedAt).toBeNull();
    });
  });

  describe("API response shape", () => {
    it("ExecutionWorkspace has all required fields", async () => {
      const row = makeWorkspaceRow();
      const db = createSequenceDb([[row]]);
      const svc = executionWorkspaceService(db);

      const results = await svc.list("company-1");
      const ws = results[0]!;

      const requiredFields = [
        "id", "companyId", "projectId", "projectWorkspaceId", "sourceIssueId",
        "mode", "strategyType", "name", "status", "cwd", "repoUrl", "baseRef",
        "branchName", "providerType", "providerRef", "derivedFromExecutionWorkspaceId",
        "lastUsedAt", "openedAt", "closedAt", "cleanupEligibleAt", "cleanupReason",
        "metadata", "createdAt", "updatedAt",
      ] as const;

      for (const field of requiredFields) {
        expect(ws).toHaveProperty(field);
      }
    });

    it("status values match expected workspace status enum", () => {
      const validStatuses = ["active", "idle", "in_review", "archived", "cleanup_failed"];
      for (const status of validStatuses) {
        expect(validStatuses).toContain(status);
      }
    });

    it("list with no filters returns all workspaces for a company", async () => {
      const rows = [makeWorkspaceRow(), makeWorkspaceRow({ id: "ws-2", status: "idle" })];
      const db = createSequenceDb([rows]);
      const svc = executionWorkspaceService(db);

      const results = await svc.list("company-1");
      expect(results).toHaveLength(2);
      expect(results[0]!.status).toBe("active");
      expect(results[1]!.status).toBe("idle");
    });
  });
});

describe("toWorkspaceRuntimeService", () => {
  it("suppresses loopback preview details for a foreign-owner local process", () => {
    const service = toWorkspaceRuntimeService({
      id: "svc-foreign",
      companyId: "company-1",
      projectWorkspaceId: "workspace-1",
      executionWorkspaceId: null,
      provider: "local_process",
      processOwnerId: "foreign-owner",
      status: "running",
      healthStatus: "healthy",
      url: "http://127.0.0.1:5173",
    } as any);

    expect(service.url).toBeNull();
    expect(service.previewUrl).toBeNull();
    expect(service.previewAccess).toBeNull();
    expect(service.localTargetUrl).toBeNull();
  });

  it("builds preview URLs for healthy project-scoped runtime services", () => {
    const now = new Date("2026-05-25T10:00:00.000Z");

    const service = toWorkspaceRuntimeService({
      id: "svc-project-1",
      companyId: "company-1",
      projectId: "project-1",
      projectWorkspaceId: "project-workspace-1",
      executionWorkspaceId: null,
      issueId: null,
      scopeType: "project_workspace",
      scopeId: "project-workspace-1",
      serviceName: "web",
      status: "running",
      lifecycle: "shared",
      reuseKey: "project-workspace-1:web",
      command: "pnpm dev",
      cwd: "/repo",
      port: 5173,
      url: "http://127.0.0.1:5173",
      provider: "local_process",
      providerRef: "12345",
      processOwnerId: resolveRuntimeProcessOwnerId(),
      ownerAgentId: null,
      startedByRunId: null,
      lastUsedAt: now,
      startedAt: now,
      stoppedAt: null,
      stopPolicy: null,
      healthStatus: "healthy",
      healthCheckedAt: now,
      createdAt: now,
      updatedAt: now,
    } as any);

    expect(service.previewUrl).toBe("/preview/services/svc-project-1/");
    expect(service.previewAccess).toBe("local");
    expect(service.localTargetUrl).toBe("http://127.0.0.1:5173/");
  });
});
