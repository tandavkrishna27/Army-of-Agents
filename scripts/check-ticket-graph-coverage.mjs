#!/usr/bin/env node
/**
 * check-ticket-graph-coverage.mjs — TRACK-001.
 *
 * FAILS when a ticket FILE exists whose id has no `#### ID` node in
 * `docs/replatform/program-design.md` — i.e. when the dependency graph that
 * `check-dependency-graph.mjs` reasons over has drifted behind the work.
 *
 * See `scripts/lib/ticket-graph-coverage.mjs` for why this is asymmetric (the reverse
 * direction is the backlog, not a defect) and why it is a failure mode that
 * `check-guard-inventory.mjs` cannot detect.
 *
 * Usage: node scripts/check-ticket-graph-coverage.mjs
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { evaluateTicketGraphCoverage } from "./lib/ticket-graph-coverage.mjs";

export const PROGRAM_DESIGN = path.join("docs", "replatform", "program-design.md");
export const EPICS_ROOT = path.join("docs", "replatform", "epics");

/** Every `*.md` basename under any `epics/<epic>/tickets/` directory. */
export function collectTicketFilenames(repoRoot) {
  const epics = path.join(repoRoot, EPICS_ROOT);
  if (!fs.existsSync(epics)) return [];
  const out = [];
  for (const epic of fs.readdirSync(epics)) {
    const tickets = path.join(epics, epic, "tickets");
    if (!fs.existsSync(tickets)) continue;
    for (const f of fs.readdirSync(tickets)) if (f.endsWith(".md")) out.push(f);
  }
  return out;
}

function main() {
  const repoRoot = process.cwd();
  const filenames = collectTicketFilenames(repoRoot);
  const authorityMarkdown = fs.readFileSync(path.join(repoRoot, PROGRAM_DESIGN), "utf8");
  const r = evaluateTicketGraphCoverage({ filenames, authorityMarkdown });

  // ★ ANTI-VACUITY. The way THIS guard fails silently is by finding nothing to check —
  // a moved directory, a changed layout, a glob that stops matching. It would then report
  // "OK" forever while checking zero tickets, which is the exact failure class it exists to
  // prevent. A tree with no ticket files and no graph nodes is not a healthy tree.
  if (r.fileIdCount === 0 || r.nodeCount === 0) {
    console.error(
      `ticket-graph-coverage: FOUND NOTHING TO CHECK (${r.fileIdCount} ticket ids from files, ` +
        `${r.nodeCount} graph nodes). That is a broken checker, not a clean tree.`,
    );
    process.exit(1);
  }

  if (r.uncovered.length > 0) {
    console.error("ticket-graph-coverage: ticket files exist that the dependency graph cannot see.\n");
    for (const id of r.uncovered) console.error(`  - ${id}: has ticket file(s) but no '#### ${id}' node in ${PROGRAM_DESIGN}`);
    console.error(
      `\n${r.uncovered.length} untracked. check-dependency-graph.mjs reasons over that graph, so\n` +
        `every reachability answer it gives is unsound while these are missing.\n` +
        `Add a '#### <ID>' section with a '**Depends on:**' line stating what is ACTUALLY true.\n` +
        `Do NOT invent edges to make a crosswalk row look dominated — a false ownership claim is\n` +
        `worse than a missing node.`,
    );
    process.exit(1);
  }

  console.log(
    `ticket-graph-coverage: OK (${r.fileIdCount} ticket ids from files, all present among ` +
      `${r.nodeCount} graph nodes; ${r.authorityOnly.length} planned-but-unbuilt ids in the ` +
      `authority, which is the backlog and not a failure)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-ticket-graph-coverage.mjs")) {
  main();
}
