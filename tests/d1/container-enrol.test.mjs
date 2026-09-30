// -----------------------------------------------------------------------------
// WRK-017 — the LIVE proof that a real worker CONTAINER enrolled (Linux/CI ONLY —
// requires Docker + a running D1 compose stack).
//
//   AOA_D1_LIVE=1 node --test tests/d1/container-enrol.test.mjs
//
// Without AOA_D1_LIVE=1 every case SKIPS cleanly — it is never faked.
//
// ── What is genuinely new here ───────────────────────────────────────────────
// Every other D1 suite simulates the worker: `tests/d1/lib/e6f-harness.mjs` says so in its
// own header — "There is NO live worker-daemon loop: enroll/poll/ack are ordinary
// authenticated HTTP calls the harness makes itself." This file asserts the opposite thing:
// that a container running the SHIPPED worker image, with NO test double anywhere in the
// path, read a POSIX enrolment ticket off a read-only mount, minted a device identity,
// enrolled against the real control plane over the real toxiproxy link, and PERSISTED the
// result to its own volume. That exercises WRK-014's custody stores and WRK-015's POSIX
// validator together, end to end, which no component test can.
//
// ── Why this file is not the only thing standing between D1 and a regression ──
// The enrol is LOAD-BEARING FOR BRING-UP, and that matters more than these assertions do.
// A `file_record` enrol failure calls `proc.exit(1)` (`bin/worker-daemon.ts`), the D1 workers
// declare no `restart:` policy, and the health socket closes with it — so `docker compose up
// -d --wait` FAILS and the merge-train job dies before it reaches any test, in EVERY campaign
// scope. This file adds what a failed bring-up cannot tell you: that the identity is really on
// the volume, that the control plane really holds the matching worker row, that the single-use
// code was consumed exactly once, that the negative control did NOT enrol, and that a restart
// short-circuits instead of enrolling a second time.
//
// It runs in BOTH campaign scopes (it is listed in the merge-train's BOUNDED set), because a
// scope selector is exactly the kind of thing that quietly stops running a check.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dexecModule } from "./lib/e6f-harness.mjs";

const LIVE = process.env.AOA_D1_LIVE === "1";
const SKIP = LIVE ? false : "requires AOA_D1_LIVE=1 + a running docker-compose.d1.yml stack (Linux/CI only)";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPOSE_FILE = path.join(repoRoot, "docker-compose.d1.yml");

/** The committed ticket is the ONE source of truth for what should have been enrolled. */
function expectedTicket() {
  const raw = readFileSync(path.join(repoRoot, "docker", "d1", "worker-b.enrollment-ticket"), "utf8").trim();
  const body = raw.slice("aoa_tkt_".length);
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
}

/** Read the two custody records out of a worker's own state volume, from inside it. */
function readWorkerState(service) {
  return dexecModule(
    service,
    `import { readFileSync } from "node:fs";
     const one = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); }
       catch (err) { return { __missing: err.code ?? String(err) }; } };
     console.log("__E6F_RESULT__" + JSON.stringify({
       identity: one("/worker/identity.json"),
       receipt: one("/worker/receipt.json"),
     }));`,
  );
}

/** One SQL probe in the control-plane container (owner role, like seedScenario). */
function query(sqlText, params) {
  return dexecModule(
    "control-plane",
    `import postgres from "postgres";
     const P = ${JSON.stringify(params)};
     const sql = postgres(process.env.DATABASE_URL, { max: 1 });
     try {
       const rows = await sql.unsafe(${JSON.stringify(sqlText)}, P);
       console.log("__E6F_RESULT__" + JSON.stringify({ rows }));
     } finally { await sql.end({ timeout: 5 }); }`,
  );
}

function composeLogs(service, tail = 400) {
  const res = spawnSync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "logs", "--no-color", "--tail", String(tail), service],
    { encoding: "utf8", timeout: 60_000 },
  );
  return `${res.stdout ?? ""}${res.stderr ?? ""}`;
}

// === The enrolling worker persisted a real identity ==========================

test("worker-b persisted a DeviceIdentityRecord + receipt to its own volume", { skip: SKIP }, () => {
  const ticket = expectedTicket();
  const { result, stdout, stderr } = readWorkerState("worker-b");
  assert.ok(result, `no result from worker-b:\n${stdout}\n${stderr}`);
  const { identity, receipt } = result;

  assert.ok(!identity.__missing, `worker-b has no /worker/identity.json (${identity.__missing})`);
  assert.ok(!receipt.__missing, `worker-b has no /worker/receipt.json (${receipt.__missing})`);

  // The on-disk shape is `record-codec.ts`'s EncodedIdentity: the private key is base64 under
  // a field NAMED so the daemon logger's redactor masks it. Asserting the field name is
  // asserting the redaction property, not just the shape.
  assert.equal(identity.v, 1);
  assert.equal(identity.targetId, ticket.targetId, "the persisted identity must belong to the ticket's target");
  assert.match(identity.workerId, /^[0-9a-f-]{36}$/, "workerId must be the minted UUID");
  assert.equal(identity.deviceGeneration, 1, "a FIRST enrolment is generation 1");
  assert.ok(
    typeof identity.privateKeyPkcs8B64 === "string" && identity.privateKeyPkcs8B64.length > 0,
    "the identity must carry the device private key — identity and key are ONE artifact (I6)",
  );

  assert.equal(receipt.v, 1);
  assert.equal(receipt.workerId, identity.workerId, "receipt and identity must agree about the worker (I6)");
  assert.equal(receipt.targetId, identity.targetId);
  assert.equal(receipt.deviceGeneration, identity.deviceGeneration);
  assert.match(receipt.deviceThumbprint, /^[0-9a-f]{64}$/, "the receipt proves the server answered");
});

// === worker-a is the NEGATIVE CONTROL ========================================

test("worker-a (mounted_secret control) persisted NOTHING", { skip: SKIP }, () => {
  const { result, stdout, stderr } = readWorkerState("worker-a");
  assert.ok(result, `no result from worker-a:\n${stdout}\n${stderr}`);
  // ENOENT specifically: the control must be missing the files, not holding unreadable ones.
  assert.equal(result.identity.__missing, "ENOENT", "worker-a must hold NO device identity");
  assert.equal(result.receipt.__missing, "ENOENT", "worker-a must hold NO enrolment receipt");
});

test("the assertion above is non-vacuous — worker-a IS up and its /worker IS readable", { skip: SKIP }, () => {
  const { result } = dexecModule(
    "worker-a",
    `import { readdirSync } from "node:fs";
     console.log("__E6F_RESULT__" + JSON.stringify({ entries: readdirSync("/worker") }));`,
  );
  assert.ok(result, "worker-a did not answer — an ENOENT from a dead container proves nothing");
  assert.ok(Array.isArray(result.entries), "worker-a's /worker must be a readable directory");
});

// === The control plane agrees ================================================

test("the control plane holds exactly ONE enrolled worker row for the target", { skip: SKIP }, () => {
  const ticket = expectedTicket();
  const state = readWorkerState("worker-b").result;
  const { result } = query(
    `SELECT id, status, scope, device_generation, device_thumbprint, execution_target_id,
            revoked_at, organization_id
       FROM workers WHERE execution_target_id = $1`,
    [ticket.targetId],
  );
  assert.ok(result, "no SQL result");
  assert.equal(result.rows.length, 1, `expected exactly one worker row, got ${result.rows.length}`);
  const row = result.rows[0];
  assert.equal(row.id, state.identity.workerId, "the server's worker id must be the one the container minted");
  assert.equal(row.status, "enrolled");
  assert.equal(row.scope, "organization");
  assert.equal(row.device_generation, 1);
  assert.equal(row.revoked_at, null);
  assert.equal(
    row.device_thumbprint,
    state.receipt.deviceThumbprint,
    "the receipt's thumbprint must be the key the server actually bound",
  );
});

test("the single-use enrolment code was consumed exactly once", { skip: SKIP }, () => {
  const ticket = expectedTicket();
  const { result } = query(
    `SELECT consumed_at IS NOT NULL AS consumed, device_thumbprint, scope
       FROM worker_enrollment_codes WHERE execution_target_id = $1`,
    [ticket.targetId],
  );
  assert.ok(result, "no SQL result");
  assert.equal(result.rows.length, 1, "the seed must have authorized exactly one code for this target");
  assert.equal(result.rows[0].consumed, true, "the code must be CONSUMED — an unconsumed code means no enrol happened");
});

// === A re-boot short-circuits: no second enrol ===============================

test("restarting worker-b does NOT enrol again (the steady-state short-circuit)", { skip: SKIP }, () => {
  const before = readWorkerState("worker-b").result;

  const restart = spawnSync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "restart", "worker-b"],
    { encoding: "utf8", timeout: 180_000 },
  );
  assert.equal(restart.status, 0, `restart failed:\n${restart.stdout}\n${restart.stderr}`);

  // Wait for the health surface to answer again rather than sleeping a fixed amount.
  let healthy = false;
  for (let attempt = 0; attempt < 60 && !healthy; attempt += 1) {
    const probe = spawnSync(
      "docker",
      ["compose", "-f", COMPOSE_FILE, "exec", "-T", "worker-b", "node", "-e",
        "fetch('http://127.0.0.1:9464/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
      { encoding: "utf8", timeout: 30_000 },
    );
    healthy = probe.status === 0;
    if (!healthy) spawnSync("docker", ["compose", "-f", COMPOSE_FILE, "ps"], { encoding: "utf8", timeout: 30_000 });
  }
  assert.ok(healthy, "worker-b did not come back healthy after a restart — a second enrol is the likely cause");

  // The identity is BYTE-IDENTICAL. `saveIfAbsent` is compare-and-set, so a second enrol
  // could not overwrite it — but a second enrol would consume a second code and rotate the
  // server-side generation, and both are checked below.
  const after = readWorkerState("worker-b").result;
  assert.deepEqual(after.identity, before.identity, "the device identity must survive a restart unchanged");
  assert.deepEqual(after.receipt, before.receipt, "the enrolment receipt must survive a restart unchanged");

  const logs = composeLogs("worker-b");
  assert.ok(
    logs.includes("already enrolled; skipping control-plane enrollment"),
    `worker-b did not log the steady-state short-circuit after a restart:\n${logs.slice(-4000)}`,
  );

  const ticket = expectedTicket();
  const { result } = query(
    `SELECT count(*)::int AS n, max(device_generation)::int AS gen
       FROM workers WHERE execution_target_id = $1`,
    [ticket.targetId],
  );
  assert.equal(result.rows[0].n, 1, "a restart must not create a second worker row");
  assert.equal(result.rows[0].gen, 1, "a restart must not advance the device generation");
});
