#!/usr/bin/env node
// WRK-008 slice 2b Step 9a — the D1-dispatch declaration guard.
//
//   node scripts/check-d1-dispatch-declared.mjs
//
// Parses docker-compose.d1.yml with the dependency-free yaml-lite parser and asserts each D1
// worker's declared dispatch-gate posture (scripts/d1-dispatch-expectation.json) matches the
// compose file — in BOTH directions. Exits non-zero (printing the violations) on any divergence,
// or on an unparseable/empty compose file (fail closed).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { parseYaml } from "./lib/yaml-lite.mjs";
import { evaluateD1Dispatch } from "./lib/d1-dispatch-declared.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composePath = path.join(repoRoot, "docker-compose.d1.yml");
const expectationPath = path.join(repoRoot, "scripts", "d1-dispatch-expectation.json");

function main() {
  const expectation = JSON.parse(readFileSync(expectationPath, "utf8"));

  let compose;
  try {
    compose = parseYaml(readFileSync(composePath, "utf8"));
  } catch (err) {
    // A compose file the checker cannot parse is a BROKEN checker, never a pass.
    console.error(`check-d1-dispatch-declared: cannot parse docker-compose.d1.yml: ${err.message}`);
    process.exit(1);
    return;
  }
  const services = compose?.services;
  if (services === undefined || services === null || typeof services !== "object") {
    console.error("check-d1-dispatch-declared: docker-compose.d1.yml has no services map (fail closed)");
    process.exit(1);
    return;
  }

  const envByWorker = {};
  for (const worker of Object.keys(expectation.workers)) {
    const env = services[worker]?.environment;
    if (env !== undefined && env !== null && typeof env === "object") {
      // yaml-lite parses env values as strings; coerce to string for a stable compare.
      envByWorker[worker] = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)]));
    }
  }

  const violations = evaluateD1Dispatch(envByWorker, expectation);
  if (violations.length > 0) {
    console.error("check-d1-dispatch-declared FAILED — the D1 dispatch declaration does not match the compose file:");
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
    return;
  }
  console.log(`check-d1-dispatch-declared OK — ${Object.keys(expectation.workers).length} D1 worker(s), all dispatch gates as declared.`);
}

main();
