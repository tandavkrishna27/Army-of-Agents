import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "..", "schema", "companies.ts"), "utf8");

describe("companies tenant FK + route-safe prefix uniqueness", () => {
  it("adds a non-null organization_id FK with RESTRICT on org delete; the fail-open sentinel DB default was dropped (TEN-006b / E2-D07)", () => {
    // organization_id is NOT NULL + FK restrict, with NO sentinel .default(): TEN-006b
    // (migration 0210) dropped the fail-open default so an org-omitting write fails closed.
    expect(src).toMatch(
      /organizationId:\s*uuid\("organization_id"\)\.notNull\(\)\.references\(\(\)\s*=>\s*organizations\.id,\s*\{\s*onDelete:\s*"restrict"\s*\}\)/,
    );
    expect(src).not.toMatch(/\.default\("00000000-0000-0000-0000-000000000001"\)/);
  });
  it("keeps issue_prefix globally unique until company-qualified routes ship", () => {
    expect(src).toMatch(
      /uniqueIndex\("companies_issue_prefix_idx"\)\.on\(table\.issuePrefix\)/,
    );
    expect(src).not.toMatch(/uniqueIndex\("companies_org_issue_prefix_idx"\)/);
  });
});
