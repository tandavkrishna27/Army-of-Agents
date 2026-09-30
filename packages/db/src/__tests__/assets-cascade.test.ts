import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_FILE = join(__dirname, "..", "schema", "assets.ts");

describe("assets FK cascade", () => {
  const src = readFileSync(SCHEMA_FILE, "utf8");

  it("companyId FK has onDelete: cascade", () => {
    expect(src).toMatch(
      /companyId:\s*uuid\([^)]+\)\.notNull\(\)\.references\(\(\)\s*=>\s*companies\.id,\s*\{\s*onDelete:\s*"cascade"\s*\}\)/,
    );
  });

  it("createdByAgentId FK has onDelete: set null", () => {
    expect(src).toMatch(
      /createdByAgentId:\s*uuid\([^)]+\)\.references\(\(\)\s*=>\s*agents\.id,\s*\{\s*onDelete:\s*"set null"\s*\}\)/,
    );
  });
});
