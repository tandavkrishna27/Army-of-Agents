import { describe, it, expect, beforeEach } from "vitest";
import { migrateStorageKey, migrateStorageKeyPrefix } from "../lib/storage-migration";

describe("migrateStorageKey", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("copies value from old key to new key on first run", () => {
    localStorage.setItem("paperclip:foo", "hello");
    migrateStorageKey("paperclip:foo", "aoa:foo");
    expect(localStorage.getItem("aoa:foo")).toBe("hello");
    expect(localStorage.getItem("paperclip:foo")).toBeNull();
  });

  it("is idempotent — second call after a fresh write does not clobber", () => {
    localStorage.setItem("paperclip:foo", "hello");
    migrateStorageKey("paperclip:foo", "aoa:foo");
    localStorage.setItem("aoa:foo", "world");
    migrateStorageKey("paperclip:foo", "aoa:foo");
    expect(localStorage.getItem("aoa:foo")).toBe("world");
  });

  it("does nothing if old key is absent", () => {
    migrateStorageKey("paperclip:foo", "aoa:foo");
    expect(localStorage.getItem("aoa:foo")).toBeNull();
  });

  it("does not overwrite an existing new-key value but cleans up old", () => {
    localStorage.setItem("paperclip:foo", "old");
    localStorage.setItem("aoa:foo", "new");
    migrateStorageKey("paperclip:foo", "aoa:foo");
    expect(localStorage.getItem("aoa:foo")).toBe("new");
    expect(localStorage.getItem("paperclip:foo")).toBeNull();
  });
});

describe("migrateStorageKeyPrefix", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renames every key matching the prefix", () => {
    localStorage.setItem("paperclip.projectOrder:co1:u1", JSON.stringify(["a", "b"]));
    localStorage.setItem("paperclip.projectOrder:co2:u1", JSON.stringify(["c"]));
    localStorage.setItem("unrelated", "x");
    migrateStorageKeyPrefix("paperclip.projectOrder:", "aoa.projectOrder:");
    expect(localStorage.getItem("aoa.projectOrder:co1:u1")).toBe(JSON.stringify(["a", "b"]));
    expect(localStorage.getItem("aoa.projectOrder:co2:u1")).toBe(JSON.stringify(["c"]));
    expect(localStorage.getItem("paperclip.projectOrder:co1:u1")).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("x");
  });
});
