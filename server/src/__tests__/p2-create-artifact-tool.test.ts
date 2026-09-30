import { describe, expect, it, vi } from "vitest";
import { createArtifactTool } from "../services/internal-agent/tools/create-artifact-tool.js";
import type { ToolContext } from "../services/internal-agent/types.js";

describe("create_artifact tool (P2.5)", () => {
  function makeCtx(
    overrides: { db?: any; artifacts?: any; agentId?: string } = {},
  ): ToolContext {
    return {
      companyId: "co-1",
      userId: "u-1",
      agentId: overrides.agentId ?? "agent-1",
      userRole: "team_member",
      enabledCapabilities: [],
      db: overrides.db ?? ({} as any),
      services: {
        artifacts: overrides.artifacts ?? {
          create: vi
            .fn()
            .mockResolvedValue({ id: "art-1", versions: [{ id: "ver-1" }] }),
        },
      } as any,
    } as unknown as ToolContext;
  }

  function makeAttachDb(
    existingSourceInfo: Record<string, unknown> | null,
  ) {
    const whereMock = vi.fn();
    // First call to where → select result; second call → update result
    whereMock
      .mockResolvedValueOnce(
        existingSourceInfo ? [{ sourceInfo: existingSourceInfo }] : [],
      )
      .mockResolvedValueOnce([]);

    return {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({ where: whereMock }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: whereMock }),
      }),
    };
  }

  it("Test 1 — verifies tool metadata", () => {
    const tool = createArtifactTool();

    expect(tool.name).toBe("create_artifact");
    expect(tool.category).toBe("action");
    expect(tool.requiresConfirmation).toBe(false);
    expect(tool.requiredRole).toBe("team_member");
  });

  it("Test 2 — creates artifact and returns IDs", async () => {
    const mockArtifacts = {
      create: vi
        .fn()
        .mockResolvedValue({ id: "art-1", versions: [{ id: "ver-1" }] }),
    };
    const ctx = makeCtx({ artifacts: mockArtifacts });
    const tool = createArtifactTool();

    const result = await tool.execute(
      {
        title: "Spec Doc",
        type: "document",
        content: "hello",
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data.artifactId).toBe("art-1");
    expect(result.data.versionId).toBe("ver-1");

    expect(mockArtifacts.create).toHaveBeenCalledWith("co-1", "agent-1", {
      title: "Spec Doc",
      type: "document",
      source: "agent",
      content: "hello",
      fileUrl: null,
      // Asset fields default to inline/null when no assetId is provided (P1).
      storageKind: "inline",
      assetId: null,
      filename: null,
      contentType: null,
      extension: null,
      byteSize: null,
      sha256: null,
    });
  });

  it("Test 3 — updates entry sourceInfo when attachToEntryId provided", async () => {
    const mockDb = makeAttachDb({ foo: "bar" });
    const ctx = makeCtx({ db: mockDb });
    const tool = createArtifactTool();

    const result = await tool.execute(
      {
        title: "Design",
        type: "design",
        attachToEntryId: "entry-5",
      },
      ctx,
    );

    expect(result.success).toBe(true);
    // Verify that update was called
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("Test 4 — skips entry update when attachToEntryId absent", async () => {
    const selectMock = vi.fn().mockRejectedValue(
      new Error("Should not call db.select"),
    );
    const mockDb = {
      select: selectMock,
      update: vi.fn(),
    };
    const ctx = makeCtx({ db: mockDb });
    const tool = createArtifactTool();

    const result = await tool.execute(
      {
        title: "Report",
        type: "report",
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("does not attach to an entry outside the caller company", async () => {
    const mockDb = makeAttachDb(null);
    const result = await createArtifactTool().execute(
      { title: "Design", type: "design", attachToEntryId: "foreign-entry" },
      makeCtx({ db: mockDb }),
    );
    expect(result.success).toBe(true);
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});
