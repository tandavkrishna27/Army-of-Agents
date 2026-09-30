import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "..", "schema", "companies.ts"), "utf8");

describe("companies tenant FK + route-safe prefix uniqueness", () => {
  it("adds a non-null organization_id FK with RESTRICT on org delete + sentinel DB default", () => {
    expect(src).toMatch(
      /organizationId:\s*uuid\("organization_id"\)\.notNull\(\)\.default\("00000000-0000-0000-0000-000000000001"\)\.references\(\(\)\s*=>\s*organizations\.id,\s*\{\s*onDelete:\s*"restrict"\s*\}\)/,
    );
  });
  it("keeps issue_prefix globally unique until company-qualified routes ship", () => {
    expect(src).toMatch(
      /uniqueIndex\("companies_issue_prefix_idx"\)\.on\(table\.issuePrefix\)/,
    );
    expect(src).not.toMatch(/uniqueIndex\("companies_org_issue_prefix_idx"\)/);
  });
});
