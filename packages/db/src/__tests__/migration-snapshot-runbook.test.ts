import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe.each([
  "docs/deploy/database.md",
  "docs/deploy/upgrade-guide.md",
])("migration snapshot runbook in %s", (relativePath) => {
  const source = readFileSync(resolve(repoRoot, relativePath), "utf8");

  it("upserts the lazy canonical row and verifies its marker", () => {
    expect(source).toMatch(
      /INSERT INTO instance_settings \(singleton_key, general\)[\s\S]*ON CONFLICT \(singleton_key\) DO UPDATE[\s\S]*SELECT general->'migrationSnapshots'[\s\S]*WHERE singleton_key = 'default'/,
    );
    expect(source).toContain("jsonb_array_elements(");
    expect(source).toContain("WHERE jsonb_typeof(candidate.marker) = 'string'");
  });
});
