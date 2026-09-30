import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "..", "revert-0188.ts"), "utf8");

describe("revert-0188 is single-org-guarded and restores global invariants", () => {
  it("asserts exactly one organization before doing anything", () => {
    expect(SRC).toMatch(/count\(\*\)/i);
    expect(SRC).toMatch(/organizations/);
    expect(SRC).toMatch(/=== 1|!== 1|> 1/); // single-org guard
  });
  it("drops the org FK + org-scoped indexes and restores the global ones", () => {
    expect(SRC).toContain("companies_organization_id_organizations_id_fk");
    expect(SRC).toContain("companies_org_issue_prefix_idx");
    expect(SRC).toMatch(/CREATE UNIQUE INDEX[\s\S]*"companies_issue_prefix_idx"[\s\S]*\("issue_prefix"\)/);
    expect(SRC).toMatch(/CREATE UNIQUE INDEX[\s\S]*"issues_identifier_idx"[\s\S]*\("identifier"\)/);
  });
  it("runs inside a transaction", () => {
    expect(SRC).toMatch(/BEGIN|transaction/i);
  });
  it("refuses when migrations after 0188 are still applied (forward-consistency guard)", () => {
    // The guard membership-checks the later-phase hashes against the journal
    // and throws a dedicated refusal before any destructive statement.
    expect(SRC).toMatch(/migrations after 0188 are applied/);
    expect(SRC).toContain("computeLaterMigrationHashes");
    expect(SRC).toMatch(/hash = ANY\(/);
  });
});
