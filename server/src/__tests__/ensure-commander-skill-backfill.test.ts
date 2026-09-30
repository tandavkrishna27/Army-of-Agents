import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(
  join(__dirname, "../services/internal-agent/aoa-agents/ensure-commander.ts"),
  "utf-8",
);

describe("ensureCommanderAgent skill backfill", () => {
  it("guards the backfill with a one-time metadata flag", () => {
    expect(src).toContain("commanderSkillsInitialized");
  });
  it("initializes skillKeys from installed company skills", () => {
    expect(src).toMatch(/skillKeys:\s*installed\.map/);
    expect(src).toContain("companySkills");
  });
  it("imports companySkills from the db package", () => {
    expect(src).toMatch(/import\s*\{[^}]*companySkills[^}]*\}\s*from\s*"@armyofagents\/db"/);
  });
});
