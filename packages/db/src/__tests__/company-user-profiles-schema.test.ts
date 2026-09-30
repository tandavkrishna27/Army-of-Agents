import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_FILE = join(__dirname, "..", "schema", "company_user_profiles.ts");
const SCHEMA_INDEX_FILE = join(__dirname, "..", "schema", "index.ts");

describe("company_user_profiles schema", () => {
  const src = readFileSync(SCHEMA_FILE, "utf8");
  const indexSrc = readFileSync(SCHEMA_INDEX_FILE, "utf8");

  it("defines the company-scoped human profile columns", () => {
    expect(src).toMatch(/pgTable\(\s*"company_user_profiles"/);
    expect(src).toMatch(/id:\s*uuid\("id"\)\.primaryKey\(\)\.defaultRandom\(\)/);
    expect(src).toMatch(/userId:\s*text\("user_id"\)\.notNull\(\)/);
    expect(src).toMatch(/displayName:\s*text\("display_name"\)/);
    expect(src).toMatch(/title:\s*text\("title"\)/);
    expect(src).toMatch(/bio:\s*text\("bio"\)/);
    expect(src).toMatch(/location:\s*text\("location"\)/);
    expect(src).toMatch(/timezone:\s*text\("timezone"\)/);
    expect(src).toMatch(/socialLinks:\s*jsonb\("social_links"\)/);
    expect(src).toMatch(/avatarAssetId:\s*uuid\("avatar_asset_id"\)/);
    expect(src).toMatch(/updatedByUserId:\s*text\("updated_by_user_id"\)/);
    expect(src).toMatch(/createdAt:\s*timestamp\("created_at",\s*\{\s*withTimezone:\s*true\s*\}\)\.notNull\(\)\.defaultNow\(\)/);
    expect(src).toMatch(/updatedAt:\s*timestamp\("updated_at",\s*\{\s*withTimezone:\s*true\s*\}\)\.notNull\(\)\.defaultNow\(\)/);
  });

  it("cascades when the company is deleted and clears avatar references when assets are deleted", () => {
    expect(src).toMatch(
      /companyId:\s*uuid\("company_id"\)\.notNull\(\)\.references\(\(\)\s*=>\s*companies\.id,\s*\{\s*onDelete:\s*"cascade"\s*\}\)/,
    );
    expect(src).toMatch(
      /avatarAssetId:\s*uuid\("avatar_asset_id"\)\.references\(\(\)\s*=>\s*assets\.id,\s*\{\s*onDelete:\s*"set null"\s*\}\)/,
    );
  });

  it("enforces one profile per company user", () => {
    expect(src).toMatch(
      /uniqueIndex\("company_user_profiles_company_user_uq"\)\.on\(table\.companyId,\s*table\.userId\)/,
    );
  });

  it("is exported from the schema barrel", () => {
    expect(indexSrc).toContain('export * from "./company_user_profiles.js";');
  });
});
