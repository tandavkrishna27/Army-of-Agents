import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "..", "schema", "issues.ts"), "utf8");

describe("issues identifier uniqueness is per-company", () => {
  it("scopes issues_identifier_idx to (company_id, identifier)", () => {
    expect(src).toMatch(
      /uniqueIndex\("issues_identifier_idx"\)\.on\(table\.companyId,\s*table\.identifier\)/,
    );
  });
  it("is no longer a global unique on identifier alone", () => {
    expect(src).not.toMatch(/uniqueIndex\("issues_identifier_idx"\)\.on\(table\.identifier\)/);
  });
});
