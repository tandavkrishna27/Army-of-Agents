import { describe, it, expect } from "vitest";
import { HOME_BOARD_ALLOWED_SIZES } from "@armyofagents/shared";
import { widgetRegistry, getWidget, listWidgets } from "../../components/home/widgets/registry";

describe("widgetRegistry", () => {
  it("keys each def by its own key", () => {
    for (const [key, def] of Object.entries(widgetRegistry)) expect(def.key).toBe(key);
  });
  it("returns undefined for an unknown key (no throw)", () => {
    expect(getWidget("nope" as never)).toBeUndefined();
  });
  it("registers the four Plan-1 widgets plus the four Plan-2 widgets plus the Plan-6 widgets", () => {
    expect(Object.keys(widgetRegistry).sort()).toEqual([
      "action-queue",
      "activity-feed",
      "agents-now",
      "approvals",
      "budget",
      "discussions",
      "memory-review",
      "my-tasks",
      "objectives",
      "suggestions",
    ]);
  });
  it("listWidgets returns every def", () => {
    expect(listWidgets()).toHaveLength(10);
  });

  it("references HOME_BOARD_ALLOWED_SIZES[key] for allowedSizes (not a copy)", () => {
    for (const [key, def] of Object.entries(widgetRegistry)) {
      expect(def.allowedSizes).toBe(HOME_BOARD_ALLOWED_SIZES[key as keyof typeof HOME_BOARD_ALLOWED_SIZES]);
    }
  });

  it("sets defaultSize to allowedSizes[0] for every def", () => {
    for (const def of Object.values(widgetRegistry)) {
      expect(def.defaultSize).toBe(def.allowedSizes[0]);
      expect(def.allowedSizes).toContain(def.defaultSize);
    }
  });

  it("gives every def an icon", () => {
    for (const def of Object.values(widgetRegistry)) {
      expect(def.icon).toBeTruthy();
    }
  });
});
