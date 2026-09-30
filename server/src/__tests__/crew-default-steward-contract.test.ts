import { describe, expect, it } from "vitest";
import type { CatalogItem } from "@armyofagents/shared";
import {
  catalogPublishesStewardInDefaultCrew,
  DEFAULT_CREW_TEAM_ITEM_ID,
  STEWARD_CATALOG_ITEM_ID,
} from "../services/marketplace-install/crew-constants.js";

function item(
  id: string,
  type: CatalogItem["type"],
  status: CatalogItem["status"] = "active",
): CatalogItem {
  return {
    id,
    type,
    name: id,
    description: `${id} fixture`,
    version: "1.0.0",
    source: { adapter: "test", url: "https://example.test", locator: id },
    trust: { tier: "verified", source: "test" },
    status,
    addedAt: "2026-07-27T00:00:00.000Z",
    category: "workflows",
    tags: [],
  };
}

function validItems(): CatalogItem[] {
  return [
    {
      ...item(DEFAULT_CREW_TEAM_ITEM_ID, "team"),
      requires: [{ type: "agent", id: STEWARD_CATALOG_ITEM_ID }],
    },
    item(STEWARD_CATALOG_ITEM_ID, "agent"),
  ];
}

describe("catalogPublishesStewardInDefaultCrew", () => {
  it("accepts one active Steward required by the active default crew", () => {
    expect(catalogPublishesStewardInDefaultCrew(validItems())).toBe(true);
  });

  it("rejects a stale default crew that does not require Steward", () => {
    const items = validItems();
    items[0] = { ...items[0], requires: [] };
    expect(catalogPublishesStewardInDefaultCrew(items)).toBe(false);
  });

  it.each([
    ["inactive team", 0],
    ["inactive Steward", 1],
  ])("rejects an %s", (_label, index) => {
    const items = validItems();
    items[index] = { ...items[index], status: "deprecated" };
    expect(catalogPublishesStewardInDefaultCrew(items)).toBe(false);
  });

  it("rejects a missing or wrong-type Steward item", () => {
    expect(catalogPublishesStewardInDefaultCrew(validItems().slice(0, 1))).toBe(false);
    const items = validItems();
    items[1] = { ...items[1], type: "skill" };
    expect(catalogPublishesStewardInDefaultCrew(items)).toBe(false);
  });
});
