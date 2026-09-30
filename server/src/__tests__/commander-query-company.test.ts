import { describe, expect, it } from "vitest";
import { createQueryTools } from "../services/internal-agent/tools/query-tools.js";

describe("query_company tool", () => {
  const tools = createQueryTools();
  const tool = tools.find((t) => t.name === "query_company");

  it("exists in the query tools list", () => {
    expect(tool).toBeDefined();
  });

  it("has category query and no confirmation required", () => {
    expect(tool!.category).toBe("query");
    expect(tool!.requiresConfirmation).toBe(false);
  });

  it("returns company identity fields from ctx", async () => {
    const ctx = {
      companyId: "c1",
      services: {
        companies: {
          get: async (id: string) => ({
            id,
            name: "Acme Corp",
            vision: "World domination",
            mission: "Ship fast",
            issuePrefix: "ACM",
            stage: "seed",
          }),
        },
      },
    } as any;

    const result = await tool!.execute({}, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      name: "Acme Corp",
      vision: "World domination",
      mission: "Ship fast",
      issuePrefix: "ACM",
      stage: "seed",
    });
  });

  it("handles missing company gracefully", async () => {
    const ctx = {
      companyId: "missing",
      services: { companies: { get: async () => null } },
    } as any;
    const result = await tool!.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });
});
