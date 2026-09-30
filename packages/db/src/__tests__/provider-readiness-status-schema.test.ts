/**
 * Locks the shape of the `provider_readiness_status` cache table.
 *
 * The load-bearing invariants here are:
 *
 * 1. The `outcome` column enum must stay identical to `PROBE_OUTCOMES` in
 *    `@armyofagents/shared`. The column derives from that constant today, but
 *    a future refactor could inline the six strings "for convenience" — at
 *    which point the DB and the classifier drift apart silently.
 * 2. The row is SCOPED. `scopeType` + `scopeId` exist because authentication is
 *    configuration-specific: an agent's `adapterConfig.env` binding wins over
 *    the company default, so one unscoped row per (company, provider) would let
 *    the UI render "Ready" while that agent still 401s.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROBE_OUTCOMES } from "@armyofagents/shared/probe-outcome";
import { providerReadinessStatus } from "../schema/provider_readiness_status.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

describe("provider_readiness_status schema", () => {
  it("exposes the scoped cache columns", () => {
    for (const column of [
      "id",
      "companyId",
      "providerId",
      "scopeType",
      "scopeId",
      "outcome",
      "checks",
      "testedAt",
      "testedByUserId",
    ]) {
      expect(providerReadinessStatus, column).toHaveProperty(column);
    }
  });

  it("keeps the outcome enum identical to PROBE_OUTCOMES", () => {
    expect(providerReadinessStatus.outcome.enumValues).toEqual([...PROBE_OUTCOMES]);
    expect(PROBE_OUTCOMES).toHaveLength(6);
  });

  it("scopes rows by company_default | agent", () => {
    expect(providerReadinessStatus.scopeType.enumValues).toEqual(["company_default", "agent"]);
    // company_default rows carry a NULL scope_id, so the column must be nullable.
    expect(providerReadinessStatus.scopeId.notNull).toBe(false);
  });

  describe("the shipped migration", () => {
    const migrationSql = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
      .find((body) => body.includes("provider_readiness_scope_uq"));

    it("exists", () => {
      expect(migrationSql, "no migration defines provider_readiness_scope_uq").toBeDefined();
    });

    it("declares the unique constraint as NULLS NOT DISTINCT", () => {
      // Without NULLS NOT DISTINCT, Postgres treats every company_default row
      // (scope_id IS NULL) as unique, the upsert target never matches, and the
      // cache accumulates duplicate default rows.
      expect(migrationSql).toMatch(
        /CONSTRAINT "provider_readiness_scope_uq" UNIQUE NULLS NOT DISTINCT\("company_id","provider_id","scope_type","scope_id"\)/,
      );
    });

    it("constrains scope_id nullability to scope_type", () => {
      expect(migrationSql).toMatch(
        /CONSTRAINT "provider_readiness_scope_shape_check" CHECK \(\(scope_type = 'company_default' AND scope_id IS NULL\) OR \(scope_type = 'agent' AND scope_id IS NOT NULL\)\)/,
      );
    });

    it("is replay-safe: every CREATE and ADD CONSTRAINT is guarded", () => {
      // `applyPendingMigrationsManually` (packages/db/src/client.ts) re-runs
      // every statement in one transaction, so an unguarded ADD CONSTRAINT
      // throws 42710 on replay and rolls the whole migration back permanently.
      // CREATE TABLE IF NOT EXISTS makes that replay REACH the FK statements
      // instead of aborting harmlessly at line 1, so the FKs must be guarded
      // too. The repo-wide migration-idempotency test only greps CREATE
      // statements, so this table asserts its own ALTER guards.
      expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS "provider_readiness_status"');

      const addConstraints =
        migrationSql?.match(/^.*ALTER TABLE "provider_readiness_status" ADD CONSTRAINT.*$/gm) ?? [];
      expect(addConstraints.length).toBe(2);
      for (const stmt of addConstraints) {
        expect(stmt, stmt).toMatch(/^DO \$\$ BEGIN /);
        expect(stmt, stmt).toContain("EXCEPTION WHEN duplicate_object THEN NULL; END $$;");
      }
    });
  });
});
