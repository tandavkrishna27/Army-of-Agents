import { describe, it, expect } from "vitest";
import type { CatalogItem } from "@armyofagents/shared";
import { isAoaCrewItem } from "../marketplace";

/** Minimal CatalogItem for pure-filter tests — only id/type/source.adapter matter. */
function item(id: string, type: CatalogItem["type"] = "agent", adapter = "aoa-curated"): CatalogItem {
  return {
    id,
    type,
    name: "X",
    description: "",
    version: "1.0.0",
    source: { adapter, url: "", locator: "" },
    trust: { tier: "unverified", source: "" },
    status: "active",
    addedAt: "",
  } as unknown as CatalogItem;
}

describe("isAoaCrewItem", () => {
  it("hides the aoa-* crew agents", () => {
    expect(isAoaCrewItem(item("agent:aoa-curated/aoa-adjutant"))).toBe(true);
    expect(isAoaCrewItem(item("agent:aoa-curated/aoa-scout"))).toBe(true);
    expect(isAoaCrewItem(item("agent:aoa-curated/aoa-memory-keeper"))).toBe(true);
  });

  it("hides the standard-crew team", () => {
    expect(isAoaCrewItem(item("team:aoa-curated/default-crew", "team"))).toBe(true);
    expect(isAoaCrewItem(item("team:aoa-curated/standard-crew", "team"))).toBe(true);
  });

  it("keeps regular curated agents (not crew)", () => {
    expect(isAoaCrewItem(item("agent:aoa-curated/senior-engineer"))).toBe(false);
    expect(isAoaCrewItem(item("agent:aoa-curated/github-issue-triager"))).toBe(false);
  });

  it("keeps non-crew teams and non-curated items", () => {
    expect(isAoaCrewItem(item("team:aoa-curated/marketing-pod", "team"))).toBe(false);
    expect(isAoaCrewItem(item("skill:github-skills/foo", "skill", "github-skills"))).toBe(false);
  });
});
