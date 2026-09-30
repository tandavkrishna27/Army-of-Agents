// ui/src/lib/__tests__/skillPackages.test.ts
import { describe, it, expect } from "vitest";
import type { CompanySkillListItem } from "@armyofagents/shared";
import { derivePackagesForLibrary } from "../skillPackages";

function makeSkill(over: Partial<CompanySkillListItem> & { id: string }): CompanySkillListItem {
  return {
    id: over.id,
    companyId: "c1",
    key: over.key ?? `k-${over.id}`,
    slug: over.slug ?? over.id,
    name: over.name ?? `Skill ${over.id}`,
    description: null,
    sourceType: "github",
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    createdAt: new Date(),
    updatedAt: new Date(),
    attachedAgentCount: 0,
    editable: false,
    editableReason: null,
    sourceLabel: null,
    sourceBadge: "github",
    sourcePath: null,
    ...over,
    metadata: over.metadata ?? null,
  } as CompanySkillListItem;
}

describe("derivePackagesForLibrary", () => {
  it("returns empty arrays for empty input", () => {
    expect(derivePackagesForLibrary([])).toEqual({ packages: [], standalones: [] });
  });

  it("groups 2+ skills with same owner/repo into a package", () => {
    const skills = [
      makeSkill({ id: "a", metadata: { owner: "garrytan", repo: "gstack" } }),
      makeSkill({ id: "b", metadata: { owner: "garrytan", repo: "gstack" } }),
    ];
    const { packages, standalones } = derivePackagesForLibrary(skills);
    expect(packages).toHaveLength(1);
    expect(packages[0]?.id).toBe("garrytan/gstack");
    expect(packages[0]?.memberSkillIds).toEqual(["a", "b"]);
    expect(standalones).toHaveLength(0);
  });

  it("leaves a single-skill repo as standalone (below threshold)", () => {
    const skills = [makeSkill({ id: "lonely", metadata: { owner: "octocat", repo: "hello" } })];
    const { packages, standalones } = derivePackagesForLibrary(skills);
    expect(packages).toHaveLength(0);
    expect(standalones).toHaveLength(1);
  });

  it("sends local_path skills directly to standalones", () => {
    const skills = [makeSkill({ id: "x", sourceType: "local_path", sourceBadge: "local" })];
    const { packages, standalones } = derivePackagesForLibrary(skills);
    expect(packages).toHaveLength(0);
    expect(standalones[0]?.id).toBe("x");
  });

  it("treats skills_sh skills as packageable (they share owner/repo metadata)", () => {
    const skills = [
      makeSkill({ id: "p", sourceType: "skills_sh", metadata: { owner: "vercel-labs", repo: "skills" } }),
      makeSkill({ id: "q", sourceType: "skills_sh", metadata: { owner: "vercel-labs", repo: "skills" } }),
    ];
    const { packages } = derivePackagesForLibrary(skills);
    expect(packages).toHaveLength(1);
    expect(packages[0]?.id).toBe("vercel-labs/skills");
  });

  it("sorts packages alphabetically by id", () => {
    const skills = [
      makeSkill({ id: "z1", metadata: { owner: "zeta", repo: "z" } }),
      makeSkill({ id: "z2", metadata: { owner: "zeta", repo: "z" } }),
      makeSkill({ id: "a1", metadata: { owner: "alpha", repo: "a" } }),
      makeSkill({ id: "a2", metadata: { owner: "alpha", repo: "a" } }),
    ];
    const { packages } = derivePackagesForLibrary(skills);
    expect(packages.map((p) => p.id)).toEqual(["alpha/a", "zeta/z"]);
  });

  it("sorts member skill ids alphabetically within a package", () => {
    const skills = [
      makeSkill({ id: "c", metadata: { owner: "x", repo: "y" } }),
      makeSkill({ id: "a", metadata: { owner: "x", repo: "y" } }),
      makeSkill({ id: "b", metadata: { owner: "x", repo: "y" } }),
    ];
    const { packages } = derivePackagesForLibrary(skills);
    expect(packages[0]?.memberSkillIds).toEqual(["a", "b", "c"]);
  });

  it("honors explicit packageId override (threshold 1)", () => {
    const skills = [
      makeSkill({ id: "solo", metadata: { packageId: "myorg/curated" } }),
    ];
    const { packages } = derivePackagesForLibrary(skills);
    expect(packages).toHaveLength(1);
    expect(packages[0]?.id).toBe("myorg/curated");
  });

  it("groups catalog skills with explicit package metadata and provider logo", () => {
    const skills = [
      makeSkill({
        id: "cat-a",
        sourceType: "catalog",
        sourceBadge: "catalog",
        metadata: {
          packageId: "anthropic/skills",
          catalogPackageName: "skills",
          catalogPackageSourceUrl: "https://github.com/anthropic/skills",
          catalogProvider: {
            id: "anthropic",
            name: "Anthropic",
            fallbackInitials: "A",
            logoUrl: "https://github.com/anthropics.png",
          },
        },
      }),
      makeSkill({
        id: "cat-b",
        sourceType: "catalog",
        sourceBadge: "catalog",
        metadata: {
          packageId: "anthropic/skills",
          catalogPackageName: "skills",
          catalogPackageSourceUrl: "https://github.com/anthropic/skills",
          catalogProvider: {
            id: "anthropic",
            name: "Anthropic",
            fallbackInitials: "A",
            logoUrl: "https://github.com/anthropics.png",
          },
        },
      }),
    ];

    const { packages, standalones } = derivePackagesForLibrary(skills);

    expect(standalones).toEqual([]);
    expect(packages[0]).toMatchObject({
      id: "anthropic/skills",
      name: "skills",
      sourceUrl: "https://github.com/anthropic/skills",
      provider: {
        id: "anthropic",
        name: "Anthropic",
        fallbackInitials: "A",
        logoUrl: "https://github.com/anthropics.png",
      },
    });
  });

  it("explicit packageId beats github synthesis on collision", () => {
    const skills = [
      makeSkill({ id: "a", metadata: { owner: "x", repo: "y", packageId: "x/y" } }),
      makeSkill({ id: "b", metadata: { owner: "x", repo: "y" } }),
    ];
    const { packages } = derivePackagesForLibrary(skills);
    // "a" is explicit, "b" is synthesized under same key — explicit wins
    // "b" falls below threshold alone → standalone
    expect(packages).toHaveLength(1);
    expect(packages[0]?.memberSkillIds).toEqual(["a"]);
  });

  it("excludes local_path skills from synthesis even with owner/repo metadata", () => {
    const skills = [
      makeSkill({ id: "lp1", sourceType: "local_path", metadata: { owner: "x", repo: "y" } }),
      makeSkill({ id: "lp2", sourceType: "local_path", metadata: { owner: "x", repo: "y" } }),
    ];
    const { packages, standalones } = derivePackagesForLibrary(skills);
    expect(packages).toHaveLength(0);
    expect(standalones).toHaveLength(2);
  });
});
