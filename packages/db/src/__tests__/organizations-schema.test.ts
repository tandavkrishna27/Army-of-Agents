import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = join(__dirname, "..", "schema", "organizations.ts");
const INDEX_FILE = join(__dirname, "..", "schema", "index.ts");

describe("organizations schema", () => {
  const src = readFileSync(SCHEMA_FILE, "utf8");
  const indexSrc = readFileSync(INDEX_FILE, "utf8");

  it("defines the organizations tenant table", () => {
    expect(src).toMatch(/pgTable\(\s*"organizations"/);
    expect(src).toMatch(/id:\s*uuid\("id"\)\.primaryKey\(\)\.defaultRandom\(\)/);
    expect(src).toMatch(/name:\s*text\("name"\)\.notNull\(\)/);
    expect(src).toMatch(/slug:\s*text\("slug"\)\.notNull\(\)/);
    expect(src).toMatch(/status:\s*text\("status"\)\.notNull\(\)\.default\("active"\)/);
    expect(src).toMatch(/plan:\s*text\("plan"\)\.notNull\(\)\.default\("beta"\)/);
    expect(src).toMatch(/concurrencyCap:\s*integer\("concurrency_cap"\)/);
    expect(src).toMatch(/createdByUserId:\s*text\("created_by_user_id"\)/);
  });

  it("makes slug GLOBALLY unique (the tenant routing handle)", () => {
    expect(src).toMatch(/uniqueIndex\("organizations_slug_uq"\)\.on\(table\.slug\)/);
  });

  it("constrains status with a check", () => {
    expect(src).toMatch(
      /check\(\s*"organizations_status_check",\s*sql`status IN \('active', 'suspended', 'archived'\)`/,
    );
  });

  it("clears created_by on user delete", () => {
    expect(src).toMatch(/createdByUserId[\s\S]*references\(\(\)\s*=>\s*authUsers\.id,\s*\{\s*onDelete:\s*"set null"\s*\}\)/);
  });

  it("is exported from the schema barrel", () => {
    expect(indexSrc).toContain('export { organizations } from "./organizations.js";');
  });
});
