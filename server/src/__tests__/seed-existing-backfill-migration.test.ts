import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.resolve(
  __dirname,
  "../../../packages/db/src/migrations",
);

function findMigrationFile(): string | undefined {
  const files = fs.readdirSync(MIGRATIONS_DIR);
  return files.find((f) =>
    f.startsWith("0075_") && f.includes("seed_existing") && f.endsWith(".sql"),
  );
}

describe("0075 backfill migration — seed existing companies + departments", () => {
  it("file exists with the expected name pattern", () => {
    expect(findMigrationFile()).toBeDefined();
  });

  it("seeds Company root folder for every existing company", () => {
    const target = findMigrationFile()!;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, target), "utf8");
    expect(sql).toContain("INSERT INTO memory_folders");
    expect(sql).toContain("'Company'");
    expect(sql).toContain("'company.root'");
    // Selects from companies table, not just a literal — proves it iterates existing rows.
    expect(sql).toMatch(/FROM\s+companies/);
  });

  it("seeds dept folders per functionType for every existing department", () => {
    const target = findMigrationFile()!;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, target), "utf8");
    // The migration should reference projects with type='department'.
    expect(sql).toContain("'department'");
    // It should include the seed-folder names from the seed map (at least the engineering set).
    expect(sql).toContain("'Decisions'");
    expect(sql).toContain("'Architecture'");
    expect(sql).toContain("'Files'");
    // It should include seedKeys with the function-type prefix.
    expect(sql).toContain("software_development.decisions");
    expect(sql).toContain("marketing.brand");
    expect(sql).toContain("customer_support.macros");
    expect(sql).toContain("generic.policies");
  });

  it("uses ON CONFLICT DO NOTHING for idempotency", () => {
    const target = findMigrationFile()!;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, target), "utf8");
    expect(sql.toLowerCase()).toContain("on conflict");
    expect(sql.toLowerCase()).toContain("do nothing");
  });

  it("derives department slug from urlKey or name (matches Phase 6.0 backfill convention)", () => {
    const target = findMigrationFile()!;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, target), "utf8");
    // Either urlKey is read directly, or name → slug via regexp_replace, matching 0074.
    const usesUrlKey = sql.includes("url_key");
    const usesNameRegex = sql.includes("regexp_replace") && sql.includes("[^a-z0-9]+");
    expect(usesUrlKey || usesNameRegex).toBe(true);
  });
});
