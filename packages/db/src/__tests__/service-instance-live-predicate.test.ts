// -----------------------------------------------------------------------------
// SVC-002 — the "is there a live instance" predicate must compile to SQL LITERALS.
//
// ★★★ WHY THIS TEST EXISTS, and it is a measurement rather than a theory. The three readers
// of "does this service have a non-terminal instance" — the sweep window's `NOT EXISTS`, the
// observed-state count, and the lost-race re-read — are all meant to be served by the partial
// unique index `service_instances_live_service_uq`, whose predicate is
// `status NOT IN ('stopped','failed','lost')` as LITERALS.
//
// Drizzle's `notInArray` emits those statuses as `$n` BIND PARAMETERS. postgres-js prepares
// these statements, and once PostgreSQL promotes a prepared statement to a GENERIC plan
// (after five custom executions) it can no longer prove that a parameterised
// `status NOT IN ($1,$2,$3)` implies the index's literal predicate — so the partial index
// becomes unusable and the plan falls back to a SEQUENTIAL SCAN of `service_instances`.
// Reproduced on PostgreSQL 18 during review of PR #406, where the generic plan seq-scanned.
// For a tenant with substantial instance history that turns the per-tick sweep into a full
// rescan and can push it into the statement timeout, so reconciliation stalls.
//
// A pure SQL-shape assertion is the right instrument: an EXPLAIN-based test would have to
// force five custom executions to reach the generic plan, which is slow and timing-dependent,
// while the property that actually matters — "no bind parameters in this predicate" — is
// decidable from the compiled statement.
//
// MUTANT: revert the helper to `notInArray(serviceInstances.status, [...TERMINAL])` -> the
// compiled statement carries three parameters and no literals -> red.
// -----------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  nonTerminalServiceInstanceStatus,
  TERMINAL_SERVICE_INSTANCE_STATUSES,
} from "../repositories/tenant/job-control.js";

function compile(): { sql: string; params: unknown[] } {
  const query = new PgDialect().sqlToQuery(nonTerminalServiceInstanceStatus());
  return { sql: query.sql, params: query.params };
}

describe("SVC-002 — the live-instance predicate is index-usable under a generic plan", () => {
  it("compiles to ZERO bind parameters", () => {
    // The whole property in one assertion: a parameterised predicate cannot be proven to
    // imply the partial index's literal predicate, so the index is dropped from the plan.
    expect(compile().params).toEqual([]);
  });

  it("inlines exactly the frozen terminal states, in order, as quoted literals", () => {
    const { sql } = compile();
    for (const status of TERMINAL_SERVICE_INSTANCE_STATUSES) {
      expect(sql, `terminal state ${status} must appear as a literal`).toContain(`'${status}'`);
    }
    // Derived from the frozen constant, never hand-listed here — the same discipline the
    // migration's index predicate and the server-side reconciliation assertion use.
    expect(sql).toContain(
      `not in (${TERMINAL_SERVICE_INSTANCE_STATUSES.map((s) => `'${s}'`).join(", ")})`.replace(
        "not in",
        "NOT IN",
      ),
    );
  });

  it("names the status column, so the predicate cannot silently target something else", () => {
    expect(compile().sql).toContain("status");
  });

  it("refuses to inline a terminal state that is not a bare lowercase identifier", () => {
    // The module-load guard beside the helper is what makes its `sql.raw` provably safe
    // rather than safe-by-inspection. This asserts the guard's RULE against the shipped
    // values; a future edit adding a quote or a space to the frozen list fails at import.
    for (const status of TERMINAL_SERVICE_INSTANCE_STATUSES) {
      expect(status).toMatch(/^[a-z_]+$/);
    }
  });
});
