import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Contract test — asserts the SQL file exists with the expected backfill clauses.
// Does NOT execute the SQL. Real execution is tested via the integration migrate.ts runner during CI.

describe("memory-folder-path backfill migration", () => {
  const migrationsDir = path.resolve(
    __dirname,
    "../../../packages/db/src/migrations",
  );

  function findBackfillFile(): string | undefined {
    const files = fs.readdirSync(migrationsDir);
    return files.find((f) =>
      f.includes("memory_folder_path_backfill") && f.endsWith(".sql"),
    );
  }

  it("file exists with the expected name pattern", () => {
    expect(findBackfillFile()).toBeDefined();
  });

  it("contains the category -> folder mapping", () => {
    const target = findBackfillFile();
    const sql = fs.readFileSync(path.join(migrationsDir, target!), "utf8");
    expect(sql).toContain("'decision'");
    expect(sql).toContain("'Decisions'");
    expect(sql).toContain("'procedure'");
    expect(sql).toContain("'Playbooks'");
    expect(sql).toContain("'policy'");
    expect(sql).toContain("'Policies'");
  });

  it("handles identity layer with null department_id", () => {
    const target = findBackfillFile();
    const sql = fs.readFileSync(path.join(migrationsDir, target!), "utf8");
    expect(sql).toContain("'identity'");
    expect(sql).toContain("'Company'");
  });

  it("handles working layer", () => {
    const target = findBackfillFile();
    const sql = fs.readFileSync(path.join(migrationsDir, target!), "utf8");
    expect(sql).toContain("'working'");
    expect(sql).toContain("'/Working'");
  });
});
