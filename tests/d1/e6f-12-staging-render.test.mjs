// -----------------------------------------------------------------------------
// E6F-12 — DEP-006 LIVE staging-manifest render/config validation (Linux/CI ONLY —
// requires Docker Compose). SKIPs cleanly off AOA_D1_LIVE=1 (never faked — DEC-03).
//
//   AOA_D1_LIVE=1 node --test tests/d1/e6f-12-staging-render.test.mjs
//
// ── What this proves (DEP-006 D4) ────────────────────────────────────────────
// `docker compose -f docker-compose.staging.yml config` PARSES inside the Linux-CI
// lane (the real compose engine, not just the yaml-lite static parser), and the
// rendered model resolves the load-bearing staging facts: the two-failure-domain
// split (1 control-plane + 2 workers each), 4 workers total, the migration-first
// depends_on gate, worker drain (stop_grace_period), and the provider-control
// isolation (E2B_API_KEY confined to the adapter-management surface on
// provider-ctl-net, absent from every control-plane / worker). The SAME pure
// invariant module (scripts/lib/staging-manifest-invariants.mjs) also agrees with
// the committed manifest. This test EXISTS precisely because the yaml-lite static
// parse and the real compose engine CAN diverge (e.g. compose hoists `x-`-prefixed
// keys into `#extensions`, which is why the topology metadata uses real `com.aoa.*`
// labels): this lane is the parity check that keeps the static gate honest.
//
// This is a RENDER validation, NOT a full external-store bring-up: the real
// multi-host / external DB+object-store staging deployment is deferred to the
// deploy pipeline (scripts/deploy/*) / a REL ticket (design §4.1), not silently
// dropped. `docker compose config` requires NO running services, external store,
// or secret — it only resolves + validates the manifest.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SKIP } from "./lib/e6f-harness.mjs";
import { parseYaml } from "../../scripts/lib/yaml-lite.mjs";
import {
  evaluateStagingManifestInvariants,
  collectDocumentedEnvKeys,
  STAGING_SERVICES,
  CONTROL_PLANE_SERVICES,
  WORKER_SERVICES,
  ADAPTER_MANAGER_SERVICE,
  PROVIDER_CTL_NET,
  PROVIDER_CONTROL_CRED_ENV,
  DISTRIBUTED_EXECUTION_ENABLED_ENV,
  MIGRATE_SERVICE,
  FAILURE_DOMAIN_LABEL,
  EXPECTED_APP_DOMAINS,
} from "../../scripts/lib/staging-manifest-invariants.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STAGING_COMPOSE = path.join(repoRoot, "docker-compose.staging.yml");
const ENV_DOC = path.join(repoRoot, "docs", "deploy", "environment-variables.md");

/** Render + validate the staging manifest with the real compose engine (JSON model). */
function renderStaging() {
  const res = spawnSync(
    "docker",
    ["compose", "-f", STAGING_COMPOSE, "config", "--format", "json"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  let json = null;
  try {
    json = JSON.parse(res.stdout ?? "");
  } catch {
    json = null;
  }
  return { status: res.status, error: res.error, stdout: res.stdout ?? "", stderr: res.stderr ?? "", json };
}

/** Networks off a rendered service (compose renders `networks` as a keyed map). */
function renderedNetworks(service) {
  const nets = service?.networks;
  if (!nets) return [];
  if (Array.isArray(nets)) return nets.map(String);
  if (typeof nets === "object") return Object.keys(nets);
  return [String(nets)];
}

/** Env map off a rendered service (compose renders `environment` as a { k: v } map). */
function renderedEnv(service) {
  const env = service?.environment;
  if (env && typeof env === "object" && !Array.isArray(env)) return env;
  const out = {};
  for (const entry of env ?? []) {
    const s = String(entry);
    const idx = s.indexOf("=");
    if (idx === -1) out[s] = "";
    else out[s.slice(0, idx)] = s.slice(idx + 1);
  }
  return out;
}

function labelOf(service, key) {
  const labels = service?.labels;
  if (labels && typeof labels === "object" && !Array.isArray(labels)) return labels[key];
  if (Array.isArray(labels)) {
    for (const entry of labels) {
      const s = String(entry);
      const idx = s.indexOf("=");
      if (idx !== -1 && s.slice(0, idx) === key) return s.slice(idx + 1);
    }
  }
  return undefined;
}

// 1 ── The manifest renders under the real compose engine.
test("E6F-12: docker compose config parses the staging manifest", { skip: SKIP }, () => {
  const r = renderStaging();
  assert.equal(r.status, 0, `docker compose config must exit 0:\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
  assert.ok(r.json && r.json.services, `rendered config must carry a services map:\n${r.stdout.slice(0, 2000)}`);
  const names = Object.keys(r.json.services).sort();
  assert.deepEqual(names, [...STAGING_SERVICES].sort(), `rendered service set mismatch: ${names.join(",")}`);
});

// 2 ── The SAME pure invariant module agrees with the committed manifest.
test("E6F-12: the invariant module agrees with the committed manifest", { skip: SKIP }, () => {
  const compose = parseYaml(readFileSync(STAGING_COMPOSE, "utf8"));
  const documentedEnvKeys = collectDocumentedEnvKeys(readFileSync(ENV_DOC, "utf8"));
  const { violations } = evaluateStagingManifestInvariants(compose, { documentedEnvKeys });
  assert.deepEqual(violations, [], `static invariant module reported violations:\n${violations.join("\n")}`);
});

// 3 ── The rendered model resolves the two-failure-domain split (4 workers total).
test("E6F-12: rendered failure-domain split (1 CP + 2 workers per domain)", { skip: SKIP }, () => {
  const r = renderStaging();
  assert.equal(r.status, 0, r.stderr);
  const services = r.json.services;
  assert.equal(WORKER_SERVICES.filter((w) => services[w]).length, 4, "exactly 4 worker services");
  assert.equal(CONTROL_PLANE_SERVICES.filter((c) => services[c]).length, 2, "exactly 2 control-plane services");
  for (const [domain, members] of Object.entries(EXPECTED_APP_DOMAINS)) {
    for (const name of members) {
      assert.equal(labelOf(services[name], FAILURE_DOMAIN_LABEL), domain, `${name} must be in ${domain}`);
    }
  }
});

// 4 ── Migration-first + drain resolve in the rendered model.
test("E6F-12: migrate gate + worker drain resolve", { skip: SKIP }, () => {
  const r = renderStaging();
  assert.equal(r.status, 0, r.stderr);
  const services = r.json.services;
  for (const name of [...CONTROL_PLANE_SERVICES, ...WORKER_SERVICES]) {
    const dep = services[name]?.depends_on?.[MIGRATE_SERVICE];
    assert.equal(dep?.condition, "service_completed_successfully", `${name} must gate on ${MIGRATE_SERVICE} completion`);
  }
  for (const name of WORKER_SERVICES) {
    const grace = services[name]?.stop_grace_period;
    assert.ok(grace !== undefined && grace !== null && String(grace) !== "", `${name} must set stop_grace_period`);
  }
});

// 5 ── Provider-control isolation resolves: E2B_API_KEY confined to the adapter
//      surface on provider-ctl-net; absent from every control-plane / worker.
test("E6F-12: provider-control credential confined to the adapter-management surface", { skip: SKIP }, () => {
  const r = renderStaging();
  assert.equal(r.status, 0, r.stderr);
  const services = r.json.services;
  // adapter-manager is the sole surface on provider-ctl-net.
  for (const [name, svc] of Object.entries(services)) {
    const onProviderNet = renderedNetworks(svc).includes(PROVIDER_CTL_NET);
    if (name === ADAPTER_MANAGER_SERVICE) {
      assert.ok(onProviderNet, `${name} must be on ${PROVIDER_CTL_NET}`);
    } else {
      assert.ok(!onProviderNet, `${name} must NOT be on ${PROVIDER_CTL_NET}`);
    }
  }
  // E2B_API_KEY only on the adapter surface; absent from every CP + worker.
  for (const name of [...CONTROL_PLANE_SERVICES, ...WORKER_SERVICES]) {
    assert.ok(
      !(PROVIDER_CONTROL_CRED_ENV in renderedEnv(services[name])),
      `${name} must NOT carry ${PROVIDER_CONTROL_CRED_ENV}`,
    );
  }
  assert.ok(
    PROVIDER_CONTROL_CRED_ENV in renderedEnv(services[ADAPTER_MANAGER_SERVICE]),
    `${ADAPTER_MANAGER_SERVICE} must inject ${PROVIDER_CONTROL_CRED_ENV}`,
  );
  // The shared admission path is wired on both control-plane replicas.
  for (const name of CONTROL_PLANE_SERVICES) {
    assert.equal(renderedEnv(services[name])[DISTRIBUTED_EXECUTION_ENABLED_ENV], "true", `${name} must enable distributed execution`);
  }
});
