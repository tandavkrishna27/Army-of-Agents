import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_DIR = join(__dirname, "..", "schema");

/**
 * Comprehensive FK-cascade sweep enforcement.
 *
 * Every schema file that references companies.id must declare an explicit
 * onDelete policy. This test fails on any new table that adds
 * `references(() => companies.id)` without an onDelete clause —
 * preventing the same bug class as 53a2c2f, f21bbbe, and the wider sweep
 * in this commit (0066) from re-entering the codebase.
 */
describe("FK cascade enforcement: companies.id references", () => {
  const schemaFiles = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".ts"));

  for (const file of schemaFiles) {
    const src = readFileSync(join(SCHEMA_DIR, file), "utf8");
    if (!src.includes("references(() => companies.id")) continue;

    it(`${file} declares explicit onDelete for every companies.id FK`, () => {
      // Match: references(() => companies.id, { onDelete: "cascade" }) or "set null"
      // The regex permits cascade|set null|restrict|no action. Currently no schema
      // uses restrict or no action -- they're allowed as forward-compat hatches in
      // case a future relationship genuinely wants RESTRICT (i.e., explicitly
      // wants the DELETE to fail rather than cascade or null out). The point of
      // this test is to enforce that every companies.id FK declares an explicit
      // policy, not to mandate cascade specifically. Tighten this regex if/when
      // the team decides RESTRICT semantics need a separate opt-out mechanism.
      const goodRefs =
        src.match(
          /references\(\(\)\s*=>\s*companies\.id,\s*\{\s*onDelete:\s*"(?:cascade|set null|restrict|no action)"\s*\}\)/g,
        ) || [];
      const allRefs = src.match(/references\(\(\)\s*=>\s*companies\.id[^)]*\)/g) || [];

      expect(allRefs.length).toBeGreaterThan(0);
      expect(goodRefs.length).toBe(allRefs.length);
    });
  }
});
