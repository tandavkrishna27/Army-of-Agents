#!/usr/bin/env node
/**
 * check-dependency-graph.mjs
 *
 * Turns the re-platform programme's dependency graph from prose into a checked
 * artifact, in the same idiom as `check-guard-inventory.mjs` and
 * `check-test-inventory.mjs`: "someone should notice" becomes "CI fails".
 *
 * HARD FAILURES (the unambiguous classes):
 *   * a `Depends on:` name that is neither a ticket nor a named gate, or a self-edge
 *   * a dependency cycle
 *   * a ticket heading with no `Depends on:` line at all
 *   * an UNDOMINATED crosswalk row with no declaration in `crosswalk-coverage.json`
 *   * a STALE declaration for a row that is no longer undominated
 *
 * The undominated-row check is the load-bearing one and the reason this script
 * exists; see the header of `lib/dependency-graph.mjs` for why the obvious
 * "every dependency name resolves" check would NOT have caught the defect that
 * motivated it.
 *
 * Usage: node scripts/check-dependency-graph.mjs
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { analyse } from "./lib/dependency-graph.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

export const PROGRAM_DESIGN = path.join("docs", "replatform", "program-design.md");
export const CROSSWALK = path.join("docs", "replatform", "current-main-crosswalk.md");
export const DECLARATIONS = path.join("scripts", "crosswalk-coverage.json");

export function runCheck(repoRoot = REPO) {
  const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
  const declarations = JSON.parse(read(DECLARATIONS));
  const declared = declarations.rows ?? {};

  const result = analyse({
    programDesign: read(PROGRAM_DESIGN),
    crosswalk: read(CROSSWALK),
    declared,
  });

  const problems = [];
  for (const entry of result.missingDependsOn) {
    problems.push(`${entry}: ticket heading has no "Depends on:" line`);
  }
  for (const entry of result.dangling) {
    problems.push(entry.kind === "self"
      ? `${entry.ticket}: depends on itself`
      : `${entry.ticket}: depends on "${entry.dependency}", which is not a ticket or a named gate`);
  }
  for (const entry of result.cycles) {
    problems.push(`${entry}: is part of a dependency cycle`);
  }
  for (const entry of result.undeclaredUndominated) {
    problems.push(
      `${entry.row}: no ticket transitively completes [${entry.tickets.join(", ")}] ` +
      `- the crosswalk binds them but the ticket graph does not. Declare it in ${DECLARATIONS} ` +
      `with a status, an owner and a reason, or add the missing dependency edge.`);
  }
  for (const entry of result.staleDeclarations) {
    problems.push(`${entry}: declared in ${DECLARATIONS} but is no longer undominated - remove the stale entry`);
  }

  // A parse that finds nothing has nothing to report either, which would make a
  // green run meaningless. Refuse to pass on an empty graph.
  if (result.ticketCount === 0) problems.push(`${PROGRAM_DESIGN}: parsed ZERO tickets - the parser or the document changed shape`);
  if (result.crosswalkRowCount === 0) problems.push(`${CROSSWALK}: parsed ZERO crosswalk rows - the parser or the document changed shape`);

  return { result, problems, declared };
}

function main() {
  let checked;
  try {
    checked = runCheck();
  } catch (error) {
    console.error(`dependency-graph: FAILED to run - ${error.message}`);
    process.exit(1);
  }
  const { result, problems, declared } = checked;

  if (problems.length > 0) {
    console.error("dependency-graph: FAIL");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  const open = Object.entries(declared).filter(([, value]) => value.status === "open_gap");
  console.log(
    `dependency-graph: OK (${result.ticketCount} tickets, ${result.crosswalkRowCount} crosswalk rows, ` +
    `0 dangling, 0 cycles, ${result.undominated.length} undominated rows all declared)`);
  if (open.length > 0) {
    console.log(`dependency-graph: ${open.length} DECLARED OPEN GAP(S) - these are recorded debt, not clean:`);
    for (const [id, value] of open) console.log(`  - ${id} (owner: ${value.owner})`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
