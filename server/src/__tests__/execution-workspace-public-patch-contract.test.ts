import { describe, expect, it } from "vitest";
import { updateExecutionWorkspaceSchema } from "@armyofagents/shared";

describe("execution workspace public PATCH contract", () => {
  it.each([
    { cwd: "/host/victim" },
    { providerRef: "/host/victim" },
    { metadata: { createdByRuntime: true } },
    { cleanupEligibleAt: new Date().toISOString() },
    { cleanupReason: "forged" },
    { repoUrl: "file:///host/victim" },
    { baseRef: "attacker" },
    { branchName: "attacker" },
    { status: "cleanup_failed" },
    { config: { desiredState: "running" } },
    { config: { serviceStates: { api: "running" } } },
  ])("rejects runtime-owned field %#", (patch) => {
    expect(updateExecutionWorkspaceSchema.safeParse(patch).success).toBe(false);
  });

  it("allows only user-facing rename, archive, and config changes", () => {
    expect(updateExecutionWorkspaceSchema.safeParse({
      name: "Renamed",
      status: "archived",
      config: { workspaceRuntime: { services: [] } },
    }).success).toBe(true);
  });
});
