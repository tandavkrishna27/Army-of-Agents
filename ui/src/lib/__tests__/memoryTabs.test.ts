import { describe, it, expect } from "vitest";
import {
  MEMORY_BRAIN_TAB,
  MEMORY_OPEN_TAB,
  openOrActivate,
  closeTab,
  type MemoryTab,
  type TabsState,
} from "../memoryTabs";

const tab = (
  id: string,
  kind: MemoryTab["kind"] = "memory_item",
): MemoryTab => ({
  id,
  kind,
  title: id.toUpperCase(),
});

const empty: TabsState = { tabs: [], activeKey: null };

describe("memoryTabs reducer", () => {
  describe("openOrActivate", () => {
    it("appends a new tab and activates it when state is empty", () => {
      const next = openOrActivate(empty, tab("a"));
      expect(next.tabs.map((t) => t.id)).toEqual(["a"]);
      expect(next.activeKey).toEqual({ id: "a", kind: "memory_item" });
    });

    it("appends and activates a new tab when already has tabs", () => {
      const s1 = openOrActivate(empty, tab("a"));
      const s2 = openOrActivate(s1, tab("b"));
      expect(s2.tabs.map((t) => t.id)).toEqual(["a", "b"]);
      expect(s2.activeKey).toEqual({ id: "b", kind: "memory_item" });
    });

    it("activates an existing tab without duplicating it", () => {
      const s1 = openOrActivate(empty, tab("a"));
      const s2 = openOrActivate(s1, tab("b"));
      const s3 = openOrActivate(s2, tab("a"));
      expect(s3.tabs.map((t) => t.id)).toEqual(["a", "b"]);
      expect(s3.activeKey).toEqual({ id: "a", kind: "memory_item" });
    });

    it("treats memory_item and asset with the same id as different tabs", () => {
      const s1 = openOrActivate(empty, tab("x", "memory_item"));
      const s2 = openOrActivate(s1, tab("x", "asset"));
      expect(s2.tabs.length).toBe(2);
      expect(s2.activeKey).toEqual({ id: "x", kind: "asset" });
      expect(s2.tabs[1].kind).toBe("asset");
    });

    it("supports a dedicated graph tab", () => {
      const next = openOrActivate(empty, tab("company-graph", "graph"));
      expect(next.tabs[0]).toEqual({
        id: "company-graph",
        kind: "graph",
        title: "COMPANY-GRAPH",
      });
      expect(next.activeKey).toEqual({ id: "company-graph", kind: "graph" });
    });

    it("supports Map and Open viewer tabs", () => {
      const withBrain = openOrActivate(empty, MEMORY_BRAIN_TAB);
      const withOpen = openOrActivate(withBrain, MEMORY_OPEN_TAB);

      expect(withOpen.tabs).toEqual([
        { id: "company-graph", kind: "graph", title: "Map" },
        { id: "memory-open", kind: "open", title: "Open" },
      ]);
      expect(withOpen.activeKey).toEqual({ id: "memory-open", kind: "open" });
    });
  });

  describe("closeTab", () => {
    it("removes the tab and activates the previous tab when closing the active one", () => {
      const s: TabsState = {
        tabs: [tab("a"), tab("b"), tab("c")],
        activeKey: { id: "b", kind: "memory_item" },
      };
      const next = closeTab(s, "b", "memory_item");
      expect(next.tabs.map((t) => t.id)).toEqual(["a", "c"]);
      expect(next.activeKey).toEqual({ id: "a", kind: "memory_item" });
    });

    it("activates the new first tab when closing the FIRST active tab", () => {
      const s: TabsState = {
        tabs: [tab("a"), tab("b")],
        activeKey: { id: "a", kind: "memory_item" },
      };
      const next = closeTab(s, "a", "memory_item");
      expect(next.tabs.map((t) => t.id)).toEqual(["b"]);
      expect(next.activeKey).toEqual({ id: "b", kind: "memory_item" });
    });

    it("returns null activeKey when closing the only tab", () => {
      const s: TabsState = {
        tabs: [tab("a")],
        activeKey: { id: "a", kind: "memory_item" },
      };
      const next = closeTab(s, "a", "memory_item");
      expect(next.tabs).toEqual([]);
      expect(next.activeKey).toBeNull();
    });

    it("does not change activeKey when closing an INACTIVE tab", () => {
      const s: TabsState = {
        tabs: [tab("a"), tab("b")],
        activeKey: { id: "a", kind: "memory_item" },
      };
      const next = closeTab(s, "b", "memory_item");
      expect(next.tabs.map((t) => t.id)).toEqual(["a"]);
      expect(next.activeKey).toEqual({ id: "a", kind: "memory_item" });
    });

    it("returns the same state shape when closing a tab that does not exist", () => {
      const s: TabsState = {
        tabs: [tab("a")],
        activeKey: { id: "a", kind: "memory_item" },
      };
      const next = closeTab(s, "z", "memory_item");
      expect(next).toEqual(s);
    });

    it("disambiguates tabs that share an id but differ by kind", () => {
      const s: TabsState = {
        tabs: [tab("x", "memory_item"), tab("x", "asset")],
        activeKey: { id: "x", kind: "asset" },
      };
      // Close the asset tab; memory_item with same id remains and becomes active.
      const next = closeTab(s, "x", "asset");
      expect(next.tabs.length).toBe(1);
      expect(next.tabs[0].kind).toBe("memory_item");
      expect(next.activeKey).toEqual({ id: "x", kind: "memory_item" });
    });

    it("preserves activeKey when closing an unrelated same-id tab", () => {
      const s: TabsState = {
        tabs: [tab("x", "memory_item"), tab("x", "asset")],
        activeKey: { id: "x", kind: "memory_item" },
      };
      // Close the asset; the memory_item should remain active.
      const next = closeTab(s, "x", "asset");
      expect(next.tabs.length).toBe(1);
      expect(next.tabs[0].kind).toBe("memory_item");
      expect(next.activeKey).toEqual({ id: "x", kind: "memory_item" });
    });
  });
});
