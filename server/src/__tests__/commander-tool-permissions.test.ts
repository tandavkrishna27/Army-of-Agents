import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const routeSrc = readFileSync(
  resolve(__dirname, "../routes/internal-agent.ts"),
  "utf8",
);

describe("tool-permissions endpoints — implementation contract", () => {
  it("has GET tool-permissions route", () => {
    expect(routeSrc).toContain(
      '"/companies/:companyId/internal-agent/tool-permissions"',
    );
    expect(routeSrc).toContain("router.get");
  });

  it("has PATCH tool-permissions route", () => {
    expect(routeSrc).toContain("router.patch");
    expect(routeSrc).toContain("tool-permissions");
  });

  it("PATCH uses the human-only founder gate", () => {
    expect(routeSrc).toContain('assertHumanRole(db, req, companyId, "founder")');
  });

  it("GET merges db overrides with COMMANDER_TOOL_PERMISSION_DEFAULT", () => {
    expect(routeSrc).toContain("COMMANDER_TOOL_PERMISSION_DEFAULT");
    expect(routeSrc).toContain("commanderToolPermissions");
  });
});
