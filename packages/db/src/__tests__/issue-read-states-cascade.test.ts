import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_FILE = join(__dirname, "..", "schema", "issue_read_states.ts");

describe("issue_read_states FK cascade", () => {
  const src = readFileSync(SCHEMA_FILE, "utf8");

  it("companyId FK has onDelete: cascade", () => {
    expect(src).toMatch(
      /companyId:\s*uuid\([^)]+\)\.notNull\(\)\.references\(\(\)\s*=>\s*companies\.id,\s*\{\s*onDelete:\s*"cascade"\s*\}\)/,
    );
  });

  it("issueId FK has onDelete: cascade", () => {
    expect(src).toMatch(
      /issueId:\s*uuid\([^)]+\)\.notNull\(\)\.references\(\(\)\s*=>\s*issues\.id,\s*\{\s*onDelete:\s*"cascade"\s*\}\)/,
    );
  });
});
