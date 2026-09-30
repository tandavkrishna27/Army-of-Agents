// -----------------------------------------------------------------------------
// E6F-08 — LIVE managed-sandbox egress/isolation unreachability proofs (DE-26;
// Linux/CI ONLY — requires Docker + a running docker-compose.d1.yml stack). The
// runtime counterpart to the in-process hostile isolation suite
// (@armyofagents/sandbox-provider-contract runSandboxIsolationConformance) and the
// server-lane egress-bypass vectors gate (scripts/check-egress-bypass-vectors.mjs).
//
//   AOA_D1_LIVE=1 node --test tests/d1/e6f-08-egress-isolation.test.mjs
//
// Without AOA_D1_LIVE=1 (the Windows dev box, or any host without the stack up)
// every case SKIPS cleanly — it is NEVER faked (DEC-03: the live lane is Linux-CI
// authoritative, no Windows-local substitute). Bring-up is identical to E6F-03.
//
// ── What this proves (test-gates.md E6F-08 / DE-26) ──────────────────────────
// A tenant-workload container (worker-a, the sandbox-analog) and the provider
// container (fake-provider) sit ONLY on the `internal: true` D1 networks — they
// have NO default route off-stack. So from inside them:
//   * cloud metadata (169.254.169.254 IMDS, 169.254.170.2 ECS) is UNREACHABLE;
//   * an arbitrary external/public address (8.8.8.8) is UNREACHABLE;
//   * an arbitrary off-stack private address (10.0.0.1) is UNREACHABLE;
//   * the data tier (postgres:5432, on data-net only) is UNREACHABLE directly from
//     a worker (control-plane internals / cross-JOB DB isolation — every job's rows
//     live in postgres, and a worker holds no data-net route AND no aoa_app cred);
//   * the provider container likewise cannot reach the data tier.
// A positive control (worker-a → fake-provider:8080/healthz → 200) proves the
// denials are REAL segmentation, not a dead network.
//
// This reuses the E6F harness (`tests/d1/lib/e6f-harness.mjs`) for the SKIP guard,
// the compose-file path, and the service endpoint constants; the low-level probes
// are the same `docker compose exec node -e …` tcp/fetch idiom as the DEP-002
// network-denial live suite.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { SKIP, COMPOSE_FILE } from "./lib/e6f-harness.mjs";

/** Run `node -e <script>` inside a compose service; return combined stdout+stderr. */
function dexec(service, script) {
  const res = spawnSync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "exec", "-T", service, "node", "-e", script],
    { encoding: "utf8", timeout: 60_000 },
  );
  return `${res.stdout ?? ""}${res.stderr ?? ""}`;
}

/** A TCP-connect probe: prints CONNECTED on success, DENIED:<code> otherwise. */
const tcpProbe = (host, port) =>
  `const net=require('net');const s=net.connect(${port},'${host}');` +
  `s.on('connect',()=>{console.log('CONNECTED');s.destroy();process.exit(0)});` +
  `s.on('error',e=>{console.log('DENIED:'+(e.code||e.message));process.exit(0)});` +
  `setTimeout(()=>{console.log('DENIED:TIMEOUT');process.exit(0)},5000);`;

/** An HTTP fetch probe: prints STATUS:<code> on a response, ERR:<code> otherwise. */
const fetchProbe = (url) =>
  `fetch('${url}').then(r=>{console.log('STATUS:'+r.status);process.exit(0)})` +
  `.catch(e=>{console.log('ERR:'+(e.cause&&e.cause.code||e.message));process.exit(0)});`;

function assertUnreachable(out, label) {
  assert.ok(
    /DENIED|ERR:/.test(out) && !/CONNECTED|STATUS:2/.test(out),
    `${label}: expected the destination to be UNREACHABLE, got:\n${out}`,
  );
}

test("E6F-08 metadata: worker-a cannot reach the cloud IMDS endpoint 169.254.169.254 (internal nets, no off-stack route)", { skip: SKIP }, () => {
  assertUnreachable(dexec("worker-a", tcpProbe("169.254.169.254", 80)), "IMDS metadata");
});

test("E6F-08 metadata: worker-a cannot reach the ECS task metadata endpoint 169.254.170.2", { skip: SKIP }, () => {
  assertUnreachable(dexec("worker-a", tcpProbe("169.254.170.2", 80)), "ECS metadata");
});

test("E6F-08 external: worker-a cannot reach an arbitrary public address (8.8.8.8:53)", { skip: SKIP }, () => {
  assertUnreachable(dexec("worker-a", tcpProbe("8.8.8.8", 53)), "external public egress");
});

test("E6F-08 private-net: worker-a cannot reach an arbitrary off-stack private address (10.0.0.1:22)", { skip: SKIP }, () => {
  assertUnreachable(dexec("worker-a", tcpProbe("10.0.0.1", 22)), "off-stack private-net");
});

test("E6F-08 control-plane-internals / cross-job: worker-a cannot reach the data tier postgres:5432 directly (not on data-net)", { skip: SKIP }, () => {
  // Every job's rows live in postgres; a worker holds no data-net route (and no
  // aoa_app credential), so it can never read another job's data directly.
  assertUnreachable(dexec("worker-a", tcpProbe("postgres", 5432)), "worker → data tier");
});

test("E6F-08 provider-socket: the fake-provider container cannot reach the data tier postgres:5432 directly", { skip: SKIP }, () => {
  assertUnreachable(dexec("fake-provider", tcpProbe("postgres", 5432)), "provider → data tier");
});

test("E6F-08 metadata: the fake-provider container cannot reach the cloud IMDS endpoint either", { skip: SKIP }, () => {
  assertUnreachable(dexec("fake-provider", tcpProbe("169.254.169.254", 80)), "provider → IMDS metadata");
});

test("E6F-08 POSITIVE CONTROL: worker-a CAN reach the declared provider API (fake-provider:8080) — the denials are real segmentation", { skip: SKIP }, () => {
  const out = dexec("worker-a", fetchProbe("http://fake-provider:8080/healthz"));
  assert.match(out, /STATUS:200/, `expected the declared provider API to be reachable, got:\n${out}`);
});
