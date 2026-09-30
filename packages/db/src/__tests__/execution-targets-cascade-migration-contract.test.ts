// packages/db/src/__tests__/execution-targets-cascade-migration-contract.test.ts
//
// Contract guard for migration 0196: the generated SQL must be exactly the
// forward-only FK flip on execution_targets.organization_id — a single
// DROP CONSTRAINT followed by an ADD CONSTRAINT ... ON DELETE cascade — and
// nothing else. (The behavioural proof lives in
// execution-targets-org-delete-cascade.integration.test.ts; this is the cheap,
// PG-free structural check.)
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(__dirname, "..", "migrations", "0196_equal_greymalkin.sql"),
  "utf8",
);

describe("0196 execution_targets FK cascade migration", () => {
  // Statement-count: exactly two DDL statements (DROP + ADD), separated by the
  // drizzle statement-breakpoint marker.
  const statements = sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  it("is exactly two statements: DROP CONSTRAINT then ADD CONSTRAINT", () => {
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(
      /^ALTER TABLE "execution_targets" DROP CONSTRAINT "execution_targets_organization_id_organizations_id_fk";?$/,
    );
    expect(statements[1]).toMatch(
      /^ALTER TABLE "execution_targets" ADD CONSTRAINT "execution_targets_organization_id_organizations_id_fk"/,
    );
  });

  it("re-adds the org FK with ON DELETE cascade (not set null)", () => {
    expect(sql).toMatch(/ON DELETE cascade/);
    expect(sql).not.toMatch(/ON DELETE set null/);
  });

  it("touches only the execution_targets organization_id FK", () => {
    // No table create/drop, no data movement (DELETE FROM / UPDATE ... SET). Note
    // "ON DELETE cascade" legitimately contains the word DELETE, so match the
    // data-statement forms, not the bare keyword.
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DELETE FROM/i);
    expect(sql).not.toMatch(/\bUPDATE\s+"/i);
    // Every statement is an ALTER on execution_targets — nothing else is touched.
    for (const stmt of statements) {
      expect(stmt.startsWith('ALTER TABLE "execution_targets"')).toBe(true);
    }
    const alteredTables = [...sql.matchAll(/ALTER TABLE "([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(alteredTables)).toEqual(new Set(["execution_targets"]));
  });
});
