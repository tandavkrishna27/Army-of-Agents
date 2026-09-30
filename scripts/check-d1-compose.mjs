#!/usr/bin/env node
// -----------------------------------------------------------------------------
// DEP-002 static topology validator (LOCAL authority; no Docker required).
//
//   node scripts/check-d1-compose.mjs
//
// Parses the committed docker-compose.d1.yml with the dependency-free yaml-lite
// parser, loads docker/d1/toxiproxy.json, and asserts the full DEP-002 network-
// segmentation matrix via scripts/lib/d1-compose-invariants.mjs. Exits non-zero
// (printing the violation list) if ANY invariant is broken — most importantly if a
// worker service is attached to data-net.
//
// The live compose bring-up + network-denial tests are Linux/CI-only (see
// tests/d1/*.test.mjs); this static check is the local + CI-static gate.
// -----------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseYaml } from "./lib/yaml-lite.mjs";
import { evaluateComposeInvariants } from "./lib/d1-compose-invariants.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composePath = path.join(repoRoot, "docker-compose.d1.yml");
const toxiproxyPath = path.join(repoRoot, "docker", "d1", "toxiproxy.json");

function main() {
  let compose;
  try {
    compose = parseYaml(readFileSync(composePath, "utf8"));
  } catch (err) {
    console.error(`FAIL: could not parse ${composePath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  let toxiproxyConfig;
  try {
    toxiproxyConfig = JSON.parse(readFileSync(toxiproxyPath, "utf8"));
  } catch (err) {
    console.error(`FAIL: could not read ${toxiproxyPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const { violations } = evaluateComposeInvariants(compose, { toxiproxyConfig });

  if (violations.length > 0) {
    console.error(`FAIL: docker-compose.d1.yml violates ${violations.length} DEP-002 topology invariant(s):`);
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exit(1);
  }

  console.log("OK: docker-compose.d1.yml satisfies the DEP-002 network-segmentation matrix");
  console.log("    (10 services incl. the DEP-009 control-plane-b replica, exact per-service");
  console.log("     networks, no shared rw volume, healthchecks, service_healthy startup,");
  console.log("     2 distinct worker profiles, toxiproxy in-path on 4 links, neither");
  console.log("     control-plane replica in the fake control-endpoint allowlist).");
  console.log("");
  console.log("    Worker<->data isolation is NOT 'full network isolation'. It is:");
  console.log("      (a) no DIRECT worker->postgres:5432 path (worker not on data-net),");
  console.log("      (b) workers carry NO DB credential (cannot authenticate), and");
  console.log("      (c) E2 FORCE-RLS gates any data access.");
  console.log("    toxiproxy is a DELIBERATE multi-homed data-tier bridge; its :15432");
  console.log("    listener is TCP-reachable from workers BY DESIGN — isolation does");
  console.log("    not rely on hiding that port.");
}

main();
