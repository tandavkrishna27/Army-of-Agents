#!/usr/bin/env node
// -----------------------------------------------------------------------------
// DEP-006 static staging-manifest validator (LOCAL authority; no Docker required).
//
//   node scripts/check-staging-manifest.mjs
//
// Parses the committed docker-compose.staging.yml with the dependency-free
// yaml-lite parser, reads the documented env-key set from
// docs/deploy/environment-variables.md, and asserts the full DEP-006 config
// contract (design §2, invariants 1–8) via scripts/lib/staging-manifest-invariants.mjs.
// Exits non-zero (printing the violation list) if ANY invariant is broken — most
// importantly if the provider-control credential (E2B_API_KEY) leaks off the
// adapter-management surface, or the shared admission limiter can fall back to
// process memory.
//
// The live `docker compose config` render validation is Linux/CI-only
// (tests/d1/e6f-12-staging-render.test.mjs); this static check is the always-on
// (pr.yml `policy`) local + CI-static gate.
// -----------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseYaml } from "./lib/yaml-lite.mjs";
import {
  evaluateStagingManifestInvariants,
  collectDocumentedEnvKeys,
} from "./lib/staging-manifest-invariants.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composePath = path.join(repoRoot, "docker-compose.staging.yml");
const envDocPath = path.join(repoRoot, "docs", "deploy", "environment-variables.md");

function main() {
  let compose;
  try {
    compose = parseYaml(readFileSync(composePath, "utf8"));
  } catch (err) {
    console.error(`FAIL: could not parse ${composePath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  let documentedEnvKeys;
  try {
    documentedEnvKeys = collectDocumentedEnvKeys(readFileSync(envDocPath, "utf8"));
  } catch (err) {
    console.error(`FAIL: could not read ${envDocPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const { violations } = evaluateStagingManifestInvariants(compose, { documentedEnvKeys });

  if (violations.length > 0) {
    console.error(`FAIL: docker-compose.staging.yml violates ${violations.length} DEP-006 config-contract invariant(s):`);
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exit(1);
  }

  console.log("OK: docker-compose.staging.yml satisfies the DEP-006 staging config contract");
  console.log("    (8 services: migrate one-shot + 2 control-plane + 4 workers + 1 adapter-manager,");
  console.log("     split into two failure domains (domain-a/domain-b: 1 CP + 2 workers each),");
  console.log("     external DB/object-store/realtime/admission as x-external pointers,");
  console.log("     migration-first depends_on gate, N/N-1 rollout policy, bounded worker drain,");
  console.log("     bounded autoscaling, shared DEP-009 admission with no process-local fallback).");
  console.log("");
  console.log("    Provider-control boundary: E2B_API_KEY is injected (rotatable) ONLY into the");
  console.log("    adapter-management surface on provider-ctl-net, and is ABSENT from every");
  console.log("    control-plane / worker / migrate surface. Rotation/revocation/old-key-denial");
  console.log("    rehearsal is contracted against DEP-008 + deferred to CLI-001/D2 (crosswalk CM-010/CM-012).");
}

main();
