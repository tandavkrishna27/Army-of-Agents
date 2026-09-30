// -----------------------------------------------------------------------------
// DEP-002 static-validator corpus (node:test).
//
//   node --test scripts/check-d1-compose.test.mjs
//
// Two layers:
//   1. Ties the validator to the REAL committed artifacts: parses
//      docker-compose.d1.yml with yaml-lite and asserts ZERO violations, and
//      checks the real docker/d1/toxiproxy.json.
//   2. NON-VACUOUSNESS: a hand-built valid compose object passes with zero
//      violations, and each deliberately-broken clone is REJECTED — most
//      importantly a worker wrongly attached to data-net, a shared rw volume, and
//      a missing healthcheck (the three mandated rejection fixtures), plus more.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseYaml } from "./lib/yaml-lite.mjs";
import {
  evaluateComposeInvariants,
  evaluateToxiproxyConfig,
  EXPECTED_NETWORKS,
} from "./lib/d1-compose-invariants.mjs";

// Aggregate the fail-closed control-endpoint allowlist proofs (FIX B) onto the
// shared node:test runner so the DEP-002 static gate covers them too.
import "../docker/d1/__tests__/ctl-allowlist.test.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composePath = path.join(repoRoot, "docker-compose.d1.yml");
const toxiproxyPath = path.join(repoRoot, "docker", "d1", "toxiproxy.json");

/** A complete, valid parsed-compose object mirroring the real topology. */
function validCompose() {
  const worker = (id, vol, profile) => ({
    image: "${AOA_D1_WORKER_IMAGE:-aoa-worker:d1-local-unbuilt}",
    environment: {
      AOA_WORKER_TARGET_PROFILE_ID: id,
      AOA_WORKER_CONTROL_PLANE_URL: "http://toxiproxy:13100",
      AOA_WORKER_S3_ENDPOINT: "http://toxiproxy:19000",
    },
    healthcheck: { test: ["CMD", "node", "-e", "fetch"] },
    volumes: [`${vol}:/worker`, `./docker/d1/${profile}:/profile.json:ro`],
    depends_on: {
      "control-plane": { condition: "service_healthy" },
      "fake-provider": { condition: "service_healthy" },
      toxiproxy: { condition: "service_healthy" },
    },
    networks: ["control-net", "worker-net", "provider-ctl-net"],
  });
  // DEP-009 — a control-plane replica factory (both replicas are byte-identical except
  // their state volume). checkMigrateGate / checkToxiproxyInPath / checkPresignEndpoint /
  // checkAdmittedImageRefs all iterate CONTROL_PLANE_SERVICES, so each replica must carry
  // the full env.
  const controlPlane = (vol) => ({
    image: "${AOA_D1_CONTROL_PLANE_IMAGE:-aoa-control-plane:d1-local-unbuilt}",
    environment: {
      DATABASE_URL: "postgres://aoa_app:aoa_app@toxiproxy:15432/aoa",
      // DAT-002 slice-7 — the live-MinIO object-storage env (checkPresignEndpoint).
      AOA_STORAGE_PROVIDER: "s3",
      AOA_STORAGE_S3_ENDPOINT: "https://minio:9000",
      AOA_STORAGE_S3_PRESIGN_ENDPOINT: "https://toxiproxy:19000",
      AOA_STORAGE_S3_FORCE_PATH_STYLE: "true",
      // DEP-009 — the cross-replica lockstep env (checkControlPlaneEnvLockstep): the
      // shared worker-session signing key + the distributed-execution flag must be
      // IDENTICAL on both replicas for session portability + a matching worker path.
      AOA_DISTRIBUTED_EXECUTION_ENABLED: "true",
      AOA_WORKER_SESSION_SIGNING_KEY: "d1-harness-worker-session-signing-key-0123456789abcdef",
    },
    healthcheck: { test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:3100/api/health"] },
    volumes: [`${vol}:/aoa`],
    depends_on: {
      postgres: { condition: "service_healthy" },
      migrate: { condition: "service_completed_successfully" },
      minio: { condition: "service_healthy" },
      toxiproxy: { condition: "service_healthy" },
    },
    networks: ["data-net", "control-net", "worker-net", "provider-ctl-net"],
  });
  return {
    name: "aoa-d1",
    services: {
      postgres: {
        image: "pgvector/pgvector:pg18",
        healthcheck: { test: ["CMD-SHELL", "pg_isready -U aoa -d aoa"] },
        volumes: ["d1-postgres-data:/var/lib/postgresql/data"],
        networks: ["data-net"],
      },
      minio: {
        image: "minio/minio:latest",
        healthcheck: { test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:9000/minio/health/live"] },
        volumes: ["d1-minio-data:/data"],
        networks: ["data-net", "control-net", "worker-net"],
      },
      toxiproxy: {
        image: "ghcr.io/shopify/toxiproxy:2.9.0",
        healthcheck: { test: ["CMD", "/toxiproxy-cli", "list"] },
        volumes: ["./docker/d1/toxiproxy.json:/toxiproxy.json:ro"],
        networks: ["data-net", "control-net", "worker-net"],
      },
      migrate: {
        image: "${AOA_D1_CONTROL_PLANE_IMAGE:-aoa-control-plane:d1-local-unbuilt}",
        environment: { DATABASE_URL: "postgres://aoa:aoa@postgres:5432/aoa" },
        depends_on: { postgres: { condition: "service_healthy" } },
        networks: ["data-net"],
      },
      "control-plane": controlPlane("d1-control-plane-state"),
      // DEP-009 — the interchangeable replica: same env/networks/migrate-gate, its OWN
      // state volume (no shared rw mount).
      "control-plane-b": controlPlane("d1-control-plane-b-state"),
      "worker-a": worker("d1-worker-a", "d1-worker-a-state", "worker-a.profile.json"),
      "worker-b": worker("d1-worker-b", "d1-worker-b-state", "worker-b.profile.json"),
      "fake-provider": {
        image: "aoa-d1-fake-provider:local",
        environment: { AOA_FAKE_PROVIDER_CTL_ALLOW: "worker-a,worker-b,test-runner" },
        healthcheck: { test: ["CMD", "node", "-e", "fetch"] },
        volumes: ["./tests/fixtures/distributed-execution:/fixtures:ro"],
        networks: ["control-net", "worker-net", "provider-ctl-net"],
      },
      "test-runner": {
        image: "node:lts-trixie-slim",
        healthcheck: { test: ["CMD-SHELL", "true"] },
        volumes: [".:/repo:ro"],
        depends_on: {
          "control-plane": { condition: "service_healthy" },
          "worker-a": { condition: "service_healthy" },
          "worker-b": { condition: "service_healthy" },
          "fake-provider": { condition: "service_healthy" },
        },
        networks: ["control-net"],
      },
    },
    networks: {
      "data-net": { internal: true },
      "control-net": { internal: true },
      "worker-net": { internal: true },
      "provider-ctl-net": { internal: true },
    },
    volumes: {
      "d1-postgres-data": null,
      "d1-minio-data": null,
      "d1-control-plane-state": null,
      "d1-control-plane-b-state": null,
      "d1-worker-a-state": null,
      "d1-worker-b-state": null,
    },
  };
}

const clone = (o) => structuredClone(o);
const anyMatch = (violations, re) => violations.some((x) => re.test(x));

// === Layer 1: real committed artifacts =======================================

test("real docker-compose.d1.yml parses and satisfies every DEP-002 invariant", () => {
  const compose = parseYaml(readFileSync(composePath, "utf8"));
  const toxiproxyConfig = JSON.parse(readFileSync(toxiproxyPath, "utf8"));
  const { violations } = evaluateComposeInvariants(compose, { toxiproxyConfig });
  assert.deepEqual(violations, [], `unexpected violations:\n${violations.join("\n")}`);
});

test("real compose parses to exactly the 10 matrix services with exact network sets", () => {
  const compose = parseYaml(readFileSync(composePath, "utf8"));
  const names = Object.keys(compose.services).sort();
  assert.deepEqual(names, Object.keys(EXPECTED_NETWORKS).sort());
  for (const [name, expected] of Object.entries(EXPECTED_NETWORKS)) {
    assert.deepEqual(
      [...new Set(compose.services[name].networks)].sort(),
      [...expected].sort(),
      `service ${name} networks`,
    );
  }
});

test("real compose: neither worker is attached to data-net", () => {
  const compose = parseYaml(readFileSync(composePath, "utf8"));
  for (const w of ["worker-a", "worker-b"]) {
    assert.ok(!compose.services[w].networks.includes("data-net"), `${w} must not be on data-net`);
  }
});

test("real toxiproxy.json declares the three in-path proxies", () => {
  const config = JSON.parse(readFileSync(toxiproxyPath, "utf8"));
  assert.deepEqual(evaluateToxiproxyConfig(config), []);
});

// === Layer 2a: the hand-built valid baseline passes ==========================

test("hand-built valid compose passes with zero violations", () => {
  assert.deepEqual(evaluateComposeInvariants(validCompose()).violations, []);
});

// === Layer 2b: NON-VACUOUSNESS — each broken clone is REJECTED ================

test("REJECT: a worker attached to data-net (load-bearing isolation invariant)", () => {
  const c = clone(validCompose());
  c.services["worker-a"].networks.push("data-net");
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(violations.length > 0);
  assert.ok(anyMatch(violations, /worker.*data-net|ISOLATION VIOLATION/i), violations.join("\n"));
});

test("REJECT: control-plane in the fake-provider control-endpoint allowlist (FIX A boundary)", () => {
  // The control-plane must NOT be able to script the fake provider. This is the
  // static counterpart to the AOA_D1_LIVE-gated 403 proof in network-denial.test.mjs.
  const c = clone(validCompose());
  c.services["fake-provider"].environment.AOA_FAKE_PROVIDER_CTL_ALLOW =
    "worker-a,worker-b,test-runner,control-plane";
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(violations.length > 0);
  assert.ok(
    anyMatch(violations, /control-plane.*must not.*allowlist|AOA_FAKE_PROVIDER_CTL_ALLOW/i),
    violations.join("\n"),
  );
});

test("REJECT: an empty/unset fake-provider control-endpoint allowlist (FIX A non-empty)", () => {
  const c = clone(validCompose());
  c.services["fake-provider"].environment.AOA_FAKE_PROVIDER_CTL_ALLOW = "";
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /AOA_FAKE_PROVIDER_CTL_ALLOW/i), violations.join("\n"));
});

test("REJECT: a worker carrying a PostgreSQL credential (FIX C credential boundary)", () => {
  // Even reaching toxiproxy:15432 -> postgres:5432 indirectly, a worker with no DB
  // credential cannot authenticate. Statically forbid any DB DSN/credential on a worker.
  const c = clone(validCompose());
  c.services["worker-a"].environment.DATABASE_URL =
    "postgres://aoa_app:aoa_app@toxiproxy:15432/aoa";
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(violations.length > 0);
  assert.ok(
    anyMatch(violations, /worker.*(DATABASE_URL|PostgreSQL credential|DB-credential)/i),
    violations.join("\n"),
  );
});

test("REJECT: two services sharing a read-write volume", () => {
  const c = clone(validCompose());
  c.services["worker-b"].volumes[0] = "d1-worker-a-state:/worker"; // same rw named volume as worker-a
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /shared read-write mount/i), violations.join("\n"));
});

test("REJECT: a long-running service missing a healthcheck", () => {
  const c = clone(validCompose());
  delete c.services["control-plane"].healthcheck;
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /missing a healthcheck/i), violations.join("\n"));
});

test("REJECT: control-plane<->postgres not routed through toxiproxy", () => {
  const c = clone(validCompose());
  c.services["control-plane"].environment.DATABASE_URL = "postgres://aoa_app:aoa_app@postgres:5432/aoa";
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /not routed through toxiproxy/i), violations.join("\n"));
});

test("REJECT: the two workers registering identical target profiles", () => {
  const c = clone(validCompose());
  c.services["worker-b"].environment.AOA_WORKER_TARGET_PROFILE_ID = "d1-worker-a";
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /DISTINCT target profiles/i), violations.join("\n"));
});

test("REJECT: an unexpected extra service", () => {
  const c = clone(validCompose());
  c.services["rogue"] = { image: "x", healthcheck: { test: ["CMD", "true"] }, networks: ["control-net"] };
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /unexpected service 'rogue'/), violations.join("\n"));
});

test("REJECT: an isolation network not declared internal", () => {
  const c = clone(validCompose());
  c.networks["data-net"].internal = false;
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /must be declared 'internal: true'/), violations.join("\n"));
});

test("REJECT: short-form (list) depends_on", () => {
  const c = clone(validCompose());
  c.services["control-plane"].depends_on = ["postgres", "migrate"];
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /short-form 'depends_on'/), violations.join("\n"));
});

test("REJECT: control-plane not gated on migrate completion", () => {
  const c = clone(validCompose());
  delete c.services["control-plane"].depends_on.migrate;
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /depends_on 'migrate'.*service_completed_successfully/), violations.join("\n"));
});

test("REJECT: depending on the one-shot migrate job with service_healthy", () => {
  const c = clone(validCompose());
  c.services["control-plane"].depends_on.migrate = { condition: "service_healthy" };
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /one-shot job 'migrate'.*service_completed_successfully/), violations.join("\n"));
});

test("REJECT: a hardcoded (non-injected) control-plane image digest", () => {
  const c = clone(validCompose());
  c.services["control-plane"].image = "ghcr.io/meteoritelabs/aoa-control-plane@sha256:deadbeef";
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /control-plane 'image' must be injected/), violations.join("\n"));
});

test("REJECT: control-plane missing provider-ctl-net (wrong network set)", () => {
  const c = clone(validCompose());
  c.services["control-plane"].networks = ["data-net", "control-net", "worker-net"];
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /control-plane.*network set.*!=/), violations.join("\n"));
});

test("REJECT: a non-https control-plane presign endpoint (DAT-002 https grant constraint)", () => {
  // The frozen artifact grant `url` is strictly https and presign fails closed on
  // non-https, so a http:// presign endpoint can never mint a conformant grant.
  const c = clone(validCompose());
  c.services["control-plane"].environment.AOA_STORAGE_S3_PRESIGN_ENDPOINT = "http://toxiproxy:19000";
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(violations.length > 0);
  assert.ok(
    anyMatch(violations, /AOA_STORAGE_S3_PRESIGN_ENDPOINT.*must be https/i),
    violations.join("\n"),
  );
});

test("REJECT: control-plane missing the s3 storage provider (DAT-002 live tier)", () => {
  const c = clone(validCompose());
  delete c.services["control-plane"].environment.AOA_STORAGE_PROVIDER;
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /AOA_STORAGE_PROVIDER=s3/), violations.join("\n"));
});

test("REJECT: control-plane object storage without path-style (SigV4 host match)", () => {
  const c = clone(validCompose());
  c.services["control-plane"].environment.AOA_STORAGE_S3_FORCE_PATH_STYLE = "false";
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /AOA_STORAGE_S3_FORCE_PATH_STYLE.*must be 'true'/i), violations.join("\n"));
});

// === Layer 2b (DEP-009): the replica's lockstep invariants are non-vacuous =====
// Each broken control-plane-b clone must be REJECTED by the SAME per-replica check that
// guards control-plane — proving the two-replica invariants are real, not decorative.

test("REJECT (DEP-009): control-plane-b with a wrong network set", () => {
  const c = clone(validCompose());
  c.services["control-plane-b"].networks = ["data-net", "control-net", "worker-net"];
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /control-plane-b.*network set.*!=/), violations.join("\n"));
});

test("REJECT (DEP-009): control-plane-b not gated on migrate completion", () => {
  const c = clone(validCompose());
  delete c.services["control-plane-b"].depends_on.migrate;
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /'control-plane-b' must depends_on 'migrate'.*service_completed_successfully/), violations.join("\n"));
});

test("REJECT (DEP-009): control-plane-b sharing control-plane's read-write state volume", () => {
  const c = clone(validCompose());
  c.services["control-plane-b"].volumes[0] = "d1-control-plane-state:/aoa"; // same rw named volume as control-plane
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /shared read-write mount/i), violations.join("\n"));
});

test("REJECT (DEP-009): control-plane-b<->postgres not routed through toxiproxy", () => {
  const c = clone(validCompose());
  c.services["control-plane-b"].environment.DATABASE_URL = "postgres://aoa_app:aoa_app@postgres:5432/aoa";
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /control-plane-b.*not routed through toxiproxy/i), violations.join("\n"));
});

test("REJECT (DEP-009): a hardcoded (non-injected) control-plane-b image digest", () => {
  const c = clone(validCompose());
  c.services["control-plane-b"].image = "ghcr.io/meteoritelabs/aoa-control-plane@sha256:deadbeef";
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /control-plane-b 'image' must be injected/), violations.join("\n"));
});

test("REJECT (DEP-009): control-plane-b missing the https presign endpoint", () => {
  const c = clone(validCompose());
  c.services["control-plane-b"].environment.AOA_STORAGE_S3_PRESIGN_ENDPOINT = "http://toxiproxy:19000";
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(
    anyMatch(violations, /control-plane-b.*AOA_STORAGE_S3_PRESIGN_ENDPOINT.*must be https/i),
    violations.join("\n"),
  );
});

test("REJECT (DEP-009): control-plane-b in the fake-provider control-endpoint allowlist", () => {
  const c = clone(validCompose());
  c.services["fake-provider"].environment.AOA_FAKE_PROVIDER_CTL_ALLOW =
    "worker-a,worker-b,test-runner,control-plane-b";
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(
    anyMatch(violations, /control-plane-b.*must not appear in.*AOA_FAKE_PROVIDER_CTL_ALLOW/i),
    violations.join("\n"),
  );
});

test("REJECT (DEP-009): control-plane-b with a DIVERGENT worker-session signing key", () => {
  // The cross-replica session-portability premise: a session signed at one replica must
  // verify at the other, which holds ONLY if the signing key is identical. A divergent key
  // silently breaks failover — caught statically here.
  const c = clone(validCompose());
  c.services["control-plane-b"].environment.AOA_WORKER_SESSION_SIGNING_KEY =
    "d1-harness-DIVERGENT-key-0000000000000000";
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(
    anyMatch(violations, /disagree on 'AOA_WORKER_SESSION_SIGNING_KEY'.*IDENTICAL/i),
    violations.join("\n"),
  );
});

test("REJECT (DEP-009): control-plane-b with a DIVERGENT distributed-execution flag", () => {
  const c = clone(validCompose());
  c.services["control-plane-b"].environment.AOA_DISTRIBUTED_EXECUTION_ENABLED = "false";
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(
    anyMatch(violations, /disagree on 'AOA_DISTRIBUTED_EXECUTION_ENABLED'.*IDENTICAL/i),
    violations.join("\n"),
  );
});

// ★ Blocker B — the workers must keep entering the DAEMON bin.
//
// `AOA_WORKER_PROVIDER_URL` has been set on both D1 workers since WRK-008, pointed at a real
// in-net `fake-provider`, and was correctly declared "present and DEAD" because no shipped image
// contained a bin that reads it. Blocker B puts that bin in the worker image, so the only thing
// between D1 and a live fabricating provider is the absence of a `command:` override — one line,
// no env change, invisible to the dispatch-declaration checker (which parses `environment` only).
test("REJECT (Blocker B): a D1 worker whose command enters the networked-host bin", () => {
  const c = clone(validCompose());
  c.services["worker-a"].command = ["node", "/worker-net-app/dist/bin/networked-host.js"];
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /networked-host/i), violations.join("\n"));
});

test("REJECT (Blocker B): a D1 worker whose ENTRYPOINT enters the networked-host bin", () => {
  // Both delivery routes, for the same reason the dispatch-switch checker spans both: an
  // entrypoint override is as effective as a command one, and a guard covering only `command`
  // reads as coverage while leaving the other half open.
  const c = clone(validCompose());
  c.services["worker-b"].entrypoint = ["sh", "-c", "exec node /worker-net-app/dist/bin/networked-host.js"];
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /networked-host/i), violations.join("\n"));
});

test("the shipped D1 compose does NOT enter the networked-host bin (anti-vacuity)", () => {
  // If the real compose ever DID set it, the two REJECT cases above would still pass while the
  // property they exist to protect was already broken. This is the case that pins the tree.
  const { violations } = evaluateComposeInvariants(clone(validCompose()));
  assert.ok(!anyMatch(violations, /networked-host/i), violations.join("\n"));
});

test("REJECT (DEP-009): a control-plane replica missing the shared session signing key", () => {
  const c = clone(validCompose());
  delete c.services["control-plane-b"].environment.AOA_WORKER_SESSION_SIGNING_KEY;
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(
    anyMatch(violations, /'control-plane-b' must declare a non-empty 'AOA_WORKER_SESSION_SIGNING_KEY'/),
    violations.join("\n"),
  );
});

test("REJECT (DEP-009): a lone control-plane with no replica (missing control-plane-b)", () => {
  // A replica added to EXPECTED_NETWORKS but dropped from compose fails checkServiceSet —
  // the lockstep tripwire (adding the pin without the service reddens the gate).
  const c = clone(validCompose());
  delete c.services["control-plane-b"];
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /missing required service 'control-plane-b'/), violations.join("\n"));
});

test("real toxiproxy.json declares the per-replica worker-to-control-plane-b proxy", () => {
  const config = JSON.parse(readFileSync(toxiproxyPath, "utf8"));
  const names = config.map((p) => p.name);
  assert.ok(names.includes("worker-to-control-plane-b"), `missing worker-to-control-plane-b: ${names.join(",")}`);
});

test("REJECT: toxiproxy config with a wrong upstream", () => {
  const bad = [
    { name: "control-plane-to-postgres", listen: "0.0.0.0:15432", upstream: "postgres:9999" },
    { name: "worker-to-control-plane", listen: "0.0.0.0:13100", upstream: "control-plane:3100" },
    { name: "worker-to-minio", listen: "0.0.0.0:19000", upstream: "minio:9000" },
  ];
  const v = evaluateToxiproxyConfig(bad);
  assert.ok(anyMatch(v, /control-plane-to-postgres.*upstream/), v.join("\n"));
});

// === Layer 2c: yaml-lite parser unit tests ===================================

test("yaml-lite parses nested mappings, block/flow sequences, and quoted scalars", () => {
  const doc = parseYaml(
    [
      "root:",
      "  seq:",
      "    - a",
      '    - "b:c"',
      "  flow: [1, 2, 3]",
      '  url: "http://host:3100/x"',
      "  nested:",
      "    condition: service_healthy",
      "  flag: true",
    ].join("\n"),
  );
  assert.deepEqual(doc.root.seq, ["a", "b:c"]);
  assert.deepEqual(doc.root.flow, [1, 2, 3]);
  assert.equal(doc.root.url, "http://host:3100/x");
  assert.deepEqual(doc.root.nested, { condition: "service_healthy" });
  assert.equal(doc.root.flag, true);
});

test("yaml-lite strips comments but preserves '#' inside quotes", () => {
  const doc = parseYaml(['a: 1 # trailing comment', 'b: "has # hash"'].join("\n"));
  assert.equal(doc.a, 1);
  assert.equal(doc.b, "has # hash");
});

// === WRK-017: custody mode ⇄ boot root, and the migrate-side seed ============
//
// These clauses exist because the two halves of "one worker enrols" live in different
// compose keys — `environment.AOA_WORKER_KEY_STORE_MODE` and `command:` — and either half
// alone is a pre-socket `exit 1` that `up --wait` reports only as an unhealthy service.
// Every case below is a state a rebase, a revert or a copy-paste can actually produce.

/** Turn `validCompose()`'s worker-b into the enrolling worker, plus the migrate-side seed. */
function enrollingCompose() {
  const c = clone(validCompose());
  const b = c.services["worker-b"];
  b.environment.AOA_WORKER_KEY_STORE_MODE = "file_record";
  b.environment.AOA_WORKER_STATE_DIR = "/worker";
  b.environment.AOA_WORKER_ENROLLMENT_CODE_FILE = "/enrollment-code";
  b.command = ["node", "dist/bin/container-host.js"];
  b.volumes.push("./docker/d1/worker-b.enrollment-ticket:/enrollment-code:ro");
  c.services.migrate.environment.AOA_D1_SEED_WORKER_ENROLMENT = "1";
  c.services.migrate.environment.AOA_D1_SEED_ENROLMENT_TICKET_FILE = "/seed-enrolment-ticket";
  c.services.migrate.volumes = [
    "./docker/d1/worker-b.profile.json:/seed-worker.profile.json:ro",
    "./docker/d1/worker-b.enrollment-ticket:/seed-enrolment-ticket:ro",
  ];
  return c;
}

test("hand-built ENROLLING compose passes with zero violations (anti-vacuity)", () => {
  assert.deepEqual(evaluateComposeInvariants(enrollingCompose()).violations, []);
});

test("REJECT (WRK-017): file_record custody without the container-host command", () => {
  const c = enrollingCompose();
  delete c.services["worker-b"].command; // the image CMD enters the DAEMON bin
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /does not enter the container-host bin/i), violations.join("\n"));
});

test("REJECT (WRK-017): the container-host command with mounted_secret custody", () => {
  const c = enrollingCompose();
  c.services["worker-b"].environment.AOA_WORKER_KEY_STORE_MODE = "mounted_secret";
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /injects record stores UNCONDITIONALLY/i), violations.join("\n"));
});

test("REJECT (WRK-017): the container-host command with NO custody mode declared at all", () => {
  const c = enrollingCompose();
  delete c.services["worker-b"].environment.AOA_WORKER_KEY_STORE_MODE;
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /injects record stores UNCONDITIONALLY/i), violations.join("\n"));
});

test("REJECT (WRK-017): an enrolling worker whose ticket path has nothing mounted at it", () => {
  const c = enrollingCompose();
  c.services["worker-b"].volumes = c.services["worker-b"].volumes.filter(
    (v) => !String(v).includes("/enrollment-code"),
  );
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /mounts nothing at that path/i), violations.join("\n"));
});

test("REJECT (WRK-017): an enrolling worker whose ticket mount is read-WRITE", () => {
  const c = enrollingCompose();
  c.services["worker-b"].volumes = c.services["worker-b"].volumes.map((v) =>
    String(v).includes("/enrollment-code") ? "./docker/d1/worker-b.enrollment-ticket:/enrollment-code" : v,
  );
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /read-WRITE/i), violations.join("\n"));
});

test("REJECT (WRK-017): an enrolling worker with no AOA_WORKER_ENROLLMENT_CODE_FILE", () => {
  const c = enrollingCompose();
  delete c.services["worker-b"].environment.AOA_WORKER_ENROLLMENT_CODE_FILE;
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /declares no 'AOA_WORKER_ENROLLMENT_CODE_FILE'/i), violations.join("\n"));
});

test("REJECT (WRK-017): an enrolling worker whose state dir is a BIND, not a named volume", () => {
  const c = enrollingCompose();
  c.services["worker-b"].volumes = c.services["worker-b"].volumes.map((v) =>
    String(v) === "d1-worker-b-state:/worker" ? "./tmp/worker-b:/worker" : v,
  );
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /not backed by a writable NAMED volume/i), violations.join("\n"));
});

test("REJECT (WRK-017): an enrolling worker whose state dir points nowhere", () => {
  const c = enrollingCompose();
  c.services["worker-b"].environment.AOA_WORKER_STATE_DIR = "/not-mounted";
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /not backed by a writable NAMED volume/i), violations.join("\n"));
});

test("REJECT (WRK-017): a worker enrols but migrate does not seed its authority", () => {
  const c = enrollingCompose();
  delete c.services.migrate.environment.AOA_D1_SEED_WORKER_ENROLMENT;
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /does not set 'AOA_D1_SEED_WORKER_ENROLMENT: 1'/i), violations.join("\n"));
});

test("REJECT (WRK-017): migrate seeds a DIFFERENT ticket than the worker presents", () => {
  const c = enrollingCompose();
  c.services.migrate.volumes[1] = "./docker/d1/worker-a.enrollment-ticket:/seed-enrolment-ticket:ro";
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /the SAME committed ticket/i), violations.join("\n"));
});

test("REJECT (WRK-017): migrate seeds while NO worker enrols (a seed nothing presents)", () => {
  const c = clone(validCompose());
  c.services.migrate.environment.AOA_D1_SEED_WORKER_ENROLMENT = "1";
  const { violations } = evaluateComposeInvariants(c);
  assert.ok(anyMatch(violations, /authorize a code nothing presents/i), violations.join("\n"));
});

test("the real D1 compose declares EXACTLY one enrolling worker and one control", () => {
  const compose = parseYaml(readFileSync(composePath, "utf8"));
  const modes = ["worker-a", "worker-b"].map(
    (w) => compose.services[w].environment.AOA_WORKER_KEY_STORE_MODE,
  );
  assert.equal(modes.filter((m) => m === "file_record").length, 1, `custody modes: ${modes.join(", ")}`);
  assert.equal(modes.filter((m) => m === "mounted_secret").length, 1, `custody modes: ${modes.join(", ")}`);
});
