/**
 * Artifact Lifecycle P1 — MCP attach-artifact-version asset path.
 *
 * Verifies handleAttachArtifactVersion:
 *   (a) forwards the new asset-metadata fields to artifactsSvc.addVersion when
 *       the caller supplies storageKind="asset" + a company-owned assetId.
 *   (b) returns an error result (ok:false) when the asset is NOT owned by the
 *       caller's company — defense-in-depth at the protocol boundary, on top of
 *       the service-level assertAssetOwned guard (Task 3).
 *
 * Mock note: this test mocks @armyofagents/db + drizzle-orm (the drizzle ESM
 * cycle workaround used across the MCP write-tools suite). The handler reaches
 * the asset-ownership branch with scope:{kind:"founder"} — filterArtifactsForScope
 * short-circuits for founder (never touches ctx.db). artifactProjectMap AND the
 * new asset check both run ctx.db.select().from().where(), so the stubbed db
 * chain returns the same asset-rows array for both. The artifact tenant check
 * passes because artifactsSvc.getById returns an artifact with the matching
 * companyId; the permission check passes because canAccessEntity → true.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = () =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "$inferSelect" || prop === "$inferInsert") return {};
          return Symbol(String(prop));
        },
      },
    );
  return {
    assets: makeTable(),
    issues: makeTable(),
    userRoles: makeTable(),
    projectGoals: makeTable(),
    agentProjects: makeTable(),
  };
});

vi.mock("../../services/index.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/inbox-producer.js", () => ({
  enqueueInboxItem: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/memory-write.js", () => ({
  writeMemoryAndIndex: vi.fn().mockResolvedValue({ memoryItemId: "mem-1" }),
}));

import { handleAttachArtifactVersion } from "../tools/write-tools.js";

function ctxWith(
  assetRows: Array<{ id: string }>,
  addVersion = vi.fn().mockResolvedValue({ id: "v2", versionNumber: 2 }),
) {
  return {
    companyId: "c1",
    scope: { kind: "founder", userId: "u1" },
    actor: { userId: "u1", companyId: "c1", keyId: "k1", source: "board" },
    actorInfo: { actorType: "user", actorId: "u1", agentId: null, runId: null },
    // Single chain reused by artifactProjectMap (rows have no artifactId → empty
    // map → linkedProjectId=null) AND the asset-ownership check (rows[0] ?? null).
    db: {
      select: () => ({
        from: () => ({ where: () => Promise.resolve(assetRows) }),
      }),
    },
    services: {
      artifactsSvc: {
        getById: vi.fn().mockResolvedValue({ id: "art-1", companyId: "c1" }),
        addVersion,
      },
      permissionsSvc: { canAccessEntity: vi.fn().mockResolvedValue(true) },
    },
  } as unknown as Parameters<typeof handleAttachArtifactVersion>[0];
}

describe("MCP attach-artifact-version — asset path", () => {
  // assetId is z.string().uuid() in mcpArtifactVersionShape, so a valid UUID is
  // required to reach the asset-ownership branch.
  const OWNED_ASSET = "22222222-2222-2222-2222-222222222222";

  it("forwards asset fields when the asset is company-owned", async () => {
    const addVersion = vi.fn().mockResolvedValue({ id: "v2", versionNumber: 2 });
    const ctx = ctxWith([{ id: OWNED_ASSET }], addVersion);
    const res = await handleAttachArtifactVersion(ctx, {
      artifactId: "11111111-1111-1111-1111-111111111111",
      sourceDetail: "cli",
      storageKind: "asset",
      assetId: OWNED_ASSET,
      filename: "f.pdf",
      contentType: "application/pdf",
      byteSize: 10,
    });
    expect(res.ok).toBe(true);
    expect(addVersion).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      expect.objectContaining({ storageKind: "asset", assetId: OWNED_ASSET }),
    );
  });

  it("rejects an asset not owned by the company", async () => {
    const addVersion = vi.fn();
    const ctx = ctxWith([], addVersion); // asset lookup returns nothing
    const res = await handleAttachArtifactVersion(ctx, {
      artifactId: "11111111-1111-1111-1111-111111111111",
      sourceDetail: "cli",
      storageKind: "asset",
      assetId: "11111111-1111-1111-1111-1111111111ff",
    });
    expect(res.ok).toBe(false);
    expect(addVersion).not.toHaveBeenCalled();
  });
});
