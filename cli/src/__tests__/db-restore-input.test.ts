import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRestoreBackupFile } from "../commands/db-restore-input.js";

describe("resolveRestoreBackupFile", () => {
  it("throws when no --file is provided (a destructive restore must not target an unintended path)", () => {
    expect(() => resolveRestoreBackupFile(undefined)).toThrow(/backup file is required/i);
    expect(() => resolveRestoreBackupFile("   ")).toThrow(/backup file is required/i);
  });

  it("resolves a relative --file to an absolute path", () => {
    expect(path.isAbsolute(resolveRestoreBackupFile("backup.dump"))).toBe(true);
  });

  it("expands a ~ home prefix to the user's home directory", () => {
    expect(resolveRestoreBackupFile("~/backups/db.dump")).toBe(
      path.resolve(os.homedir(), "backups/db.dump"),
    );
  });
});
