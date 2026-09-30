import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client", () => ({
  api: {
    get: vi.fn(),
    delete: vi.fn(),
  },
}));

import { marketplaceApi } from "../marketplace";
import { api } from "../client";

describe("marketplaceApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("URL-encodes catalog item IDs when resolving install plans", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      rootItem: { id: "agent:aoa-curated/senior-engineer", name: "Senior Engineer", type: "agent", version: "1.0.0" },
      steps: [],
      conflicts: [],
    });

    await marketplaceApi.resolvePlan("company-1", "agent:aoa-curated/senior-engineer");

    expect(api.get).toHaveBeenCalledWith(
      "/companies/company-1/marketplace/resolve/agent%3Aaoa-curated%2Fsenior-engineer",
    );
  });

  it("uninstalls a team via DELETE and returns the retained-agents result", async () => {
    const result = {
      success: true,
      deletedAgentIds: ["a1", "a2"],
      retainedAgentIds: ["s1"],
      retainedAgents: [{ id: "s1", name: "Steward", role: "steward", why: "kept" }],
    };
    vi.mocked(api.delete).mockResolvedValueOnce(result);

    const out = await marketplaceApi.uninstallTeam("company-1", "team-9");

    expect(api.delete).toHaveBeenCalledWith("/companies/company-1/marketplace/teams/team-9");
    // The caller receives retainedAgents so the UI can surface them (task #33).
    expect(out.retainedAgents[0].name).toBe("Steward");
    expect(out.retainedAgentIds).toEqual(["s1"]);
  });
});
