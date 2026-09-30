import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// Contract test for Task 0.2 — Inbound Dirty-Data Routing schema changes.
//
// Asserts:
//  1. internal_agent_config gains `inbound_routing_level` (text NOT NULL default 'off')
//  2. thread_inbox_items gains 5 lifecycle columns
//  3. A durable (non-partial) unique index on (company_id, dedup_key) exists —
//     across ALL statuses so that a retry after attach cannot double-insert
//     (Codex #8). The index must use IF NOT EXISTS per the C14 idempotency rule.
//
// Migration files are discovered dynamically so the test does not need updating
// when db:generate produces a different numeric tag.

const MIGRATIONS_DIR = resolve(
  __dirname,
  "../../../packages/db/src/migrations",
);

const DEDUP_INDEX_NAME = "thread_inbox_items_company_dedup_idx";

/**
 * Find the migration file that contains a given SQL snippet.
 * Searches all *.sql files in ascending order.
 * Returns { file, sql } of the first match, or null if not found.
 */
function findMigrationContaining(
  snippet: string,
): { file: string; sql: string } | null {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
    if (sql.includes(snippet)) {
      return { file, sql };
    }
  }
  return null;
}

// ── internal_agent_config.inbound_routing_level ──────────────────────────────

describe("Migration — internal_agent_config.inbound_routing_level", () => {
  it("a migration adds the inbound_routing_level column to internal_agent_config", () => {
    const result = findMigrationContaining("inbound_routing_level");
    expect(
      result,
      'No migration file contains "inbound_routing_level". ' +
        "Run pnpm db:generate to produce the migration.",
    ).not.toBeNull();
  });

  it("the column is added to internal_agent_config (not another table)", () => {
    const result = findMigrationContaining("inbound_routing_level");
    if (!result) throw new Error("Migration for inbound_routing_level not found.");
    // The ALTER TABLE statement should target internal_agent_config
    expect(result.sql).toMatch(
      /ALTER TABLE "internal_agent_config" ADD COLUMN(?: IF NOT EXISTS)? "inbound_routing_level"/i,
    );
  });

  it("the column is text NOT NULL with default 'off'", () => {
    const result = findMigrationContaining("inbound_routing_level");
    if (!result) throw new Error("Migration for inbound_routing_level not found.");
    // Drizzle emits DEFAULT before NOT NULL: "text DEFAULT 'off' NOT NULL"
    expect(result.sql).toMatch(
      /ADD COLUMN(?: IF NOT EXISTS)? "inbound_routing_level" text[^;]*DEFAULT 'off'[^;]*NOT NULL/i,
    );
  });
});

// ── thread_inbox_items new columns ───────────────────────────────────────────

describe("Migration — thread_inbox_items routing lifecycle columns", () => {
  it("a migration adds dedup_key to thread_inbox_items", () => {
    // Search for the exact ALTER TABLE statement — not just the column name
    // (an earlier migration mentions dedup_key on agent_wakeup_requests).
    const result = findMigrationContaining(
      'ALTER TABLE "thread_inbox_items" ADD COLUMN IF NOT EXISTS "dedup_key"',
    );
    expect(
      result,
      'No migration file contains ALTER TABLE "thread_inbox_items" ADD COLUMN "dedup_key". ' +
        "Run pnpm db:generate.",
    ).not.toBeNull();
    if (result) {
      expect(result.sql).toMatch(
        /ALTER TABLE "thread_inbox_items" ADD COLUMN(?: IF NOT EXISTS)? "dedup_key" text/i,
      );
    }
  });

  it("a migration adds routing_status (NOT NULL default pending_route) to thread_inbox_items", () => {
    // Search for the exact ALTER TABLE statement for thread_inbox_items.routing_status.
    const result = findMigrationContaining(
      'ALTER TABLE "thread_inbox_items" ADD COLUMN IF NOT EXISTS "routing_status"',
    );
    expect(
      result,
      'No migration file contains ALTER TABLE "thread_inbox_items" ADD COLUMN "routing_status". ' +
        "Run pnpm db:generate.",
    ).not.toBeNull();
    if (result) {
      // Drizzle emits DEFAULT before NOT NULL: "text DEFAULT 'pending_route' NOT NULL"
      expect(result.sql).toMatch(
        /ALTER TABLE "thread_inbox_items" ADD COLUMN(?: IF NOT EXISTS)? "routing_status" text[^;]*DEFAULT 'pending_route'[^;]*NOT NULL/i,
      );
    }
  });

  it("a migration adds routing_error_code to thread_inbox_items", () => {
    const result = findMigrationContaining("routing_error_code");
    expect(
      result,
      'No migration file contains "routing_error_code". Run pnpm db:generate.',
    ).not.toBeNull();
    if (result) {
      expect(result.sql).toMatch(
        /ALTER TABLE "thread_inbox_items" ADD COLUMN(?: IF NOT EXISTS)? "routing_error_code" text/i,
      );
    }
  });

  it("a migration adds routed_at (timestamp with time zone) to thread_inbox_items", () => {
    const result = findMigrationContaining("routed_at");
    expect(
      result,
      'No migration file contains "routed_at". Run pnpm db:generate.',
    ).not.toBeNull();
    if (result) {
      expect(result.sql).toMatch(
        /ALTER TABLE "thread_inbox_items" ADD COLUMN(?: IF NOT EXISTS)? "routed_at" timestamp with time zone/i,
      );
    }
  });

  it("a migration adds navigator_wakeup_id to thread_inbox_items", () => {
    const result = findMigrationContaining("navigator_wakeup_id");
    expect(
      result,
      'No migration file contains "navigator_wakeup_id". Run pnpm db:generate.',
    ).not.toBeNull();
    if (result) {
      expect(result.sql).toMatch(
        /ALTER TABLE "thread_inbox_items" ADD COLUMN(?: IF NOT EXISTS)? "navigator_wakeup_id" uuid/i,
      );
    }
  });
});

// ── Durable unique index on (company_id, dedup_key) ─────────────────────────

describe(`Migration — durable unique index "${DEDUP_INDEX_NAME}"`, () => {
  it(`a migration file containing "${DEDUP_INDEX_NAME}" exists`, () => {
    const result = findMigrationContaining(DEDUP_INDEX_NAME);
    expect(
      result,
      `No migration file contains "${DEDUP_INDEX_NAME}". ` +
        "Run pnpm db:generate and verify the index was generated.",
    ).not.toBeNull();
  });

  it("uses CREATE UNIQUE INDEX IF NOT EXISTS (C14 idempotency rule)", () => {
    const result = findMigrationContaining(DEDUP_INDEX_NAME);
    if (!result) throw new Error(`Migration for ${DEDUP_INDEX_NAME} not found.`);
    expect(result.sql).toMatch(
      new RegExp(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${DEDUP_INDEX_NAME}"`,
        "i",
      ),
    );
  });

  it("is on the thread_inbox_items table", () => {
    const result = findMigrationContaining(DEDUP_INDEX_NAME);
    if (!result) throw new Error(`Migration for ${DEDUP_INDEX_NAME} not found.`);
    expect(result.sql).toMatch(
      new RegExp(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${DEDUP_INDEX_NAME}" ON "thread_inbox_items"`,
        "i",
      ),
    );
  });

  it("covers (company_id, dedup_key) columns", () => {
    const result = findMigrationContaining(DEDUP_INDEX_NAME);
    if (!result) throw new Error(`Migration for ${DEDUP_INDEX_NAME} not found.`);
    expect(result.sql).toMatch(
      new RegExp(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${DEDUP_INDEX_NAME}"[^;]*\\("company_id",\\s*"dedup_key"\\)`,
        "i",
      ),
    );
  });

  it("is durable — no WHERE clause (holds across ALL statuses, not just pending)", () => {
    const result = findMigrationContaining(DEDUP_INDEX_NAME);
    if (!result) throw new Error(`Migration for ${DEDUP_INDEX_NAME} not found.`);
    // The line defining the index must not have a WHERE clause (partial index
    // would allow double-insert after status changes from pending→attached).
    const lines = result.sql.split("\n");
    const indexLine = lines.find((l) => l.includes(DEDUP_INDEX_NAME));
    expect(indexLine).toBeDefined();
    expect(indexLine!.toUpperCase()).not.toContain("WHERE");
  });
});
