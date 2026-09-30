import { describe, expect, it, vi } from "vitest";
import { buildSkillsSection } from "../services/internal-agent/commander-skills.js";

describe("buildSkillsSection", () => {
  it("renders each resolved skill's markdown under a Skills heading", async () => {
    const resolve = vi.fn(async () => ([{ key:"k1", name:"Refunds", markdown:"# Refunds\nDo X" }]));
    const out = await buildSkillsSection({ companyId:"c1", agentId:"a1", resolve });
    expect(out).toContain("## Skills");
    expect(out).toContain("Refunds");
    expect(out).toContain("Do X");
  });
  it("returns empty string and never throws when resolution fails", async () => {
    const out = await buildSkillsSection({ companyId:"c1", agentId:"a1", resolve: async()=>{ throw new Error("bad"); } });
    expect(out).toBe("");
  });
});
