/**
 * Verifies every CREATE TABLE / CREATE INDEX / CREATE UNIQUE INDEX
 * in packages/db/src/migrations/*.sql uses IF NOT EXISTS, except for a
 * frozen allowlist of pre-C14 migrations that ship with the bug class
 * but cannot be rewritten without churn (and have apparently survived in
 * production without ever hitting the partial-apply scenario).
 *
 * Closes finding C14 from the 2026-05-05 codebase review.
 *
 * PR #121 originally fixed migration 0080 after the same bug class
 * permanently wedged a real database. The migration runner's
 * `applyPendingMigrationsManually` fallback (packages/db/src/client.ts:222)
 * re-runs every statement in a single transaction, so an unguarded
 * CREATE on an already-applied object throws 42P07/42P11 and rolls back
 * the whole migration permanently. C14's sweep added IF NOT EXISTS to the
 * 7 migrations between 0067 and 0081 that had violations; this test
 * locks that fix in and gates every NEW migration on it.
 *
 * To add a new migration: drizzle-kit emits CREATE statements without
 * IF NOT EXISTS by default. Edit the generated SQL file before commit
 * to add IF NOT EXISTS — see PR #121 (commit e503495) and 0080 for
 * the canonical example.
 *
 * Do NOT add new entries to GRANDFATHERED_MIGRATIONS. The list is closed
 * at C14 and only shrinks (when an old migration gets retroactively
 * fixed) — never grows.
 *
 * NOTE on grep parity: this test mirrors the audit grep
 *   `grep -EHn '^CREATE (UNIQUE )?(TABLE|INDEX)\s+"' migrations/*.sql`
 * (the same pattern used by C14's audit and PR #121's review). Drizzle-kit
 * always emits CREATE statements at column 0; if a future hand-written
 * migration ever indents a CREATE inside a `DO $$ ... END $$` block this
 * test will not catch it. That trade-off is intentional — the false-positive
 * cost of matching every CREATE anywhere outweighs the catch rate, and the
 * audit grep used to triage C14 has the same shape.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

/**
 * Migrations that pre-date C14 and ship with CREATE statements that lack
 * IF NOT EXISTS. Frozen at the C14 sweep — additions are NOT allowed; the
 * list only shrinks.
 *
 * Why these are tolerated: the bug requires (a) a partially-applied
 * migration AND (b) a CREATE on an object that already exists. For the
 * pre-2026 migrations that have been live in production for a long time,
 * neither condition has plausibly ever been hit (otherwise they'd have
 * shipped a PR-#121-style hotfix). C14 fixes the recent batch because
 * those are the ones likely to interleave with mid-migration rollouts.
 */
const GRANDFATHERED_MIGRATIONS = new Set<string>([
  "0000_mature_masked_marvel.sql",
  "0001_fast_northstar.sql",
  "0003_shallow_quentin_quire.sql",
  "0004_issue_identifiers.sql",
  "0005_chief_luke_cage.sql",
  "0006_overjoyed_mister_sinister.sql",
  "0007_new_quentin_quire.sql",
  "0009_fast_jackal.sql",
  "0010_stale_justin_hammer.sql",
  "0011_windy_corsair.sql",
  "0014_many_mikhail_rasputin.sql",
  "0017_tiresome_gabe_jones.sql",
  "0018_flat_sleepwalker.sql",
  "0019_public_victor_mancha.sql",
  "0024_far_beast.sql",
  "0025_nasty_salo.sql",
  "0028_lean_silverclaw.sql",
  "0030_wonderful_zaladane.sql",
  "0031_bored_hemingway.sql",
  "0032_burly_tusk.sql",
  "0033_motionless_gargoyle.sql",
  "0034_wet_sebastian_shaw.sql",
  "0039_cute_lizard.sql",
  "0040_lethal_ma_gnuci.sql",
  "0042_curly_siren.sql",
  "0043_milky_famine.sql",
  "0044_daffy_victor_mancha.sql",
  "0045_lovely_firestar.sql",
  "0047_huge_paibok.sql",
  "0048_yellow_drax.sql",
  "0049_clammy_meltdown.sql",
  "0050_elite_spencer_smythe.sql",
  "0052_flawless_moonstone.sql",
  "0054_striped_lucky_pierre.sql",
  "0055_certain_iron_patriot.sql",
  "0057_puzzling_jubilee.sql",
  "0058_broken_major_mapleleaf.sql",
]);

interface Violation {
  file: string;
  line: number;
  text: string;
}

function findViolations(): Violation[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const violations: Violation[] = [];
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const lines = sql.split("\n");
    lines.forEach((line, idx) => {
      // Match leading CREATE keyword segment (with optional indent for
      // future-proofing, though drizzle-kit emits at column 0).
      const m = /^\s*CREATE (UNIQUE )?(TABLE|INDEX)\s+"/.exec(line);
      if (m && !line.includes("IF NOT EXISTS")) {
        violations.push({ file, line: idx + 1, text: line.trim() });
      }
    });
  }
  return violations;
}

describe("migration idempotency", () => {
  it("every non-grandfathered migration's CREATE TABLE/INDEX uses IF NOT EXISTS", () => {
    const violations = findViolations();
    const newViolations = violations.filter(
      (v) => !GRANDFATHERED_MIGRATIONS.has(v.file),
    );

    if (newViolations.length > 0) {
      throw new Error(
        `Found ${newViolations.length} CREATE TABLE/INDEX without IF NOT EXISTS ` +
          `outside the C14 grandfather list:\n` +
          newViolations
            .map((v) => `  ${v.file}:${v.line} - ${v.text}`)
            .join("\n") +
          `\n\nAdd IF NOT EXISTS to make these idempotent. See PR #121 (commit e503495) ` +
          `and migration 0080 for the canonical example. Do NOT add the file to ` +
          `GRANDFATHERED_MIGRATIONS — that list is frozen at C14.`,
      );
    }
  });

  it("migration 0137 guards the conversation foreign key for replay", () => {
    const sql = readFileSync(
      join(MIGRATIONS_DIR, "0137_worthless_baron_strucker.sql"),
      "utf8",
    );
    expect(sql).toMatch(/DO\s+\$\$\s+BEGIN\s+ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_conversation_id_internal_agent_conversations_id_fk"/i);
    expect(sql).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL;\s+END\s+\$\$/i);
  });

  it("migration 0202 guards all broker foreign keys for partial replay", () => {
    // The three broker migrations (originally 0188/0189/0190) were collapsed into
    // one migration when re-numbering onto main's tail during the #316 merge; it
    // guards all four broker FKs (oauth_flows x2, refresh_leases x2).
    const sql = readFileSync(
      join(MIGRATIONS_DIR, "0202_lethal_vance_astro.sql"),
      "utf8",
    );
    expect(sql).toMatch(/DO\s+\$\$\s+BEGIN\s+ALTER TABLE "mcp_connector_oauth_flows" ADD CONSTRAINT "mcp_connector_oauth_flows_company_id_companies_id_fk"/i);
    expect(sql).toMatch(/DO\s+\$\$\s+BEGIN\s+ALTER TABLE "mcp_connector_oauth_flows" ADD CONSTRAINT "mcp_connector_oauth_flows_connector_id_company_mcp_connectors_id_fk"/i);
    expect(sql).toMatch(/DO\s+\$\$\s+BEGIN\s+ALTER TABLE "mcp_connector_oauth_refresh_leases" ADD CONSTRAINT "mcp_connector_oauth_refresh_leases_secret_id_company_secrets_id_fk"/i);
    expect(sql).toMatch(/DO\s+\$\$\s+BEGIN\s+ALTER TABLE "mcp_connector_oauth_refresh_leases" ADD CONSTRAINT "mcp_connector_oauth_refresh_leases_company_id_companies_id_fk"/i);
    expect(sql.match(/EXCEPTION WHEN duplicate_object THEN NULL;\s+END\s+\$\$/gi)).toHaveLength(4);
  });

  it("grandfather list does not retroactively grow", () => {
    // If a grandfathered migration ever gets an IF NOT EXISTS sweep, it
    // should be REMOVED from the list (not stay there silently). This
    // assertion catches that drift.
    const violations = findViolations();
    const violatingFiles = new Set(violations.map((v) => v.file));
    const stale = [...GRANDFATHERED_MIGRATIONS].filter(
      (f) => !violatingFiles.has(f),
    );
    expect(
      stale,
      `Grandfathered migrations no longer have violations and should be removed ` +
        `from GRANDFATHERED_MIGRATIONS: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("grandfather list only contains files that actually exist", () => {
    const files = new Set(
      readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")),
    );
    const missing = [...GRANDFATHERED_MIGRATIONS].filter((f) => !files.has(f));
    expect(
      missing,
      `Grandfathered migrations no longer exist on disk: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
