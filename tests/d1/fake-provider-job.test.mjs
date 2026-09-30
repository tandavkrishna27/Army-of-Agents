// -----------------------------------------------------------------------------
// DEP-002 LIVE fake-provider in-stack smoke (Linux/CI ONLY — Docker + running D1
// compose). Proves the deterministic fake provider is reachable and scriptable
// THROUGH the networked stack (not just in-process): an allowlisted peer
// (test-runner) scripts a golden fixture on the control endpoint, drives the
// declared API, and reads a deterministic invocation ledger.
//
//   AOA_D1_LIVE=1 node --test tests/d1/fake-provider-job.test.mjs
//
// Without AOA_D1_LIVE=1 every case SKIPS cleanly (never faked).
//
// SCOPE NOTE: the FULL submit->placement->lease->ACK->fake-execute job path
// (E6F-01/E6F-03) additionally requires the E4 worker daemon (WRK-001/004, not
// built) and JOB-003 (E3, needs_changes). That end-to-end campaign runs at the
// independent E6-D1-FOUNDATION gate; this file proves the fake-provider substrate
// in-stack, which is DEP-002's owned surface.
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
// A golden fixture guaranteed to exist in tests/fixtures/distributed-execution/.
const FIXTURE_ID = "batch-success";
const PROVIDER_ID = "d1-smoke-provider";

/** Run `node -e <script>` inside a compose service; return combined stdout+stderr. */
function dexec(service, script) {
  const res = spawnSync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "exec", "-T", service, "node", "-e", script],
    { encoding: "utf8", timeout: 60_000 },
  );
  return `${res.stdout ?? ""}${res.stderr ?? ""}`;
}

// Post JSON to a URL and print STATUS:<code> BODY:<json>. Runs inside a service.
const postProbe = (url, body) =>
  `fetch('${url}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(body)})})` +
  `.then(async r=>{console.log('STATUS:'+r.status+' BODY:'+await r.text());process.exit(0)})` +
  `.catch(e=>{console.log('ERR:'+(e.cause&&e.cause.code||e.message));process.exit(0)});`;

const getProbe = (url) =>
  `fetch('${url}').then(async r=>{console.log('STATUS:'+r.status+' BODY:'+await r.text());process.exit(0)})` +
  `.catch(e=>{console.log('ERR:'+(e.cause&&e.cause.code||e.message));process.exit(0)});`;

test("an allowlisted peer scripts a golden fixture on the fake control endpoint", { skip: SKIP }, () => {
  // test-runner IS allowlisted (AOA_FAKE_PROVIDER_CTL_ALLOW) so /script is admitted.
  const reset = dexec("test-runner", postProbe("http://fake-provider:8081/reset", {}));
  assert.match(reset, /STATUS:200/, reset);
  const out = dexec(
    "test-runner",
    postProbe("http://fake-provider:8081/script", { providerId: PROVIDER_ID, fixtureId: FIXTURE_ID }),
  );
  assert.match(out, /STATUS:200/, out);
  assert.match(out, new RegExp(`"fixtureId":"${FIXTURE_ID}"`), out);
});

test("driving the declared API records a deterministic invocation ledger", { skip: SKIP }, () => {
  // create then execute through the declared execute API (:8080).
  const create = dexec("test-runner", postProbe("http://fake-provider:8080/invoke", { providerId: PROVIDER_ID, op: "create", args: {} }));
  assert.match(create, /STATUS:200/, create);
  const execute = dexec("test-runner", postProbe("http://fake-provider:8080/invoke", { providerId: PROVIDER_ID, op: "execute", args: {} }));
  assert.match(execute, /STATUS:200/, execute);
  // the ledger (control endpoint) reflects both ops in order for this providerId.
  const ledger = dexec("test-runner", getProbe(`http://fake-provider:8081/invocations?providerId=${PROVIDER_ID}`));
  assert.match(ledger, /STATUS:200/, ledger);
  assert.match(ledger, /"op":"create"/, ledger);
  assert.match(ledger, /"op":"execute"/, ledger);
});
