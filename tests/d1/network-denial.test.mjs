// -----------------------------------------------------------------------------
// DEP-002 LIVE network-denial proofs (Linux/CI ONLY — requires Docker + a running
// D1 compose stack). These are the runtime counterpart to the static topology
// validator (scripts/check-d1-compose.mjs).
//
//   AOA_D1_LIVE=1 node --test tests/d1/network-denial.test.mjs
//
// Without AOA_D1_LIVE=1 (e.g. on the Windows dev box or any host without the stack
// up) every case SKIPS cleanly — it is NEVER faked. Bring-up:
//   cp docker/d1/.env.example docker/d1/.env   # set DEP-001 admitted digests
//   docker compose -f docker-compose.d1.yml up -d
//
// Load-bearing proof: worker-a (NOT on data-net) cannot reach postgres:5432
// DIRECTLY. The single multi-homed toxiproxy is a DELIBERATE data-tier bridge, so
// `toxiproxy:15432 -> postgres:5432` IS TCP-reachable from a worker by design; the
// bridge-honesty test below documents that reaching TCP does not equal authenticated
// access — a worker holds no `aoa_app` credential, so postgres demands auth / errors.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIVE = process.env.AOA_D1_LIVE === "1";
const SKIP = LIVE ? false : "requires AOA_D1_LIVE=1 + a running docker-compose.d1.yml stack (Linux/CI only)";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPOSE_FILE = path.join(repoRoot, "docker-compose.d1.yml");

/** Run `node -e <script>` inside a compose service; return combined stdout+stderr. */
function dexec(service, script) {
  const res = spawnSync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "exec", "-T", service, "node", "-e", script],
    { encoding: "utf8", timeout: 60_000 },
  );
  return `${res.stdout ?? ""}${res.stderr ?? ""}`;
}

// A TCP-connect probe that prints CONNECTED on success or DENIED:<code> otherwise.
const tcpProbe = (host, port) =>
  `const net=require('net');const s=net.connect(${port},'${host}');` +
  `s.on('connect',()=>{console.log('CONNECTED');s.destroy();process.exit(0)});` +
  `s.on('error',e=>{console.log('DENIED:'+(e.code||e.message));process.exit(0)});` +
  `setTimeout(()=>{console.log('DENIED:TIMEOUT');process.exit(0)},5000);`;

const fetchProbe = (url) =>
  `fetch('${url}').then(r=>{console.log('STATUS:'+r.status);process.exit(0)})` +
  `.catch(e=>{console.log('ERR:'+(e.cause&&e.cause.code||e.message));process.exit(0)});`;

// A raw PostgreSQL v3 StartupMessage probe (no pg driver needed). Prints
// TCP:CONNECTED once the socket opens, then classifies postgres's first reply:
//   AUTH:REQ:<code>  server demands authentication (code != 0)  -> not authenticated
//   AUTH:ERR         server returned ErrorResponse ('E')        -> not authenticated
//   AUTH:OK          server returned AuthenticationOk (code 0)  -> authenticated (a hole!)
// It never sends a password, so without credentials it can only ever be REQ/ERR.
const pgStartupProbe = (host, port, user, db) =>
  `const net=require('net');` +
  `const cstr=s=>Buffer.concat([Buffer.from(s,'utf8'),Buffer.from([0])]);` +
  `const params=Buffer.concat([cstr('user'),cstr('${user}'),cstr('database'),cstr('${db}'),Buffer.from([0])]);` +
  `const body=Buffer.concat([Buffer.from([0,3,0,0]),params]);` +
  `const msg=Buffer.alloc(4+body.length);msg.writeInt32BE(msg.length,0);body.copy(msg,4);` +
  `const s=net.connect(${port},'${host}');let done=false;` +
  `s.on('connect',()=>{console.log('TCP:CONNECTED');s.write(msg)});` +
  `s.on('data',d=>{if(done)return;done=true;const t=String.fromCharCode(d[0]);` +
  `if(t==='R'){const c=d.length>=9?d.readInt32BE(5):-1;console.log(c===0?'AUTH:OK':'AUTH:REQ:'+c)}` +
  `else if(t==='E'){console.log('AUTH:ERR')}else{console.log('AUTH:OTHER:'+t)}` +
  `s.destroy();process.exit(0)});` +
  `s.on('error',e=>{console.log('TCP:DENIED:'+(e.code||e.message));process.exit(0)});` +
  `setTimeout(()=>{console.log(done?'DONE':'TCP:TIMEOUT');process.exit(0)},5000);`;

test("LOAD-BEARING: worker-a cannot reach postgres:5432 (not on data-net)", { skip: SKIP }, () => {
  const out = dexec("worker-a", tcpProbe("postgres", 5432));
  assert.ok(/DENIED/.test(out) && !/CONNECTED/.test(out), `expected denial, got:\n${out}`);
});

test("worker-b cannot reach postgres:5432 (not on data-net)", { skip: SKIP }, () => {
  const out = dexec("worker-b", tcpProbe("postgres", 5432));
  assert.ok(/DENIED/.test(out) && !/CONNECTED/.test(out), `expected denial, got:\n${out}`);
});

test("bridge honesty: worker-a reaches toxiproxy:15432 (TCP, by design) but CANNOT authenticate to postgres (no aoa_app creds)", { skip: SKIP }, () => {
  // The single multi-homed toxiproxy exposes control-plane->postgres on
  // 0.0.0.0:15432, so a worker's TCP connect to that bridge SUCCEEDS by design.
  // Isolation does not rely on hiding this port: the worker holds no DB credential,
  // so postgres must demand auth (AUTH:REQ) or reject (AUTH:ERR) — never AUTH:OK.
  const out = dexec("worker-a", pgStartupProbe("toxiproxy", 15432, "aoa_app", "aoa"));
  assert.match(out, /TCP:CONNECTED/, `expected the toxiproxy:15432 data-tier bridge to accept the TCP connection, got:\n${out}`);
  assert.ok(
    /AUTH:(REQ|ERR)/.test(out) && !/AUTH:OK/.test(out),
    `worker must NOT gain authenticated postgres access without aoa_app credentials, got:\n${out}`,
  );
});

test("positive control: worker-a CAN reach the fake-provider declared API (:8080)", { skip: SKIP }, () => {
  const out = dexec("worker-a", fetchProbe("http://fake-provider:8080/healthz"));
  assert.match(out, /STATUS:200/, out);
});

test("control-plane is REFUSED the fake control endpoint (:8081 peer allowlist)", { skip: SKIP }, () => {
  // control-plane shares provider-ctl-net with the fake, so TCP connects — but the
  // application-layer peer allowlist returns 403 (see docker/d1/README.md boundary).
  const out = dexec("control-plane", fetchProbe("http://fake-provider:8081/invocations"));
  assert.match(out, /STATUS:403/, `expected 403 from the peer-gated control endpoint, got:\n${out}`);
});

test("positive control: control-plane CAN reach the fake declared API (:8080)", { skip: SKIP }, () => {
  const out = dexec("control-plane", fetchProbe("http://fake-provider:8080/healthz"));
  assert.match(out, /STATUS:200/, out);
});
