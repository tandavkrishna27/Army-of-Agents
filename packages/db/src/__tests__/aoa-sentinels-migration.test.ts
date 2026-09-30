/**
 * Phase 5b — shallow migration test for 0060_aoa_sentinels.sql
 *
 * Real-DB testing (embedded-postgres) is not feasible in this
 * environment: embedded-postgres is a server dependency, not a db
 * package dependency, and wiring it up here would require significant
 * infrastructure work outside the scope of this task.
 *
 * This test instead verifies the static guarantees that matter most:
 *   1. The migration SQL file exists at the expected path.
 *   2. It contains the correct idempotent UPDATE statements for both
 *      tables (project_workspaces and agent_wakeup_requests).
 *   3. The migration is registered in _journal.json with the correct
 *      tag, idx, and version fields.
 *
 * For end-to-end confirmation run `pnpm db:migrate` against a DB that
 * has legacy rows; see the PR description for manual verification steps.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const MIGRATION_FILE = join(MIGRATIONS_DIR, "0060_aoa_sentinels.sql");
const JOURNAL_FILE = join(MIGRATIONS_DIR, "meta", "_journal.json");

const sql = readFileSync(MIGRATION_FILE, "utf8");
const journal = JSON.parse(readFileSync(JOURNAL_FILE, "utf8")) as {
  version: string;
  dialect: string;
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
};

const journalEntry = journal.entries.find((e) => e.tag === "0060_aoa_sentinels");

describe("0060_aoa_sentinels migration", () => {
  it("migration SQL file exists and is non-empty", () => {
    expect(sql.length).toBeGreaterThan(0);
  });

  describe("SQL correctness — project_workspaces", () => {
    it("UPDATEs project_workspaces table", () => {
      expect(sql).toMatch(/UPDATE\s+project_workspaces/i);
    });

    it("sets cwd to the AoA sentinel", () => {
      expect(sql).toContain("'/__aoa_repo_only__'");
    });

    it("WHERE clause gates on legacy sentinel (idempotency)", () => {
      expect(sql).toContain("'/__paperclip_repo_only__'");
    });
  });

  describe("SQL correctness — agent_wakeup_requests", () => {
    it("UPDATEs agent_wakeup_requests table (at least twice)", () => {
      const matches = sql.match(/UPDATE\s+agent_wakeup_requests/gi);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(2);
    });

    it("rename UPDATE removes legacy key via jsonb subtraction on payload", () => {
      expect(sql).toContain("payload - '_paperclipWakeContext'");
    });

    it("rename UPDATE builds new AoA key via jsonb_build_object on payload", () => {
      expect(sql).toContain("'_aoaWakeContext'");
      expect(sql).toContain("jsonb_build_object");
    });

    it("rename UPDATE WHERE clause gates on legacy key (idempotency)", () => {
      expect(sql).toContain("payload ? '_paperclipWakeContext'");
    });

    it("rename UPDATE has AND NOT guard to preserve freshly-written AoA key", () => {
      expect(sql).toContain("AND NOT (payload ? '_aoaWakeContext')");
    });

    it("cleanup UPDATE strips legacy key from rows with BOTH keys", () => {
      // Verify the cleanup statement is present: it gates on BOTH keys simultaneously
      expect(sql).toMatch(
        /payload\s*\?\s*'_paperclipWakeContext'[\s\S]*?payload\s*\?\s*'_aoaWakeContext'/,
      );
    });

    it("never references agent_runtime_state", () => {
      expect(sql).not.toMatch(/agent_runtime_state/i);
    });
  });

  describe("_journal.json registration", () => {
    it("journal has an entry tagged 0060_aoa_sentinels", () => {
      expect(journalEntry).toBeDefined();
    });

    it("entry has idx 60", () => {
      expect(journalEntry?.idx).toBe(60);
    });

    it("entry has version '7' matching the rest of the journal", () => {
      expect(journalEntry?.version).toBe("7");
    });

    it("entry has breakpoints: true", () => {
      expect(journalEntry?.breakpoints).toBe(true);
    });

    it("entry idx is 60 (the slot 0060_aoa_sentinels was registered into)", () => {
      // Brand-check: 0060_aoa_sentinels must remain at idx 60 even as later
      // migrations (0061+) land. The original assertion was "max idx" which
      // broke on every new migration; pin to the specific value instead.
      expect(journalEntry?.idx).toBe(60);
    });
  });
});
