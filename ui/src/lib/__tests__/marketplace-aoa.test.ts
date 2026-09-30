import { describe, it, expect } from "vitest";
import {
  AOA_DEFAULT_CREW_ITEM_ID,
  AOA_OWNERS,
  deriveMarketplacePlacement,
  isAoaItem,
  isAoaOwner,
  isAoaPackage,
} from "../marketplace-constants";
import type { MarketplaceCatalogItem, MarketplacePackage } from "@armyofagents/shared";

const item = (url: string, provider?: { id?: string; name?: string }) =>
  ({ source: { url }, provider }) as unknown as MarketplaceCatalogItem;
const pkg = (id: string, provider?: { id?: string }) =>
  ({ id, provider }) as unknown as MarketplacePackage;

describe("AoA predicates", () => {
  it("isAoaItem matches AoA github owners (case-insensitive)", () => {
    expect(isAoaItem(item("https://github.com/aoa-curated/x"))).toBe(true);
    expect(isAoaItem(item("https://github.com/MeteoriteLabs/x"))).toBe(true);
    expect(isAoaItem(item("https://github.com/ArmyOfAgents/x"))).toBe(true);
  });
  it("isAoaItem rejects third-party + non-github hosts", () => {
    expect(isAoaItem(item("https://github.com/garrytan/x"))).toBe(false);
    expect(isAoaItem(item("https://notgithub.com/aoa-curated/x"))).toBe(false);
  });
  it("isAoaItem matches by provider.id (not by display name)", () => {
    expect(isAoaItem(item("https://skills.sh/x", { id: "aoa-curated" }))).toBe(true);
    expect(isAoaItem(item("https://skills.sh/x", { name: "Army of Agents" }))).toBe(false);
  });
  it("isAoaPackage matches owner/repo id + provider.id", () => {
    expect(isAoaPackage(pkg("aoa-curated/crew"))).toBe(true);
    expect(isAoaPackage(pkg("garrytan/gstack"))).toBe(false);
    expect(isAoaPackage(pkg("x", { id: "armyofagents" }))).toBe(true);
  });
  it("isAoaOwner is case-insensitive and null-safe", () => {
    expect(isAoaOwner("MeteoriteLabs")).toBe(true);
    expect(isAoaOwner(null)).toBe(false);
    expect(isAoaOwner(undefined)).toBe(false);
    expect(isAoaOwner("garrytan")).toBe(false);
  });
  it("AOA_OWNERS entries are lowercase", () => {
    for (const o of AOA_OWNERS) expect(o).toBe(o.toLowerCase());
  });
});

describe("deriveMarketplacePlacement", () => {
  const catalogItem = (
    id: string,
    type: MarketplaceCatalogItem["type"],
    url = "https://github.com/aoa-curated/marketplace",
    requires?: MarketplaceCatalogItem["requires"],
  ) =>
    ({
      id,
      type,
      source: { url },
      requires,
    }) as MarketplaceCatalogItem;

  it("derives crew membership from Default Crew and keeps first-party standalone items in type shelves", () => {
    const items = [
      catalogItem(AOA_DEFAULT_CREW_ITEM_ID, "team", undefined, [
        { type: "agent", id: "agent:aoa-curated/steward" },
        { type: "agent", id: "agent:aoa-curated/reviewer" },
      ]),
      catalogItem("agent:aoa-curated/steward", "agent"),
      catalogItem("agent:aoa-curated/reviewer", "agent"),
      catalogItem("agent:aoa-curated/senior-engineer", "agent"),
      catalogItem("plugin:aoa-curated/slack", "plugin"),
      catalogItem("skill:aoa-curated/a", "skill"),
      catalogItem("skill:aoa-curated/b", "skill"),
      catalogItem("agent:community/helper", "agent", "https://github.com/community/helper"),
    ];
    const packages: MarketplacePackage[] = [
      {
        id: "MeteoriteLabs/aoa-marketplace",
        memberItemIds: ["skill:aoa-curated/a", "skill:aoa-curated/b"],
      } as MarketplacePackage,
      {
        id: "community/skills",
        memberItemIds: ["skill:community/a"],
      } as MarketplacePackage,
    ];

    const result = deriveMarketplacePlacement(items, packages);

    expect(result.aoaItems.map((entry) => entry.id)).toEqual([
      AOA_DEFAULT_CREW_ITEM_ID,
      "agent:aoa-curated/steward",
      "agent:aoa-curated/reviewer",
    ]);
    expect(result.mainItems.map((entry) => entry.id)).toEqual([
      "agent:aoa-curated/senior-engineer",
      "plugin:aoa-curated/slack",
      "agent:community/helper",
    ]);
    expect(result.aoaPackages.map((entry) => entry.id)).toEqual([
      "MeteoriteLabs/aoa-marketplace",
    ]);
    expect(result.mainPackages.map((entry) => entry.id)).toEqual([
      "community/skills",
    ]);
  });

  it("does not treat a first-party plugin required by malformed crew data as a crew agent", () => {
    const result = deriveMarketplacePlacement([
      catalogItem(AOA_DEFAULT_CREW_ITEM_ID, "team", undefined, [
        { type: "plugin", id: "plugin:aoa-curated/slack" },
      ]),
      catalogItem("plugin:aoa-curated/slack", "plugin"),
    ]);

    expect(result.aoaItems.map((entry) => entry.id)).toEqual([
      AOA_DEFAULT_CREW_ITEM_ID,
    ]);
    expect(result.mainItems.map((entry) => entry.id)).toEqual([
      "plugin:aoa-curated/slack",
    ]);
  });
});
