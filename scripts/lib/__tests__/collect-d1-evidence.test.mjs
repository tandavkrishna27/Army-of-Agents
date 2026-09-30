// -----------------------------------------------------------------------------
// DEP-007 — collector query-repoint regression guard (node --test, LOCAL: no
// PG/Docker; the module is importable because main() is CLI-guarded).
//
//   node --test scripts/lib/__tests__/collect-d1-evidence.test.mjs
//
// The pre-DEP-007 evidence collector queried a NON-EXISTENT `worker_events` table
// (ORDER BY `seq`), so the retained failure-evidence `events` section was silently
// empty on every merge-train failure. The real JOB-005 ledger is `job_events` with
// a per-attempt `sequence` column. This asserts the repoint so the trace the
// telemetry-contract test reconstructs is actually retained.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import { EVENTS_QUERY, gatherEvents } from "../../collect-d1-evidence.mjs";

test("DEP-007: the events-section query targets job_events, retains most-recent rows chronologically, never worker_events/seq", () => {
  assert.match(EVENTS_QUERY, /\bFROM\s+job_events\b/i, "must read the real JOB-005 ledger `job_events`");
  assert.match(EVENTS_QUERY, /\bORDER BY\s+occurred_at\b/i, "must retain the MOST-RECENT rows by `occurred_at`, not the per-attempt `sequence` (which evicts low-seq rows under load)");
  assert.match(EVENTS_QUERY, /SELECT\s+\*/i, "must project all columns (row_to_json) so a projected-column typo can't silently drop the events");
  assert.doesNotMatch(EVENTS_QUERY, /worker_events/i, "the non-existent `worker_events` table must be gone");
  assert.doesNotMatch(EVENTS_QUERY, /\bseq\b/i, "the non-existent `seq` column must be gone (it is `sequence`)");
});

test("DEP-007: gatherEvents is exported and fails closed (empty array) when the stack is absent", () => {
  assert.equal(typeof gatherEvents, "function", "gatherEvents must be importable for the D1 evidence facet");
  // No Docker/compose stack in a unit env: the underlying `docker compose exec` is
  // best-effort and yields an EMPTY section (never a throw, never a partial).
  const events = gatherEvents("docker-compose.d1.yml");
  assert.deepEqual(events, [], "gatherEvents fails closed to [] with no live stack");
});
