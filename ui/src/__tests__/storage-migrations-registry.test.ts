import { describe, it, expect, beforeEach } from "vitest";
import { runStorageMigrations } from "../lib/storage-migrations";

const SINGLE_KEY_PAIRS: Array<[string, string, string]> = [
  // [oldKey, newKey, sampleValue]
  ["paperclip:inbox:dismissed", "aoa:inbox:dismissed", JSON.stringify(["a", "b"])],
  ["paperclip:inbox:dismissed:migrated", "aoa:inbox:dismissed:migrated", "1"],
  ["paperclip.theme", "aoa.theme", "dark"],
  ["paperclip:sidebar-collapsed", "aoa:sidebar-collapsed", "true"],
  ["paperclip.selectedCompanyId", "aoa.selectedCompanyId", "co-1"],
  ["paperclip.companyPaths", "aoa.companyPaths", JSON.stringify({ co1: "/x" })],
  ["paperclip:agent-panel-open", "aoa:agent-panel-open", "true"],
  ["paperclip:recent-assignees", "aoa:recent-assignees", JSON.stringify(["a-1"])],
  ["paperclip:issues-view", "aoa:issues-view", "board"],
  ["paperclip:issue-draft", "aoa:issue-draft", JSON.stringify({ title: "x" })],
];

const PREFIX_GROUPS: Array<[string, string, Array<[string, string]>]> = [
  ["paperclip.projectOrder:", "aoa.projectOrder:", [
    ["co1:u1", JSON.stringify(["p1", "p2"])],
    ["co2:u1", JSON.stringify(["p3"])],
  ]],
  ["paperclip:project-view:", "aoa:project-view:", [
    ["proj-1", "board"],
    ["proj-2", "list"],
  ]],
  ["paperclip:issue-comment-draft:", "aoa:issue-comment-draft:", [
    ["TES-1", "draft body 1"],
    ["TES-2", "draft body 2"],
  ]],
];

describe("runStorageMigrations — full registry sweep", () => {
  beforeEach(() => localStorage.clear());

  it("migrates every single key without losing values", () => {
    for (const [oldKey, , value] of SINGLE_KEY_PAIRS) {
      localStorage.setItem(oldKey, value);
    }
    runStorageMigrations();
    for (const [oldKey, newKey, value] of SINGLE_KEY_PAIRS) {
      expect(localStorage.getItem(newKey)).toBe(value);
      expect(localStorage.getItem(oldKey)).toBeNull();
    }
  });

  it("migrates every prefix group without losing values", () => {
    for (const [oldPrefix, , entries] of PREFIX_GROUPS) {
      for (const [suffix, value] of entries) {
        localStorage.setItem(oldPrefix + suffix, value);
      }
    }
    runStorageMigrations();
    for (const [oldPrefix, newPrefix, entries] of PREFIX_GROUPS) {
      for (const [suffix, value] of entries) {
        expect(localStorage.getItem(newPrefix + suffix)).toBe(value);
        expect(localStorage.getItem(oldPrefix + suffix)).toBeNull();
      }
    }
  });

  it("is idempotent — running twice produces the same end state", () => {
    for (const [oldKey, , value] of SINGLE_KEY_PAIRS) {
      localStorage.setItem(oldKey, value);
    }
    runStorageMigrations();
    runStorageMigrations(); // second run
    for (const [oldKey, newKey, value] of SINGLE_KEY_PAIRS) {
      expect(localStorage.getItem(newKey)).toBe(value);
      expect(localStorage.getItem(oldKey)).toBeNull();
    }
  });

  it("does not overwrite a fresher value already stored under the AoA key", () => {
    localStorage.setItem("paperclip.theme", "dark");
    localStorage.setItem("aoa.theme", "light"); // user has already used the new build
    runStorageMigrations();
    expect(localStorage.getItem("aoa.theme")).toBe("light");
    expect(localStorage.getItem("paperclip.theme")).toBeNull(); // still cleaned up
  });

  it("removes already-deprecated keys without migrating them", () => {
    localStorage.setItem("paperclip.companyOrder", "should-be-deleted");
    localStorage.setItem("paperclip:panel-visible", "true");
    runStorageMigrations();
    expect(localStorage.getItem("paperclip.companyOrder")).toBeNull();
    expect(localStorage.getItem("paperclip:panel-visible")).toBeNull();
    // No corresponding aoa.* keys created either.
    expect(localStorage.getItem("aoa.companyOrder")).toBeNull();
    expect(localStorage.getItem("aoa:panel-visible")).toBeNull();
  });
});
