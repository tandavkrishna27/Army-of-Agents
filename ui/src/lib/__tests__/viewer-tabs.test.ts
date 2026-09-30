import { describe, expect, it } from "vitest";
import { closeTab, ensureTab, type ViewerTabBase } from "../viewer-tabs";

interface TestTab extends ViewerTabBase {
  label: string;
}

function tab(key: string, closeable = true, label = key): TestTab {
  return { key, closeable, label };
}

describe("viewer-tabs", () => {
  describe("ensureTab", () => {
    it("appends a tab when its key is not present", () => {
      const tabs = [tab("home", false)];
      const next = ensureTab(tabs, tab("a"));
      expect(next).toHaveLength(2);
      expect(next[1].key).toBe("a");
    });

    it("dedupes by key and returns the same array reference on re-add", () => {
      const tabs = [tab("home", false), tab("a")];
      const next = ensureTab(tabs, tab("a"));
      expect(next).toHaveLength(2);
      expect(next).toBe(tabs);
    });

    it("does not mutate the input array", () => {
      const tabs = [tab("home", false)];
      ensureTab(tabs, tab("a"));
      expect(tabs).toHaveLength(1);
    });
  });

  describe("closeTab", () => {
    it("removes a closeable tab by key", () => {
      const tabs = [tab("home", false), tab("a")];
      expect(closeTab(tabs, "a")).toEqual([tab("home", false)]);
    });

    it("refuses to remove a non-closeable tab", () => {
      const tabs = [tab("home", false), tab("a")];
      expect(closeTab(tabs, "home")).toEqual(tabs);
    });

    it("leaves the array unchanged when the key is absent", () => {
      const tabs = [tab("home", false), tab("a")];
      expect(closeTab(tabs, "missing")).toEqual(tabs);
    });
  });
});
