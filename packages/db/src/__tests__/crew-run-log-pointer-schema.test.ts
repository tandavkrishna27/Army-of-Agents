/**
 * T1 (crew observability) — the `internal_agent_runs` run-transcript pointer.
 *
 * A crew run's NDJSON transcript is only FINDABLE if the run row carries a
 * pointer to it; without these two columns a crew failure is back to being a
 * black box. Two invariants are load-bearing:
 *
 * 1. Both columns are NULLABLE. `runAoaAgent` opens the transcript immediately
 *    before `adapter.execute`, so every path that bails earlier (entry-claim
 *    race, task-checkout conflict, a fake-crew turn that short-circuits execute)
 *    and every run that predates T1 has no transcript at all. "No transcript"
 *    must stay a representable state — a NOT NULL column would force those runs
 *    to advertise a file that was never written.
 * 2. The pair mirrors `heartbeat_runs` exactly (same column names, same types,
 *    same nullability), because the run-log store and its readers are shared
 *    between the org and crew paths and key off `store` + `logRef`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import { internalAgentRuns } from "../schema/internal_agent.js";
import { heartbeatRuns } from "../schema/heartbeat_runs.js";

function columnsByName(table: PgTable) {
  return new Map(getTableConfig(table).columns.map((column) => [column.name, column]));
}

describe("internal_agent_runs run-log pointer", () => {
  it("exposes logStore/logRef mapped to the snake_case DB columns", () => {
    for (const property of ["logStore", "logRef"]) {
      expect(internalAgentRuns, property).toHaveProperty(property);
    }
    expect(internalAgentRuns.logStore.name).toBe("log_store");
    expect(internalAgentRuns.logRef.name).toBe("log_ref");

    // The names must also reach the emitted table, not just the JS object.
    const columns = columnsByName(internalAgentRuns);
    expect([...columns.keys()]).toEqual(expect.arrayContaining(["log_store", "log_ref"]));
  });

  it("keeps both columns nullable so a run with no transcript stays representable", () => {
    expect(internalAgentRuns.logStore.notNull).toBe(false);
    expect(internalAgentRuns.logRef.notNull).toBe(false);
    expect(internalAgentRuns.logStore.hasDefault).toBe(false);
    expect(internalAgentRuns.logRef.hasDefault).toBe(false);
  });

  it("stores both as free-form text", () => {
    for (const column of [internalAgentRuns.logStore, internalAgentRuns.logRef]) {
      expect(column.columnType, column.name).toBe("PgText");
      expect(column.dataType, column.name).toBe("string");
      expect(column.getSQLType(), column.name).toBe("text");
    }
  });

  it("matches the heartbeat_runs pointer it mirrors", () => {
    const crew = columnsByName(internalAgentRuns);
    const heartbeat = columnsByName(heartbeatRuns);
    for (const name of ["log_store", "log_ref"]) {
      const crewColumn = crew.get(name);
      const heartbeatColumn = heartbeat.get(name);
      expect(heartbeatColumn, `heartbeat_runs.${name}`).toBeDefined();
      expect(crewColumn, `internal_agent_runs.${name}`).toBeDefined();
      expect(crewColumn!.getSQLType()).toBe(heartbeatColumn!.getSQLType());
      expect(crewColumn!.notNull).toBe(heartbeatColumn!.notNull);
    }
  });

  it("ships a migration that adds both columns as nullable text", () => {
    const migration = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "0179_thin_jack_power.sql"),
      "utf8",
    );
    expect(migration).toContain('ALTER TABLE "internal_agent_runs" ADD COLUMN "log_store" text;');
    expect(migration).toContain('ALTER TABLE "internal_agent_runs" ADD COLUMN "log_ref" text;');
    // No NOT NULL / DEFAULT — backfilling either would claim a transcript exists
    // for every historical crew run.
    expect(migration).not.toMatch(/log_(store|ref)" text[^;\n]*(NOT NULL|DEFAULT)/i);
  });
});
