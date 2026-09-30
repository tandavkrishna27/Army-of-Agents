import { describe, expect, it, vi } from "vitest";
import { createActionTools } from "../services/internal-agent/tools/action-tools.js";

describe("update_company_identity tool", () => {
  const tools = createActionTools();
  const tool = tools.find((t) => t.name === "update_company_identity");

  it("exists in action tools", () => {
    expect(tool).toBeDefined();
  });

  it("requires founder role", () => {
    expect(tool!.requiredRole).toBe("founder");
  });

  it("requires confirmation", () => {
    expect(tool!.requiresConfirmation).toBe(true);
  });

  it("updates vision and mission via ctx.services.companies.update", async () => {
    const updateSpy = vi.fn().mockResolvedValue({
      id: "c1",
      name: "Acme",
      vision: "New vision",
      mission: "New mission",
    });
    const ctx = {
      companyId: "c1",
      services: { companies: { update: updateSpy } },
    } as any;

    const result = await tool!.execute(
      { vision: "New vision", mission: "New mission" },
      ctx,
    );

    expect(updateSpy).toHaveBeenCalledWith("c1", {
      vision: "New vision",
      mission: "New mission",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty updates (both vision and mission absent)", async () => {
    const ctx = {
      companyId: "c1",
      services: { companies: { update: vi.fn() } },
    } as any;
    const result = await tool!.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/vision or mission/i);
  });
});
