import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_FILE = join(__dirname, "..", "schema", "company_user_capability_documents.ts");
const SCHEMA_INDEX_FILE = join(__dirname, "..", "schema", "index.ts");

describe("company_user_capability_documents schema", () => {
  const src = readFileSync(SCHEMA_FILE, "utf8");
  const indexSrc = readFileSync(SCHEMA_INDEX_FILE, "utf8");

  it("defines company-scoped human capability document columns", () => {
    expect(src).toMatch(/pgTable\(\s*"company_user_capability_documents"/);
    expect(src).toMatch(/id:\s*uuid\("id"\)\.primaryKey\(\)\.defaultRandom\(\)/);
    expect(src).toMatch(/companyId:\s*uuid\("company_id"\)\.notNull\(\)/);
    expect(src).toMatch(/userId:\s*text\("user_id"\)\.notNull\(\)/);
    expect(src).toMatch(/slug:\s*text\("slug"\)\.notNull\(\)/);
    expect(src).toMatch(/filename:\s*text\("filename"\)\.notNull\(\)/);
    expect(src).toMatch(/title:\s*text\("title"\)\.notNull\(\)/);
    expect(src).toMatch(/kind:\s*text\("kind"\)\.notNull\(\)/);
    expect(src).toMatch(/content:\s*text\("content"\)\.notNull\(\)\.default\(""\)/);
    expect(src).toMatch(/sortOrder:\s*integer\("sort_order"\)\.notNull\(\)\.default\(0\)/);
    expect(src).toMatch(/isStandard:\s*boolean\("is_standard"\)\.notNull\(\)\.default\(false\)/);
    expect(src).toMatch(/createdByUserId:\s*text\("created_by_user_id"\)/);
    expect(src).toMatch(/updatedByUserId:\s*text\("updated_by_user_id"\)/);
  });

  it("cascades when the company is deleted", () => {
    expect(src).toMatch(
      /companyId:\s*uuid\("company_id"\)\.notNull\(\)\.references\(\(\)\s*=>\s*companies\.id,\s*\{\s*onDelete:\s*"cascade"\s*\}\)/,
    );
  });

  it("enforces one capability document per company user slug", () => {
    expect(src).toContain('uniqueIndex("company_user_capability_documents_company_user_slug_uq").on');
    expect(src).toContain("table.companyId");
    expect(src).toContain("table.userId");
    expect(src).toContain("table.slug");
    expect(src).toContain('index("company_user_capability_documents_company_user_sort_idx").on');
    expect(src).toContain("table.sortOrder");
  });

  it("is exported from the schema barrel", () => {
    expect(indexSrc).toContain('export * from "./company_user_capability_documents.js";');
  });
});
