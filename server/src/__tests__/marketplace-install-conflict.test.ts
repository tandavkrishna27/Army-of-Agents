import { describe, it, expect, vi } from "vitest";

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return { agents: tableProxy, teams: tableProxy };
});
vi.mock("drizzle-orm", () => ({ eq: () => Symbol("op:eq"), and: () => Symbol("op:and"), like: () => Symbol("op:like") }));

import { resolveAgentNameConflict, resolveTeamSlugConflict } from "../services/marketplace-install/conflict-resolver.js";

describe("resolveAgentNameConflict", () => {
  it("returns desired name if no conflict", async () => {
    const db = { select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) };
    expect(await resolveAgentNameConflict({ db: db as any, companyId: "c1", desiredName: "Engineer" })).toBe("Engineer");
  });

  it("appends -2 if Engineer exists", async () => {
    const db = { select: () => ({ from: () => ({ where: () => Promise.resolve([{ name: "Engineer" }]) }) }) };
    expect(await resolveAgentNameConflict({ db: db as any, companyId: "c1", desiredName: "Engineer" })).toBe("Engineer-2");
  });

  it("finds next available suffix when Engineer + Engineer-2 exist", async () => {
    const db = { select: () => ({ from: () => ({ where: () => Promise.resolve([{ name: "Engineer" }, { name: "Engineer-2" }]) }) }) };
    expect(await resolveAgentNameConflict({ db: db as any, companyId: "c1", desiredName: "Engineer" })).toBe("Engineer-3");
  });

  it("handles non-contiguous suffixes (Engineer + Engineer-3 → Engineer-2)", async () => {
    const db = { select: () => ({ from: () => ({ where: () => Promise.resolve([{ name: "Engineer" }, { name: "Engineer-3" }]) }) }) };
    expect(await resolveAgentNameConflict({ db: db as any, companyId: "c1", desiredName: "Engineer" })).toBe("Engineer-2");
  });
});

describe("resolveTeamSlugConflict", () => {
  it("returns desired slug if no conflict", async () => {
    const db = { select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) };
    expect(await resolveTeamSlugConflict({ db: db as any, companyId: "c1", desiredSlug: "engineering" })).toBe("engineering");
  });

  it("appends -2 if engineering exists", async () => {
    const db = { select: () => ({ from: () => ({ where: () => Promise.resolve([{ slug: "engineering" }]) }) }) };
    expect(await resolveTeamSlugConflict({ db: db as any, companyId: "c1", desiredSlug: "engineering" })).toBe("engineering-2");
  });
});
