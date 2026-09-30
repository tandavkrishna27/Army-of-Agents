#!/usr/bin/env node
/**
 * check-guard-inventory.mjs
 *
 * A CHECK THAT NOTHING RUNS IS NOT A CHECK.
 *
 * REL-004 found three fail-closed admission verifiers with no caller, and two documents
 * asserting an enforcement that never happened. This guard generalizes that fix from
 * functions to executables: every `scripts/check-*` and `scripts/verify-*` must declare
 * whether anything runs it, in `scripts/guard-inventory.json`, and the declaration is
 * verified against the tree on every PR.
 *
 * The declaration is a human's, not an inference. During the reconnaissance five
 * successive greps each got this wrong in both directions — a shell script that ECHOED a
 * name read as an invocation, and `node /app/scripts/x.mjs` read as absent. This only
 * confirms the easy direction, which is enough to catch what bites: a script quietly
 * dropped from CI while its entry, and everyone's belief, stays behind.
 *
 * Usage:
 *   node scripts/check-guard-inventory.mjs
 *   node scripts/check-guard-inventory.mjs --write   # propose entries for new scripts
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { evaluateGuardInventory } from "./lib/guard-inventory.mjs";

export const MANIFEST_RELATIVE_PATH = "scripts/guard-inventory.json";

const GUARD_NAME = /^(check|verify)-.+\.mjs$/;
const IS_TEST = /\.test\.mjs$/;

export function findGuardScripts(root) {
  return readdirSync(path.join(root, "scripts"))
    .filter((name) => GUARD_NAME.test(name) && !IS_TEST.test(name))
    .map((name) => `scripts/${name}`)
    .sort();
}

/**
 * Every surface an invocation can live on. `package.json` matters as much as a workflow:
 * `check-bundled-snapshot-inputs.mjs` runs from a `prebuild` script, and CI runs
 * `pnpm build` — so it is genuinely on the path even though no workflow names it.
 */
export function readInvocationText(root) {
  let packageText = "";
  try {
    packageText = readFileSync(path.join(root, "package.json"), "utf8");
  } catch {
    packageText = "";
  }
  return [readWorkflowText(root), packageText].join("\n");
}

export function readWorkflowText(root) {
  const dir = path.join(root, ".github", "workflows");
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n));
  } catch {
    return "";
  }
  return names.map((n) => readFileSync(path.join(dir, n), "utf8")).join("\n");
}

/** Test files anywhere under scripts/, so a `provenTest` reference can be confirmed. */
export function findTestFiles(root) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(childRel);
      } else if (IS_TEST.test(entry.name)) {
        out.push(childRel);
      }
    }
  };
  walk("scripts");
  return out;
}

function describe(problem) {
  const { kind, script, detail } = problem;
  switch (kind) {
    case "undeclared_script":
      return `${script}: no entry in ${MANIFEST_RELATIVE_PATH} — say what runs it`;
    case "stale_declaration":
      return `${script}: declared but no longer exists — remove the entry`;
    case "not_in_workflows":
      return `${script}: declared "ci" but no workflow invokes it`;
    case "proven_test_missing":
      return `${script}: names a provenTest that does not exist (${detail})`;
    case "proven_test_not_in_workflows":
      return `${script}: names a provenTest that no workflow runs (${detail})`;
    case "malformed_declaration":
      return `${script}: malformed entry (${detail ?? "status/reason"})`;
    default:
      return `${script ?? "(manifest)"}: ${kind}`;
  }
}

function main(argv) {
  const root = process.cwd();
  const scripts = findGuardScripts(root);
  const invocationText = readInvocationText(root);
  const testFiles = findTestFiles(root);
  const manifestPath = path.join(root, MANIFEST_RELATIVE_PATH);

  let declared = {};
  try {
    declared = JSON.parse(readFileSync(manifestPath, "utf8")).scripts ?? {};
  } catch (error) {
    if (!argv.includes("--write")) {
      console.error(`guard-inventory: cannot read ${MANIFEST_RELATIVE_PATH} — ${error.message}`);
      return 1;
    }
  }

  if (argv.includes("--write")) {
    const next = {};
    for (const script of scripts) {
      if (declared[script]) {
        next[script] = declared[script];
        continue;
      }
      // A NEW script is proposed as `ci` only if a workflow already names it. Everything
      // else is left deliberately invalid, so `--write` cannot quietly classify a script
      // nobody runs as fine.
      const base = script.split("/").pop();
      const invoked = invocationText.split(/\r?\n/).some(
        (l) => !l.trim().startsWith("#") && l.includes(base),
      );
      next[script] = invoked
        ? { status: "ci", reason: "invoked by a workflow" }
        : { status: "REVIEW", reason: "" };
      console.log(`${invoked ? "added ci" : "NEEDS REVIEW"}: ${script}`);
    }
    writeFileSync(manifestPath, `${JSON.stringify({ scripts: next }, null, 2)}\n`, "utf8");
    console.log(`wrote ${MANIFEST_RELATIVE_PATH} (${Object.keys(next).length} scripts)`);
    return 0;
  }

  const { ok, problems } = evaluateGuardInventory({ scripts, declared, invocationText, testFiles });
  if (ok) {
    console.log(`guard-inventory: OK (${scripts.length} guard scripts, all accounted for)`);
    return 0;
  }
  console.error("guard-inventory: a guard's declaration does not match the tree.\n");
  for (const problem of problems) console.error(`  - ${describe(problem)}`);
  console.error(
    "\nStatuses: ci (a workflow runs it) | ci_logic_only (a named self-test runs; the CLI" +
      "\nis idle) | dormant (nothing runs it — say why). A check nothing runs is not a check.",
  );
  return 1;
}

if (process.argv[1]?.endsWith("check-guard-inventory.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
