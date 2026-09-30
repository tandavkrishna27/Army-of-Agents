import { describe, it, expect } from "vitest";
import type { MarketplaceCatalogItem } from "@armyofagents/shared";
import { derivePackages } from "../derivePackages.js";

function makeItem(overrides: Partial<MarketplaceCatalogItem> & { id: string }): MarketplaceCatalogItem {
  return {
    type: "skill",
    name: overrides.id,
    description: "test item",
    version: "1.0.0",
    source: {
      adapter: "github-skills",
      url: "https://github.com/example/repo",
      locator: "default",
    },
    trust: { tier: "verified", source: "x" },
    status: "active",
    addedAt: "2026-05-01T00:00:00Z",
    category: "engineering",
    tags: [],
    ...overrides,
  } as MarketplaceCatalogItem;
}

describe("derivePackages", () => {
  it("returns [] for an empty input", () => {
    expect(derivePackages([])).toEqual([]);
  });

  it("groups items by github owner/repo extracted from source.url", () => {
    const items = [
      makeItem({ id: "skill:gstack/office-hours", source: { adapter: "g", url: "https://github.com/garrytan/gstack/tree/abc/skills/office-hours", locator: "office-hours" } }),
      makeItem({ id: "skill:gstack/qa", source: { adapter: "g", url: "https://github.com/garrytan/gstack/tree/abc/skills/qa", locator: "qa" } }),
      makeItem({ id: "skill:sp/brainstorming", source: { adapter: "g", url: "https://github.com/anthropic/superpowers/tree/main/skills/brainstorming", locator: "brainstorming" } }),
      makeItem({ id: "skill:sp/code-review", source: { adapter: "g", url: "https://github.com/anthropic/superpowers/tree/main/skills/code-review", locator: "code-review" } }),
    ];
    const packages = derivePackages(items);
    expect(packages).toHaveLength(2);
    const gstack = packages.find((p) => p.id === "garrytan/gstack")!;
    const sp = packages.find((p) => p.id === "anthropic/superpowers")!;
    expect(gstack.memberItemIds.sort()).toEqual(["skill:gstack/office-hours", "skill:gstack/qa"]);
    expect(sp.memberItemIds.sort()).toEqual(["skill:sp/brainstorming", "skill:sp/code-review"]);
  });

  it("carries provider metadata from package members", () => {
    const packages = derivePackages([
      makeItem({
        id: "skill:gstack/qa",
        source: { adapter: "github-skills", url: "https://github.com/garrytan/gstack/tree/abc/qa", locator: "qa" },
        provider: { id: "gstack", name: "Garry Tan", logoUrl: "https://github.com/garrytan.png", fallbackInitials: "GT" },
      }),
      makeItem({
        id: "skill:gstack/scrape",
        source: { adapter: "github-skills", url: "https://github.com/garrytan/gstack/tree/abc/scrape", locator: "scrape" },
        provider: { id: "gstack", name: "Garry Tan", logoUrl: "https://github.com/garrytan.png", fallbackInitials: "GT" },
      }),
    ]);

    expect(packages[0]?.provider).toEqual({
      id: "gstack",
      name: "Garry Tan",
      logoUrl: "https://github.com/garrytan.png",
      fallbackInitials: "GT",
    });
  });

  it("synthesizes provider logo metadata from github owner when members omit provider metadata", () => {
    const packages = derivePackages([
      makeItem({
        id: "skill:angular/a",
        source: { adapter: "github-skills", url: "https://github.com/angular/skills/tree/abc/a", locator: "a" },
      }),
      makeItem({
        id: "skill:angular/b",
        source: { adapter: "github-skills", url: "https://github.com/angular/skills/tree/abc/b", locator: "b" },
      }),
    ]);

    expect(packages[0]?.provider).toEqual({
      id: "angular",
      name: "Angular",
      homepageUrl: "https://github.com/angular",
      logoUrl: "https://github.com/angular.png",
      fallbackInitials: "A",
    });
  });

  it("strips a trailing .git suffix from the repo name", () => {
    const items = [
      makeItem({ id: "a", source: { adapter: "g", url: "https://github.com/owner/repo.git", locator: "x" } }),
      makeItem({ id: "b", source: { adapter: "g", url: "https://github.com/owner/repo.git/tree/main/y", locator: "y" } }),
    ];
    const [pkg] = derivePackages(items);
    expect(pkg.id).toBe("owner/repo");
    expect(pkg.name).toBe("repo");
  });

  it("excludes single-item synthesized groups (threshold = 2)", () => {
    const items = [
      makeItem({ id: "loner", source: { adapter: "g", url: "https://github.com/foo/bar", locator: "z" } }),
      makeItem({ id: "p1", source: { adapter: "g", url: "https://github.com/qux/quux/tree/main/a", locator: "a" } }),
      makeItem({ id: "p2", source: { adapter: "g", url: "https://github.com/qux/quux/tree/main/b", locator: "b" } }),
    ];
    const packages = derivePackages(items);
    expect(packages).toHaveLength(1);
    expect(packages[0]!.id).toBe("qux/quux");
  });

  it("excludes items with non-github source URLs from synthesis", () => {
    const items = [
      makeItem({ id: "x1", source: { adapter: "g", url: "https://gitlab.com/foo/bar", locator: "x" } }),
      makeItem({ id: "x2", source: { adapter: "g", url: "https://gitlab.com/foo/bar", locator: "y" } }),
    ];
    expect(derivePackages(items)).toEqual([]);
  });

  it("explicit packageId overrides synthesis and accepts groups of size 1", () => {
    const items = [
      makeItem({ id: "alone", packageId: "my-curated", source: { adapter: "g", url: "https://example.com/anywhere", locator: "x" } }),
    ];
    const packages = derivePackages(items);
    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({
      id: "my-curated",
      name: "my-curated",
      explicit: true,
      count: 1,
      memberItemIds: ["alone"],
    });
  });

  it("explicit packageId pulls items together even from different source URLs", () => {
    const items = [
      makeItem({ id: "a", packageId: "joint", source: { adapter: "g", url: "https://github.com/o1/r1", locator: "x" } }),
      makeItem({ id: "b", packageId: "joint", source: { adapter: "g", url: "https://github.com/o2/r2", locator: "y" } }),
    ];
    const packages = derivePackages(items);
    expect(packages).toHaveLength(1);
    expect(packages[0]!.memberItemIds.sort()).toEqual(["a", "b"]);
  });

  it("explicit packageId on one item promotes only that item; others still synthesize separately", () => {
    const items = [
      makeItem({ id: "ex", packageId: "explicit-pkg", source: { adapter: "g", url: "https://github.com/owner/repo/tree/main/a", locator: "a" } }),
      makeItem({ id: "syn1", source: { adapter: "g", url: "https://github.com/owner/repo/tree/main/b", locator: "b" } }),
      makeItem({ id: "syn2", source: { adapter: "g", url: "https://github.com/owner/repo/tree/main/c", locator: "c" } }),
    ];
    const packages = derivePackages(items);
    expect(packages).toHaveLength(2);
    const ex = packages.find((p) => p.id === "explicit-pkg")!;
    const syn = packages.find((p) => p.id === "owner/repo")!;
    expect(ex.explicit).toBe(true);
    expect(ex.memberItemIds).toEqual(["ex"]);
    expect(syn.explicit).toBe(false);
    expect(syn.memberItemIds.sort()).toEqual(["syn1", "syn2"]);
  });

  it("explicit packageId wins over a colliding synthesized owner/repo id", () => {
    const items = [
      makeItem({ id: "ex", packageId: "owner/repo", source: { adapter: "g", url: "https://example.com/anywhere", locator: "ex" } }),
      makeItem({ id: "syn1", source: { adapter: "g", url: "https://github.com/owner/repo/tree/main/a", locator: "a" } }),
      makeItem({ id: "syn2", source: { adapter: "g", url: "https://github.com/owner/repo/tree/main/b", locator: "b" } }),
    ];
    const packages = derivePackages(items);
    // Only the explicit package emerges; synthesized "owner/repo" is suppressed.
    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({
      id: "owner/repo",
      explicit: true,
      memberItemIds: ["ex"],
    });
  });

  it("treats empty-string packageId as no override (falls through to synthesis)", () => {
    const items = [
      makeItem({ id: "a", packageId: "", source: { adapter: "g", url: "https://github.com/o/r/tree/main/a", locator: "a" } }),
      makeItem({ id: "b", packageId: "", source: { adapter: "g", url: "https://github.com/o/r/tree/main/b", locator: "b" } }),
    ];
    const packages = derivePackages(items);
    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({ id: "o/r", explicit: false, count: 2 });
  });

  it("trims whitespace from packageId and groups equivalent ids together", () => {
    const items = [
      makeItem({ id: "x", packageId: " pkg " }),
      makeItem({ id: "y", packageId: "pkg" }),
      makeItem({ id: "z", packageId: "  " }),  // whitespace-only → falls through
    ];
    const packages = derivePackages(items);
    // x + y in one explicit package; z falls through but its source is github.com/example/repo → synthesis threshold (1) → no package
    expect(packages).toHaveLength(1);
    expect(packages[0]!.id).toBe("pkg");
    expect(packages[0]!.memberItemIds.sort()).toEqual(["x", "y"]);
  });

  it("verified=true only when every member is verified", () => {
    const items = [
      makeItem({ id: "v1", trust: { tier: "verified", source: "x" }, source: { adapter: "g", url: "https://github.com/x/y/tree/main/a", locator: "a" } }),
      makeItem({ id: "v2", trust: { tier: "verified", source: "x" }, source: { adapter: "g", url: "https://github.com/x/y/tree/main/b", locator: "b" } }),
    ];
    expect(derivePackages(items)[0]!.verified).toBe(true);

    const mixed = [
      ...items,
      makeItem({ id: "c", trust: { tier: "community", source: "x" }, source: { adapter: "g", url: "https://github.com/x/y/tree/main/c", locator: "c" } }),
    ];
    expect(derivePackages(mixed)[0]!.verified).toBe(false);
  });

  it("returns memberItemIds sorted ascending and packages sorted by id ascending", () => {
    const items = [
      makeItem({ id: "z", source: { adapter: "g", url: "https://github.com/zz/zz/tree/main/a", locator: "a" } }),
      makeItem({ id: "a", source: { adapter: "g", url: "https://github.com/aa/aa/tree/main/a", locator: "a" } }),
      makeItem({ id: "m", source: { adapter: "g", url: "https://github.com/aa/aa/tree/main/m", locator: "m" } }),
      makeItem({ id: "b", source: { adapter: "g", url: "https://github.com/zz/zz/tree/main/b", locator: "b" } }),
    ];
    const packages = derivePackages(items);
    expect(packages.map((p) => p.id)).toEqual(["aa/aa", "zz/zz"]);
    expect(packages[0]!.memberItemIds).toEqual(["a", "m"]);
    expect(packages[1]!.memberItemIds).toEqual(["b", "z"]);
  });

  it("count always equals memberItemIds.length", () => {
    const items = [
      makeItem({ id: "a", source: { adapter: "g", url: "https://github.com/o/r/tree/main/a", locator: "a" } }),
      makeItem({ id: "b", source: { adapter: "g", url: "https://github.com/o/r/tree/main/b", locator: "b" } }),
      makeItem({ id: "c", source: { adapter: "g", url: "https://github.com/o/r/tree/main/c", locator: "c" } }),
    ];
    const [pkg] = derivePackages(items);
    expect(pkg!.count).toBe(pkg!.memberItemIds.length);
    expect(pkg!.count).toBe(3);
  });

  it("does NOT synthesize a package from two plugins in the same github repo", () => {
    const items = [
      makeItem({ id: "plugin:a", type: "plugin", source: { adapter: "g", url: "https://github.com/o/r/tree/main/a", locator: "a" } }),
      makeItem({ id: "plugin:b", type: "plugin", source: { adapter: "g", url: "https://github.com/o/r/tree/main/b", locator: "b" } }),
    ];
    expect(derivePackages(items)).toEqual([]);
  });

  it("does NOT synthesize a package from two agents in the same github repo", () => {
    const items = [
      makeItem({ id: "agent:a", type: "agent", source: { adapter: "g", url: "https://github.com/o/r/tree/main/a", locator: "a" } }),
      makeItem({ id: "agent:b", type: "agent", source: { adapter: "g", url: "https://github.com/o/r/tree/main/b", locator: "b" } }),
    ];
    expect(derivePackages(items)).toEqual([]);
  });

  it("does NOT synthesize a package from two teams in the same github repo", () => {
    const items = [
      makeItem({ id: "team:a", type: "team", source: { adapter: "g", url: "https://github.com/o/r/tree/main/a", locator: "a" } }),
      makeItem({ id: "team:b", type: "team", source: { adapter: "g", url: "https://github.com/o/r/tree/main/b", locator: "b" } }),
    ];
    expect(derivePackages(items)).toEqual([]);
  });

  it("excludes non-skill items from synthesis even when mixed with skills below threshold", () => {
    const items = [
      makeItem({ id: "skill:a", type: "skill", source: { adapter: "g", url: "https://github.com/o/r/tree/main/a", locator: "a" } }),
      makeItem({ id: "plugin:b", type: "plugin", source: { adapter: "g", url: "https://github.com/o/r/tree/main/b", locator: "b" } }),
    ];
    // Only the skill survives the type guard, but the threshold is 2 skills → no package emitted.
    expect(derivePackages(items)).toEqual([]);
  });

  it("synthesizes a skill-only package even when mixed with non-skill items in the same repo", () => {
    const items = [
      makeItem({ id: "skill:a", type: "skill", source: { adapter: "g", url: "https://github.com/o/r/tree/main/a", locator: "a" } }),
      makeItem({ id: "skill:b", type: "skill", source: { adapter: "g", url: "https://github.com/o/r/tree/main/b", locator: "b" } }),
      makeItem({ id: "plugin:c", type: "plugin", source: { adapter: "g", url: "https://github.com/o/r/tree/main/c", locator: "c" } }),
    ];
    const packages = derivePackages(items);
    expect(packages).toHaveLength(1);
    expect(packages[0]!.id).toBe("o/r");
    expect(packages[0]!.memberItemIds).toEqual(["skill:a", "skill:b"]);
  });

  it("loose policy: explicit packageId on a single plugin still emits a package", () => {
    const items = [
      makeItem({ id: "plugin:lone", type: "plugin", packageId: "curated-plugin-bundle", source: { adapter: "g", url: "https://github.com/anywhere/x", locator: "x" } }),
    ];
    const packages = derivePackages(items);
    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({
      id: "curated-plugin-bundle",
      explicit: true,
      count: 1,
      memberItemIds: ["plugin:lone"],
    });
  });

  it("loose policy: explicit packageId pulls a plugin and an agent into one mixed-type package", () => {
    const items = [
      makeItem({ id: "plugin:p", type: "plugin", packageId: "joint", source: { adapter: "g", url: "https://github.com/o/r/tree/main/p", locator: "p" } }),
      makeItem({ id: "agent:a", type: "agent", packageId: "joint", source: { adapter: "g", url: "https://github.com/o/r/tree/main/a", locator: "a" } }),
    ];
    const packages = derivePackages(items);
    expect(packages).toHaveLength(1);
    expect(packages[0]!.id).toBe("joint");
    expect(packages[0]!.memberItemIds.sort()).toEqual(["agent:a", "plugin:p"]);
    expect(packages[0]!.explicit).toBe(true);
  });
});
