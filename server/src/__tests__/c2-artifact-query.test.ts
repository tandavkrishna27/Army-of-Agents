// server/src/__tests__/c2-artifact-query.test.ts
//
// Task C2 batch 2 — query_artifacts tool tests.
// Verifies: 2-way join returns rows, empty thread returns [], param validation.

import { describe, expect, it, vi } from "vitest";
import { queryArtifactsTool } from "../services/internal-agent/tools/artifact-query.js";
import type { ToolContext } from "../services/internal-agent/types.js";

// Mock the chained select: db.select({...}).from(artifacts)
//   .innerJoin(...).innerJoin(...).where(...) -> Promise<rows>
function makeDbReturning(rows: any[]) {
  // The terminal .where(...) call resolves to the rows array.
  const where = vi.fn().mockResolvedValue(rows);
  const innerJoin3 = vi.fn().mockReturnValue({ where });
  const innerJoin2 = vi.fn().mockReturnValue({ innerJoin: innerJoin3 });
  const innerJoin1 = vi.fn().mockReturnValue({ innerJoin: innerJoin2 });
  const from = vi.fn().mockReturnValue({ innerJoin: innerJoin1 });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as any, whereMock: where };
}

function makeCtx(db: any): ToolContext {
  return {
    companyId: "co-1",
    userId: "u-1",
    userRole: "team_member",
    enabledCapabilities: [],
    agentId: "agent-eng",
    db,
    services: {} as any,
  } as unknown as ToolContext;
}

describe("query_artifacts tool (C2 batch 2)", () => {
  it("metadata: name, category=query, requiredRole=team_member, no confirmation", () => {
    expect(queryArtifactsTool.name).toBe("query_artifacts");
    expect(queryArtifactsTool.category).toBe("query");
    expect(queryArtifactsTool.requiredRole).toBe("team_member");
    expect(queryArtifactsTool.requiresConfirmation).toBe(false);
  });

  it("returns artifacts linked to the thread via the join", async () => {
    const rows = [
      {
        artifactId: "a-1",
        title: "Spec",
        type: "document",
        currentVersionId: "v-1",
        status: "active",
      },
      {
        artifactId: "a-2",
        title: "PR diff",
        type: "code",
        currentVersionId: "v-2",
        status: "draft",
      },
    ];
    const { db } = makeDbReturning(rows);
    const ctx = makeCtx(db);
    const result = await queryArtifactsTool.execute(
      { threadId: "thread-1" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual(rows);
    expect(result.summary).toContain("2");
  });

  it("returns an empty array for a thread with no artifacts", async () => {
    const { db } = makeDbReturning([]);
    const ctx = makeCtx(db);
    const result = await queryArtifactsTool.execute(
      { threadId: "thread-empty" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
    expect(result.summary).toContain("0");
  });

  it("returns no artifacts when the company-scoped join finds no owned thread", async () => {
    const { db } = makeDbReturning([]);
    const result = await queryArtifactsTool.execute({ threadId: "foreign-thread" }, makeCtx(db));
    expect(result).toMatchObject({ success: true, data: [] });
  });

  it("returns INVALID_PARAMS when threadId is missing", async () => {
    const { db } = makeDbReturning([]);
    const ctx = makeCtx(db);
    const result = await queryArtifactsTool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("returns INVALID_PARAMS when threadId is empty string", async () => {
    const { db } = makeDbReturning([]);
    const ctx = makeCtx(db);
    const result = await queryArtifactsTool.execute(
      { threadId: "" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });
});
