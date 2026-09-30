import { describe, it, expect, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = () =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "$inferSelect" || prop === "$inferInsert") return {};
          return Symbol(String(prop));
        },
      },
    );
  return {
    artifacts: makeTable(),
  };
});

import { createArtifactVersionTool } from "../artifact-create-version.js";

function ctxWith(addVersion: ReturnType<typeof vi.fn>, artifactCompanyId = "c1") {
  return {
    companyId: "c1",
    db: { select: () => ({ from: () => ({ where: () => Promise.resolve([{ companyId: artifactCompanyId }]) }) }) },
    services: { artifacts: { addVersion } },
  } as unknown as Parameters<typeof createArtifactVersionTool.execute>[1];
}

describe("create_artifact_version — delegates to addVersion", () => {
  it("calls artifactService.addVersion instead of inserting directly", async () => {
    const addVersion = vi.fn().mockResolvedValue({ id: "v2", versionNumber: 2 });
    const res = await createArtifactVersionTool.execute({ artifactId: "a1", content: "hi" }, ctxWith(addVersion));
    expect(addVersion).toHaveBeenCalledWith("a1", expect.objectContaining({ source: "agent", content: "hi" }));
    expect(res.success).toBe(true);
  });

  it("returns NOT_FOUND for a cross-company artifact without calling addVersion", async () => {
    const addVersion = vi.fn();
    const res = await createArtifactVersionTool.execute({ artifactId: "a1", content: "hi" }, ctxWith(addVersion, "other-co"));
    expect(addVersion).not.toHaveBeenCalled();
    expect(res.success).toBe(false);
    expect(res.error).toBe("NOT_FOUND");
  });
});
