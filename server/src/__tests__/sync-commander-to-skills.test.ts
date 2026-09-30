import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncCommanderToSkills } from "../../../scripts/sync-commander-to-skills.js";

describe("syncCommanderToSkills", () => {
  let productRoot: string;
  let skillsRoot: string;
  beforeEach(() => {
    productRoot = mkdtempSync(join(tmpdir(), "prod-"));
    skillsRoot = mkdtempSync(join(tmpdir(), "skills-"));
    mkdirSync(join(productRoot, "server/src/onboarding-assets/commander"), { recursive: true });
    mkdirSync(join(productRoot, "packages/shared/src/generated"), { recursive: true });
    mkdirSync(join(skillsRoot, "commander"), { recursive: true });
    mkdirSync(join(skillsRoot, "generated"), { recursive: true });
    for (const f of ["AGENTS.md", "SOUL.md", "HEARTBEAT.md", "TOOLS.md"]) {
      writeFileSync(join(productRoot, "server/src/onboarding-assets/commander", f), `# ${f}\nsuggest_memory\n`);
    }
    writeFileSync(join(productRoot, "packages/shared/src/generated/tools.json"), `{"tools":[]}\n`);
  });
  afterEach(() => {
    rmSync(productRoot, { recursive: true, force: true });
    rmSync(skillsRoot, { recursive: true, force: true });
  });

  it("vendors persona + TOOLS.md + tools.json into the skills repo", () => {
    const written = syncCommanderToSkills({ productRoot, skillsRoot });
    for (const f of ["AGENTS.md", "SOUL.md", "HEARTBEAT.md", "TOOLS.md"]) {
      expect(readFileSync(join(skillsRoot, "commander", f), "utf8")).toContain(f);
    }
    expect(readFileSync(join(skillsRoot, "generated/tools.json"), "utf8")).toBe(`{"tools":[]}\n`);
    expect(written).toContain(join(skillsRoot, "generated/tools.json"));
  });

  it("throws when the skills root is missing the commander/ dir", () => {
    rmSync(join(skillsRoot, "commander"), { recursive: true, force: true });
    expect(() => syncCommanderToSkills({ productRoot, skillsRoot })).toThrow();
  });
});
