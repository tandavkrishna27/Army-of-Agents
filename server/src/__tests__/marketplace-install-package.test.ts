import { describe, expect, it, vi } from "vitest";
import type { MarketplaceCatalogItem, MarketplacePackage } from "@armyofagents/shared";
import { installSkillPackage } from "../services/marketplace-install/package-installer.js";

function skill(id: string, version = "1.0.0"): MarketplaceCatalogItem {
  return {
    id,
    type: "skill",
    name: id.split("/").pop() ?? id,
    description: "Skill",
    version,
    category: "productivity",
    tags: ["official"],
    source: {
      adapter: "github",
      url: "https://github.com/anthropic/skills",
      locator: id,
    },
    trust: { tier: "verified", source: "verified" },
    status: "active",
    addedAt: "2026-05-14T00:00:00.000Z",
    content: { inline: "# Skill" },
    provider: {
      id: "anthropic",
      name: "Anthropic",
      fallbackInitials: "A",
      logoUrl: "https://github.com/anthropics.png",
    },
  };
}

const pkg: MarketplacePackage = {
  id: "anthropic/skills",
  name: "skills",
  sourceUrl: "https://github.com/anthropic/skills",
  memberItemIds: ["skill:anthropic/skills/a", "skill:anthropic/skills/b"],
  count: 2,
  verified: true,
  explicit: false,
  provider: {
    id: "anthropic",
    name: "Anthropic",
    fallbackInitials: "A",
    logoUrl: "https://github.com/anthropics.png",
  },
};

describe("installSkillPackage", () => {
  it("installs every skill member and records cascade results", async () => {
    const installSkill = vi
      .fn()
      .mockResolvedValueOnce({ skillId: "skill-row-a" })
      .mockResolvedValueOnce({ skillId: "skill-row-b" });

    const result = await installSkillPackage({
      pkg,
      memberItems: [skill("skill:anthropic/skills/a"), skill("skill:anthropic/skills/b")],
      companyId: "company-1",
      db: {} as any,
      installSkill,
    });

    expect(result.installedSkillIds).toEqual(["skill-row-a", "skill-row-b"]);
    expect(result.cascadeResults).toHaveLength(2);
    expect(result.cascadeResults[0]).toMatchObject({
      step: "package-member-skill-install",
      itemId: "skill:anthropic/skills/a",
      status: "success",
      resultEntityId: "skill-row-a",
    });
    expect(installSkill).toHaveBeenCalledWith(expect.objectContaining({
      packageContext: expect.objectContaining({
        packageId: "anthropic/skills",
        packageName: "skills",
        provider: pkg.provider,
      }),
    }));
  });

  it("marks already-installed same-version members as skipped", async () => {
    const installSkill = vi.fn().mockResolvedValue({ skillId: "existing-row", alreadyInstalled: true });

    const result = await installSkillPackage({
      pkg: { ...pkg, memberItemIds: ["skill:anthropic/skills/a"], count: 1 },
      memberItems: [skill("skill:anthropic/skills/a")],
      companyId: "company-1",
      db: {} as any,
      installSkill,
    });

    expect(result.cascadeResults[0]).toMatchObject({
      status: "skipped",
      resultEntityId: "existing-row",
    });
  });

  it("rejects mixed packages for v1", async () => {
    const mixed = {
      ...skill("team:anthropic/skills/team"),
      type: "team" as const,
    };

    await expect(
      installSkillPackage({
        pkg: { ...pkg, memberItemIds: [mixed.id], count: 1 },
        memberItems: [mixed],
        companyId: "company-1",
        db: {} as any,
        installSkill: vi.fn(),
      }),
    ).rejects.toThrow("Install all supports skill-only packages in this version");
  });

  it("records failure detail when a member install fails", async () => {
    const installSkill = vi.fn().mockRejectedValue(new Error("version mismatch"));

    await expect(
      installSkillPackage({
        pkg: { ...pkg, memberItemIds: ["skill:anthropic/skills/a"], count: 1 },
        memberItems: [skill("skill:anthropic/skills/a")],
        companyId: "company-1",
        db: {} as any,
        installSkill,
      }),
    ).rejects.toMatchObject({
      message: "Package install failed for skill:anthropic/skills/a: version mismatch",
      cascadeResults: [
        expect.objectContaining({
          status: "failure",
          itemId: "skill:anthropic/skills/a",
          errorMessage: "version mismatch",
        }),
      ],
    });
  });
});
