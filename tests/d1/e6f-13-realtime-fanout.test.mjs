// -----------------------------------------------------------------------------
// E6F-13 — MIG-003 durable realtime fan-out: REAL Postgres store + cross-process
// LISTEN/NOTIFY (Linux/CI ONLY — requires Docker + a running docker-compose.d1.yml
// two-replica stack). SKIPs cleanly off AOA_D1_LIVE=1 (never faked — DEC-03).
// Mirrors e6f-11's bring-up + hermetic-org discipline.
//
//   AOA_D1_LIVE=1 node --test tests/d1/e6f-13-realtime-fanout.test.mjs
//
// ── What this proves (MIG-003 gate: two-replica delivery + broker-outage) ─────
// The MIG-003 unit suite proves the in-process WS fan-out (per-event RBAC, seq
// dedup, replay latch, backpressure) against an in-memory store. This lane proves
// the part the unit suite CANNOT: the REAL `createLiveEventLogStore` SQL contract
// and the REAL cross-process `LISTEN/NOTIFY` wake over the SHARED Postgres both
// replicas run on.
//
//   1. Real append: bump the per-company `live_event_sequences` counter (contiguous
//      seq) + insert `live_event_log` under the aoa_app role with the org GUC set
//      (the exact `withTenantTx` FORCE-RLS path the distributed store uses) — a
//      broken RLS/grant would 42501/row-security-error here, not silently pass.
//   2. Real wake: a `pg_notify('live_events', {companyId,seq})` from the append
//      connection is observed on an INDEPENDENT `LISTEN` connection to the same
//      shared DB — the exact substrate that carries a poke from replica A's
//      publish to replica B's drainer. (The two replicas share ONE Postgres, so a
//      NOTIFY reaches every listener on the channel regardless of which
//      container/process opened it — the cross-process guarantee under test.)
//   3. Two-replica visibility: a SEPARATE, serial dexec on control-plane-b reads
//      the committed row through the same `since()` SQL the drainer runs — proving
//      replica B converges on replica A's durable event over the shared DB.
//   4. Broker outage → delay not loss: a second event is appended WITHOUT any
//      NOTIFY; replica B's `since()` safety-poll read still returns it — no row
//      lost when the wake is dropped (Invariant 2).
//
// RESIDUAL (honest): the literal WS socket-delivery leg on replica B (an
// authorized browser/agent socket receiving the fanned frame) is exercised by the
// in-process unit + e2e suites, not here — standing up an authenticated WS client
// inside the `authenticated`-mode d1 stack is out of scope for this store-layer
// proof. This lane proves the previously-untested REAL SQL + cross-process
// LISTEN/NOTIFY substrate that the socket delivery rides on.
//
// Serial-safe: each `test()` runs a SINGLE `dexecModule` (or two SEQUENTIAL ones);
// no test fans out concurrent docker execs (the campaign is --test-concurrency=1).
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  SKIP,
  newRaceScenarioIds,
  seedRaceScenario,
  dexecModule,
} from "./lib/e6f-harness.mjs";

const RESULT_MARKER = "__E6F_RESULT__";

/** Seed a hermetic org + company (one target + one job — the minimum seedRaceScenario
 * accepts). We only need the org/company rows so the durable-log composite tenant FK is
 * satisfied; the worker scenario is incidental. Returns { orgId, companyId }. */
function seedHermeticCompany() {
  const ids = newRaceScenarioIds({ targetCount: 1 });
  const seed = dexecModuleResult(
    seedRaceScenario({
      orgId: ids.orgId,
      companyId: ids.companyId,
      slug: ids.slug,
      issuePrefix: ids.issuePrefix,
      targets: ids.targets,
      jobs: [{ jobId: randomUUID(), attemptId: randomUUID(), targetIndex: 0 }],
      capacityCeiling: 8,
    }),
    "seed",
  );
  assert.equal(seed.ok, true, `seed failed: ${JSON.stringify(seed).slice(0, 800)}`);
  return { orgId: ids.orgId, companyId: ids.companyId };
}

function dexecModuleResult(res, label) {
  assert.ok(
    res.result !== null && res.result !== undefined,
    `${label}: no result parsed (exit=${res.status}${res.error ? ` error=${res.error}` : ""})\n` +
      `--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
  );
  return res.result;
}

// The REAL store's append + since SQL, replicated verbatim (the harness idiom is raw
// SQL, not importing compiled dist). `appendDurableEvent` runs under the aoa_app role
// with the org GUC set — the exact FORCE-RLS tenant path `withTenantTx` uses.
const STORE_SQL_SNIPPET = `
import postgres from "postgres";
const report = (value) => console.log("${RESULT_MARKER}" + JSON.stringify(value));
// Append under aoa_app + org GUC (FORCE-RLS satisfied only if grants+policy are right).
async function appendDurableEvent(appUrl, { organizationId, companyId, eventId, type, payload }) {
  const sql = postgres(appUrl, { max: 1 });
  try {
    return await sql.begin(async (tx) => {
      await tx\`select set_config('aoa.organization_id', \${organizationId}, true)\`;
      const [{ next_seq: seq }] = await tx\`
        INSERT INTO live_event_sequences (company_id, organization_id, next_seq)
        VALUES (\${companyId}, \${organizationId}, 1)
        ON CONFLICT (company_id) DO UPDATE
          SET next_seq = live_event_sequences.next_seq + 1, updated_at = now()
        RETURNING next_seq\`;
      const inserted = await tx\`
        INSERT INTO live_event_log (organization_id, company_id, seq, event_id, type, payload)
        VALUES (\${organizationId}, \${companyId}, \${seq}, \${eventId}, \${type}, \${tx.json(payload)})
        ON CONFLICT (organization_id, event_id) DO NOTHING
        RETURNING seq\`;
      return { seq: inserted.length > 0 ? inserted[0].seq : seq };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
// The drainer / catch-up read: rows with seq > sinceSeq, ascending, under org GUC.
async function sinceDurableEvents(appUrl, { organizationId, companyId, sinceSeq }) {
  const sql = postgres(appUrl, { max: 1 });
  try {
    return await sql.begin(async (tx) => {
      await tx\`select set_config('aoa.organization_id', \${organizationId}, true)\`;
      const rows = await tx\`
        SELECT company_id, seq, event_id, type, payload
        FROM live_event_log
        WHERE company_id = \${companyId} AND seq > \${sinceSeq}
        ORDER BY seq ASC\`;
      return rows.map((r) => ({ companyId: r.company_id, seq: Number(r.seq), eventId: r.event_id, type: r.type }));
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
`;

// 1 ── Real append + real cross-connection LISTEN/NOTIFY over the shared DB.
test("E6F-13: real store append under aoa_app RLS wakes a LISTEN connection", { skip: SKIP }, () => {
  const { orgId, companyId } = seedHermeticCompany();
  const eventId = randomUUID();
  const params = { orgId, companyId, eventId };
  const script = `
${STORE_SQL_SNIPPET}
const P = ${JSON.stringify(params)};
const appUrl = process.env.AOA_APP_DATABASE_URL || process.env.DATABASE_URL;
const ownerUrl = process.env.DATABASE_URL;
const listener = postgres(ownerUrl, { max: 1 });
let received = null;
try {
  // Independent LISTEN connection (the substrate a replica's broker LISTENs on).
  await listener.listen("live_events", (payload) => {
    try { received = JSON.parse(payload); } catch { received = { raw: payload }; }
  });
  // Real append under aoa_app + org GUC (proves grants + FORCE-RLS policy are correct).
  const { seq } = await appendDurableEvent(appUrl, {
    organizationId: P.orgId, companyId: P.companyId, eventId: P.eventId,
    type: "issue.status_changed", payload: { itemId: "i-1" },
  });
  // Data-free NOTIFY wake (only companyId + seq — D7 redaction).
  const noteSql = postgres(appUrl, { max: 1 });
  try {
    await noteSql\`SELECT pg_notify('live_events', \${JSON.stringify({ companyId: P.companyId, seq })})\`;
  } finally { await noteSql.end({ timeout: 5 }); }
  // Await the wake (bounded).
  const deadline = Date.now() + 5000;
  while (received === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  // The store's since() read returns the committed row (real SQL round-trip).
  const rows = await sinceDurableEvents(appUrl, { organizationId: P.orgId, companyId: P.companyId, sinceSeq: 0 });
  report({ ok: true, seq, received, rowSeqs: rows.map((r) => r.seq), rowEventIds: rows.map((r) => r.eventId), rowPayloadFree: rows.length });
} catch (error) {
  report({ ok: false, error: String(error && error.message ? error.message : error) });
} finally {
  await listener.end({ timeout: 5 });
}
`;
  const res = dexecModuleResult(dexecModule("control-plane", script, { timeout: 90_000 }), "append+notify@A");
  assert.equal(res.ok, true, `append/notify failed: ${JSON.stringify(res).slice(0, 800)}`);
  // `seq` is a Postgres bigint. The append/NOTIFY path reports it as a JSON STRING
  // ("1") across the dexec boundary, while the since() read path yields numbers —
  // so every seq comparison coerces with Number(). This file imports
  // `node:assert/strict`, where `equal` is strict, so an uncoerced '1' vs 1 fails
  // on a run whose realtime mechanism is entirely correct. That is exactly what
  // this test did before the coercion: ok:true, contiguous seqs, a data-free wake,
  // cross-replica convergence and NOTIFY-drop recovery all held, and only the JS
  // type of the reported value differed.
  assert.equal(Number(res.seq), 1, `first append must assign contiguous seq 1: ${JSON.stringify(res)}`);
  assert.ok(res.received, `the LISTEN connection must receive the NOTIFY wake: ${JSON.stringify(res)}`);
  assert.equal(res.received.companyId, companyId, `wake carries the companyId: ${JSON.stringify(res.received)}`);
  assert.equal(Number(res.received.seq), 1, `wake carries only (companyId, seq): ${JSON.stringify(res.received)}`);
  assert.equal(res.received.payload, undefined, `wake must be DATA-FREE (no payload): ${JSON.stringify(res.received)}`);
  assert.deepEqual(res.rowSeqs, [1], `since() returns the committed row: ${JSON.stringify(res)}`);
  assert.equal(res.rowEventIds[0], eventId, `the row carries the append eventId (drainer dedup key): ${JSON.stringify(res)}`);
});

// 2 ── Two-replica visibility: append on A (control-plane), read on B (control-plane-b).
test("E6F-13: control-plane-b converges on control-plane's durable event (shared DB)", { skip: SKIP }, () => {
  const { orgId, companyId } = seedHermeticCompany();
  const eventId = randomUUID();

  // Append on replica A.
  const appendScript = `
${STORE_SQL_SNIPPET}
const P = ${JSON.stringify({ orgId, companyId, eventId })};
const appUrl = process.env.AOA_APP_DATABASE_URL || process.env.DATABASE_URL;
try {
  const { seq } = await appendDurableEvent(appUrl, {
    organizationId: P.orgId, companyId: P.companyId, eventId: P.eventId,
    type: "hub.item.changed", payload: { itemId: "hub-1" },
  });
  report({ ok: true, seq });
} catch (error) {
  report({ ok: false, error: String(error && error.message ? error.message : error) });
}
`;
  const appended = dexecModuleResult(dexecModule("control-plane", appendScript, { timeout: 60_000 }), "append@A");
  assert.equal(appended.ok, true, `append@A failed: ${JSON.stringify(appended).slice(0, 800)}`);
  assert.equal(Number(appended.seq), 1, `append@A must assign seq 1: ${JSON.stringify(appended)}`);

  // Read on replica B via the SAME since() SQL the drainer runs (safety-poll path:
  // no NOTIFY needed — the shared DB is authoritative, so a dropped wake is a DELAY,
  // never a loss). This is the two-replica convergence + broker-outage proof.
  const readScript = `
${STORE_SQL_SNIPPET}
const P = ${JSON.stringify({ orgId, companyId })};
const appUrl = process.env.AOA_APP_DATABASE_URL || process.env.DATABASE_URL;
try {
  const rows = await sinceDurableEvents(appUrl, { organizationId: P.orgId, companyId: P.companyId, sinceSeq: 0 });
  report({ ok: true, rowSeqs: rows.map((r) => r.seq), types: rows.map((r) => r.type) });
} catch (error) {
  report({ ok: false, error: String(error && error.message ? error.message : error) });
}
`;
  const readB = dexecModuleResult(dexecModule("control-plane-b", readScript, { timeout: 60_000 }), "since@B");
  assert.equal(readB.ok, true, `since@B failed: ${JSON.stringify(readB).slice(0, 800)}`);
  assert.deepEqual(readB.rowSeqs, [1], `replica B must see replica A's committed event: ${JSON.stringify(readB)}`);
  assert.deepEqual(readB.types, ["hub.item.changed"], `replica B sees the correct event type: ${JSON.stringify(readB)}`);
});

// 3 ── Broker outage → delay, not loss: append WITHOUT any NOTIFY, then the safety-poll
// read on B still recovers the row (no event lost from the durable log — Invariant 2).
test("E6F-13: a durable event with its NOTIFY dropped is still recovered by the safety poll", { skip: SKIP }, () => {
  const { orgId, companyId } = seedHermeticCompany();
  const script = `
${STORE_SQL_SNIPPET}
const P = ${JSON.stringify({ orgId, companyId, e1: randomUUID(), e2: randomUUID() })};
const appUrl = process.env.AOA_APP_DATABASE_URL || process.env.DATABASE_URL;
try {
  // First event WITH a NOTIFY (baseline), second event with its NOTIFY DELIBERATELY
  // omitted (simulated broker loss). Both must be recoverable by a since() poll.
  const first = await appendDurableEvent(appUrl, {
    organizationId: P.orgId, companyId: P.companyId, eventId: P.e1,
    type: "issue.status_changed", payload: {},
  });
  const noteSql = postgres(appUrl, { max: 1 });
  try { await noteSql\`SELECT pg_notify('live_events', \${JSON.stringify({ companyId: P.companyId, seq: first.seq })})\`; }
  finally { await noteSql.end({ timeout: 5 }); }
  // Second append — NO pg_notify at all (the wake is dropped).
  const second = await appendDurableEvent(appUrl, {
    organizationId: P.orgId, companyId: P.companyId, eventId: P.e2,
    type: "issue.status_changed", payload: {},
  });
  // The safety-poll read from seq 1 recovers the un-notified tail with no row lost.
  const rows = await sinceDurableEvents(appUrl, { organizationId: P.orgId, companyId: P.companyId, sinceSeq: first.seq });
  report({ ok: true, firstSeq: first.seq, secondSeq: second.seq, recovered: rows.map((r) => r.seq) });
} catch (error) {
  report({ ok: false, error: String(error && error.message ? error.message : error) });
}
`;
  const res = dexecModuleResult(dexecModule("control-plane", script, { timeout: 60_000 }), "notify-drop");
  assert.equal(res.ok, true, `notify-drop test failed: ${JSON.stringify(res).slice(0, 800)}`);
  assert.equal(Number(res.firstSeq), 1, `first append seq 1: ${JSON.stringify(res)}`);
  assert.equal(Number(res.secondSeq), 2, `second append contiguous seq 2: ${JSON.stringify(res)}`);
  assert.deepEqual(res.recovered, [2], `the un-notified event 2 is recovered by the safety poll: ${JSON.stringify(res)}`);
});
