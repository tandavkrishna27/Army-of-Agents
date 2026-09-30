// server/src/__tests__/c2-artifact-create-version.test.ts
//
// Task C2 batch 2 — create_artifact_version tool tests.
//
// Phase 1 (Artifact Lifecycle, Task 10b) refactor: the tool no longer inserts
// artifact_versions directly. It delegates to artifactService.addVersion — the
// single choke point that owns parent-validation, atomic version-numbering, the
// artifacts.current_version_id pointer bump, and assertAssetOwned. These tests
// therefore assert DELEGATION (correct args + return-shape mapping) and the
// tool's own caller-company guard, rather than inspecting a tx chain. The
// version-numbering / pointer-bump / parent-validation internals are covered by
// the artifactService.addVersion tests in the service layer.

import { describe, expect, it, vi } from "vitest";
import { createArtifactVersionTool } from "../services/internal-agent/tools/artifact-create-version.js";
import type { ToolContext } from "../services/internal-agent/types.js";

// db.select({companyId}).from(artifacts).where(eq(artifacts.id, id)) — the
// company-scope pre-check that runs BEFORE delegating to addVersion. `rows` is
// what the `.where()` resolves to (the company-ownership lookup result).
function makeDbSelect(rows: any[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select, from, where };
}

function makeCtx(
  addVersion: any,
  opts: { companyId?: string; selectFn?: any } = {},
): ToolContext {
  // Default ownership lookup returns a same-company artifact so success-path
  // tests pass unchanged.
  const dbSelect =
    opts.selectFn ?? makeDbSelect([{ companyId: opts.companyId ?? "co-1" }]).select;
  return {
    companyId: opts.companyId ?? "co-1",
    userId: "u-1",
    userRole: "team_member",
    enabledCapabilities: ["system_actions"],
    agentId: "agent-eng",
    db: { select: dbSelect },
    services: { artifacts: { addVersion } } as any,
  } as unknown as ToolContext;
}

describe("create_artifact_version tool (C2 batch 2)", () => {
  it("metadata: name, category=action, requiredRole=team_member, no confirmation", () => {
    expect(createArtifactVersionTool.name).toBe("create_artifact_version");
    expect(createArtifactVersionTool.category).toBe("action");
    expect(createArtifactVersionTool.requiredRole).toBe("team_member");
    expect(createArtifactVersionTool.requiresConfirmation).toBe(false);
  });

  it("delegates to artifactService.addVersion and maps its returned version", async () => {
    // addVersion owns version-numbering + the currentVersionId bump; the tool
    // just forwards source/content/parentVersionId and maps id/versionNumber.
    const addVersion = vi
      .fn()
      .mockResolvedValue({ id: "v-4", versionNumber: 4 });
    const ctx = makeCtx(addVersion);

    const result = await createArtifactVersionTool.execute(
      { artifactId: "art-1", content: "new content" },
      ctx,
    );

    expect(result.success).toBe(true);
    expect((result.data as any).versionId).toBe("v-4");
    expect((result.data as any).versionNumber).toBe(4);
    expect(result.summary).toBe("Created artifact v4");
    expect(addVersion).toHaveBeenCalledTimes(1);
    expect(addVersion).toHaveBeenCalledWith("art-1", {
      source: "agent",
      content: "new content",
      parentVersionId: null,
    });
  });

  it("forwards parentVersionId to addVersion when provided (branching)", async () => {
    const addVersion = vi
      .fn()
      .mockResolvedValue({ id: "v-3", versionNumber: 3 });
    const ctx = makeCtx(addVersion);

    const result = await createArtifactVersionTool.execute(
      {
        artifactId: "art-1",
        content: "branch content",
        parentVersionId: "v-1",
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(addVersion).toHaveBeenCalledWith("art-1", {
      source: "agent",
      content: "branch content",
      parentVersionId: "v-1",
    });
  });

  it("foreign/missing parentVersionId (addVersion throws badRequest) → NOT_FOUND", async () => {
    // SECURITY: addVersion is the choke point that validates parentVersionId
    // belongs to THIS artifact; a foreign/missing parent throws
    // badRequest("parentVersionId does not belong to this artifact"). The tool
    // maps that thrown error back to the prior NOT_FOUND contract (nothing
    // created — the throw aborts addVersion's own transaction).
    const addVersion = vi.fn().mockRejectedValue(
      Object.assign(new Error("parentVersionId does not belong to this artifact"), {
        status: 400,
      }),
    );
    const ctx = makeCtx(addVersion);

    const result = await createArtifactVersionTool.execute(
      {
        artifactId: "art-1",
        content: "branch off a foreign parent",
        parentVersionId: "v-foreign",
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_FOUND");
    expect(result.summary).toBe("Artifact version parent invalid");
  });

  it("maps a non-parent addVersion failure to TRANSACTION_FAILED", async () => {
    const addVersion = vi
      .fn()
      .mockRejectedValue(new Error("simulated insert error"));
    const ctx = makeCtx(addVersion);

    const result = await createArtifactVersionTool.execute(
      { artifactId: "art-1", content: "x" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("TRANSACTION_FAILED");
    expect(result.summary).toContain("simulated insert error");
  });

  it("returns INVALID_PARAMS when artifactId is missing (never delegates)", async () => {
    const addVersion = vi.fn();
    const ctx = makeCtx(addVersion);
    const result = await createArtifactVersionTool.execute(
      { content: "x" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(addVersion).not.toHaveBeenCalled();
  });

  it("returns INVALID_PARAMS when content is not a string (never delegates)", async () => {
    const addVersion = vi.fn();
    const ctx = makeCtx(addVersion);
    const result = await createArtifactVersionTool.execute(
      { artifactId: "art-1" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(addVersion).not.toHaveBeenCalled();
  });

  it("cross-company artifactId → NOT_FOUND and writes NOTHING (never delegates)", async () => {
    // The artifact row resolves to a DIFFERENT company. A crew agent (Engineer/
    // Planner, prompt-injection surface) must not be able to add a version to,
    // or repoint, another company's artifact. The company check must run BEFORE
    // delegating to addVersion — addVersion does NOT scope by caller company, so
    // the tool is the only thing standing between a cross-company artifactId and
    // a write.
    const addVersion = vi.fn();
    const foreignSelect = makeDbSelect([{ companyId: "other-co" }]);
    const ctx = makeCtx(addVersion, {
      companyId: "co-1",
      selectFn: foreignSelect.select,
    });

    const result = await createArtifactVersionTool.execute(
      { artifactId: "art-foreign", content: "leak" },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_FOUND");
    // addVersion must never run — nothing inserted, no pointer bump.
    expect(addVersion).not.toHaveBeenCalled();
  });

  it("missing artifact (lookup returns no row) → NOT_FOUND and never delegates", async () => {
    const addVersion = vi.fn();
    const emptySelect = makeDbSelect([]); // no artifact row
    const ctx = makeCtx(addVersion, { selectFn: emptySelect.select });

    const result = await createArtifactVersionTool.execute(
      { artifactId: "ghost", content: "x" },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_FOUND");
    expect(addVersion).not.toHaveBeenCalled();
  });

  it("regression: same-company artifactId still creates the version via addVersion", async () => {
    const addVersion = vi
      .fn()
      .mockResolvedValue({ id: "v-2", versionNumber: 2 });
    // Ownership lookup returns the caller's company → success path.
    const ownSelect = makeDbSelect([{ companyId: "co-1" }]);
    const ctx = makeCtx(addVersion, {
      companyId: "co-1",
      selectFn: ownSelect.select,
    });

    const result = await createArtifactVersionTool.execute(
      { artifactId: "art-own", content: "ok" },
      ctx,
    );

    expect(result.success).toBe(true);
    expect((result.data as any).versionNumber).toBe(2);
    expect(addVersion).toHaveBeenCalledTimes(1);
    expect(addVersion).toHaveBeenCalledWith("art-own", {
      source: "agent",
      content: "ok",
      parentVersionId: null,
    });
  });
});
