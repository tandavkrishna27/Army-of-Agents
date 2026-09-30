import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  filterArtifactsForScope: vi.fn(),
  artifactProjectMap: vi.fn(),
  resolveMcpOwnerArtifactScope: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../mcp/tools/scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/tools/scope.js")>();
  return {
    ...actual,
    filterArtifactsForScope: mocks.filterArtifactsForScope,
    artifactProjectMap: mocks.artifactProjectMap,
    resolveMcpOwnerArtifactScope: mocks.resolveMcpOwnerArtifactScope,
  };
});

vi.mock("../services/index.js", () => ({ logActivity: mocks.logActivity }));

import { handleAttachArtifactVersion } from "../mcp/tools/write-tools.js";
import { toolAllowedActors } from "../mcp/tools/index.js";
import type { ToolContext } from "../mcp/tools/types.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const artifactId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";

function context(options: {
  source?: "board" | "mcp" | "agent" | "commander";
  artifactCompanyId?: string;
  canUpdate?: boolean;
} = {}) {
  const source = options.source ?? "mcp";
  const addVersion = vi.fn().mockResolvedValue({
    id: "44444444-4444-4444-8444-444444444444",
    artifactId,
    versionNumber: 2,
    source: "mcp",
  });
  const canAccessEntity = vi.fn().mockResolvedValue(options.canUpdate ?? true);
  const ctx = {
    db: {} as never,
    companyId,
    actor: {
      source,
      userId: source === "agent" ? "agent-1" : "user-1",
      companyId,
      keyId: source === "mcp" ? "key-1" : null,
      agentId: source === "agent" ? "agent-1" : null,
      runId: source === "agent" ? "run-1" : null,
    },
    scope: { kind: "scoped", userId: "user-1", projectIds: new Set<string>() },
    services: {
      artifactsSvc: {
        getById: vi.fn().mockResolvedValue({
          id: artifactId,
          companyId: options.artifactCompanyId ?? companyId,
        }),
        addVersion,
      },
      permissionsSvc: { canAccessEntity },
    },
    actorInfo: {
      actorType: "user",
      actorId: "user-1",
      agentId: null,
      runId: null,
    },
    resolveRole: vi.fn(),
    resolveScopedAgentIds: vi.fn(),
  } as unknown as ToolContext;
  return { ctx, addVersion, canAccessEntity };
}

describe("MCP artifact-version authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.filterArtifactsForScope.mockResolvedValue([]);
    mocks.artifactProjectMap.mockResolvedValue(new Map([[artifactId, projectId]]));
    mocks.resolveMcpOwnerArtifactScope.mockResolvedValue({
      kind: "scoped",
      userId: "user-1",
      projectIds: new Set([projectId]),
    });
  });

  it("restricts the JSON-RPC tool to board and MCP actors", () => {
    expect(toolAllowedActors["attach-artifact-version"]).toEqual(["board", "mcp"]);
  });

  it("lets a scoped MCP key reach an admitted artifact, then applies artifact-update permission", async () => {
    mocks.filterArtifactsForScope.mockImplementation(async (_db, _scope, rows) => rows);
    const { ctx, addVersion, canAccessEntity } = context();

    const result = await handleAttachArtifactVersion(ctx, {
      artifactId,
      sourceDetail: "external-client",
      content: "v2",
    });

    expect(result.ok).toBe(true);
    expect(mocks.resolveMcpOwnerArtifactScope).toHaveBeenCalledWith(
      ctx.db,
      companyId,
      "user-1",
    );
    expect(mocks.filterArtifactsForScope).toHaveBeenCalledOnce();
    expect(canAccessEntity).toHaveBeenCalledWith(
      companyId,
      "user-1",
      "artifact",
      "update",
      { departmentId: projectId },
    );
    expect(addVersion).toHaveBeenCalledWith(
      artifactId,
      expect.objectContaining({ source: "mcp", sourceDetail: "external-client" }),
    );
  });

  it("denies an MCP key without artifact-update permission", async () => {
    mocks.filterArtifactsForScope.mockImplementation(async (_db, _scope, rows) => rows);
    const { ctx, addVersion } = context({ canUpdate: false });

    const result = await handleAttachArtifactVersion(ctx, {
      artifactId,
      sourceDetail: "external-client",
      content: "v2",
    });

    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(addVersion).not.toHaveBeenCalled();
  });

  it("hides an artifact outside the MCP key owner's project scope", async () => {
    const { ctx, addVersion, canAccessEntity } = context();

    const result = await handleAttachArtifactVersion(ctx, {
      artifactId,
      sourceDetail: "external-client",
      content: "v2",
    });

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(mocks.filterArtifactsForScope).toHaveBeenCalledOnce();
    expect(canAccessEntity).not.toHaveBeenCalled();
    expect(addVersion).not.toHaveBeenCalled();
  });

  it("keeps the company boundary before permission evaluation", async () => {
    const { ctx, addVersion, canAccessEntity } = context({
      artifactCompanyId: "55555555-5555-4555-8555-555555555555",
    });

    const result = await handleAttachArtifactVersion(ctx, {
      artifactId,
      sourceDetail: "external-client",
      content: "v2",
    });

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(mocks.resolveMcpOwnerArtifactScope).not.toHaveBeenCalled();
    expect(canAccessEntity).not.toHaveBeenCalled();
    expect(addVersion).not.toHaveBeenCalled();
  });

  it("preserves scope filtering for board callers", async () => {
    const { ctx, addVersion } = context({ source: "board" });

    const result = await handleAttachArtifactVersion(ctx, {
      artifactId,
      sourceDetail: "board-client",
      content: "v2",
    });

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(mocks.filterArtifactsForScope).toHaveBeenCalledOnce();
    expect(addVersion).not.toHaveBeenCalled();
  });
});
