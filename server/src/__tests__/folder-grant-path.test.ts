import { describe, expect, it } from "vitest";
import {
  admitCapturedPaths,
  isLikelySecretPath,
  isPathWithinBase,
  type CapturedEntry,
} from "../services/folder-grant-path.js";

// DAT-006 §6 (1)-(5) — PURE path/escape admission for local-folder grants.

describe("DAT-006 folder-grant path admission (pure)", () => {
  const base = "project/src";

  it("(1) admits only paths within the declared base; out-of-base rejects", () => {
    expect(isPathWithinBase(base, "project/src/main.ts")).toBe(true);
    // A sibling that merely shares a name prefix is NOT within the base.
    expect(isPathWithinBase(base, "project/srcx/main.ts")).toBe(false);
    // Outside the base entirely.
    expect(isPathWithinBase(base, "project/other/main.ts")).toBe(false);
    // The bare base directory itself is not an admissible content path.
    expect(isPathWithinBase(base, "project/src")).toBe(false);
  });

  it("(2) rejects a symlink entry as unrepresentable", () => {
    const entries: CapturedEntry[] = [{ path: "project/src/link", kind: "symlink" }];
    const { admitted, rejected } = admitCapturedPaths(base, entries);
    expect(admitted).toEqual([]);
    expect(rejected).toEqual([{ path: "project/src/link", reason: "symlink_unrepresentable" }]);
  });

  it("(3) rejects a case-colliding sibling path", () => {
    const entries: CapturedEntry[] = [
      { path: "project/src/App.ts", kind: "file" },
      { path: "project/src/app.ts", kind: "file" },
    ];
    const { admitted, rejected } = admitCapturedPaths(base, entries);
    expect(admitted).toEqual(["project/src/App.ts"]);
    expect(rejected).toEqual([{ path: "project/src/app.ts", reason: "case_collision" }]);
  });

  it("(4) rejects special-file / `..` / absolute paths via the frozen safety predicate", () => {
    const entries: CapturedEntry[] = [
      { path: "project/src/../../etc/passwd", kind: "file" }, // `..` escape
      { path: "/etc/passwd", kind: "file" }, // absolute
      { path: "project/src/dev", kind: "block_device" }, // special file kind
    ];
    const { admitted, rejected } = admitCapturedPaths(base, entries);
    expect(admitted).toEqual([]);
    expect(rejected.map((r) => r.reason).sort()).toEqual(["special_file", "unsafe_path", "unsafe_path"].sort());
  });

  it("(5) excludes likely-secret paths even inside the declared base", () => {
    expect(isLikelySecretPath("project/src/.env")).toBe(true);
    expect(isLikelySecretPath("project/src/config/id_rsa")).toBe(true);
    expect(isLikelySecretPath("project/src/certs/server.pem")).toBe(true);
    expect(isLikelySecretPath("project/src/main.ts")).toBe(false);
    const entries: CapturedEntry[] = [
      { path: "project/src/main.ts", kind: "file" },
      { path: "project/src/.env", kind: "file" },
    ];
    const { admitted, rejected } = admitCapturedPaths(base, entries);
    expect(admitted).toEqual(["project/src/main.ts"]);
    expect(rejected).toEqual([{ path: "project/src/.env", reason: "likely_secret" }]);
  });
});
