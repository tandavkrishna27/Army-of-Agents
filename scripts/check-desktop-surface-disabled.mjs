#!/usr/bin/env node
/**
 * check-desktop-surface-disabled.mjs — DSK-001 Lane C / I22 clauses 6 and 7.
 *
 * DSK-00 requires that desktop support be provably INERT while it is disabled. Most of
 * that closure is asserted in `server/src/__tests__/desktop-disabled.negative.test.ts`.
 * Two clauses cannot live there, because they are about the ABSENCE of things:
 *
 *   (6) `docs/deploy/distribution.md` still records that there is no desktop installer.
 *       A doc that quietly starts promising one is a shipping commitment nobody made.
 *
 *   (7) No route serves a desktop package, update, manifest or installer. This is the
 *       fourth negative surface `program-design.md` demands, and a unit test cannot
 *       assert it — you cannot import a route that does not exist. Only a sweep of the
 *       route tree can.
 *
 * WHY A SCRIPT AND NOT A GREP STEP. `docs/` and `ui/` are full of the word "desktop" in
 * an unrelated sense — responsive breakpoints, "desktop tier", "desktop width". A bare
 * grep guard would be either noise or, once someone silences the noise, nothing at all.
 * The logic here is narrow, pure, and has its own adversarial corpus
 * (`check-desktop-surface-disabled.test.mjs`), because a checker nobody has tried to
 * defeat is not a guard.
 *
 * Usage:
 *   node scripts/check-desktop-surface-disabled.mjs
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** The decision this pin protects: distribution.md's H.D1 row. */
export const DISTRIBUTION_DOC = ["docs", "deploy", "distribution.md"];

/**
 * The sentence that must survive. Matched on the two load-bearing halves rather than
 * byte-for-byte, so ordinary editing (bolding, a reflow, a trailing clause) does not
 * fail the build while a change of MEANING still does.
 */
export const REQUIRED_DOC_PHRASES = [/no desktop installer/i, /docker \+ npm only/i];

/** Route trees swept for a desktop distribution surface. */
export const ROUTE_ROOTS = [["server", "src", "routes"]];

/**
 * A path segment that would serve a desktop artifact. Deliberately NOT a bare "desktop"
 * match: the word is everywhere in an unrelated sense, and a checker that cries wolf gets
 * deleted. These are the shapes an actual distribution endpoint takes.
 */
const DESKTOP_ARTIFACT_ROUTE = new RegExp(
  [
    // "/desktop/download", "desktop-update", "desktop_manifest", "desktop/releases", …
    String.raw`desktop[-_/]?(package|update|manifest|installer|download|release|artifact)s?`,
    // …and the same pair the other way round: "/updates/desktop", "download/desktop".
    // The `s?` is not cosmetic: without it "/api/updates/desktop" slipped through,
    // because "update" cannot be followed by "s" in the separator class. The corpus
    // caught it, which is the whole reason this checker has one.
    String.raw`(package|update|manifest|installer|download|release|artifact)s?[-_/]?desktop`,
  ].join("|"),
  "i",
);

export class DesktopSurfaceError extends Error {}

/**
 * Clause 6. Returns problems; empty means the pin holds.
 * @param {string} text the contents of distribution.md
 */
export function checkDocPin(text) {
  const problems = [];
  for (const phrase of REQUIRED_DOC_PHRASES) {
    if (!phrase.test(text)) {
      problems.push(
        `docs/deploy/distribution.md no longer states ${phrase} — DSK-00 clause 6 pins the ` +
          "H.D1 decision that there is no desktop installer. If that decision has genuinely " +
          "changed, change it deliberately here and in the ticket, not by editing the doc.",
      );
    }
  }
  return problems;
}

/**
 * Clause 7. Returns problems; empty means no desktop distribution route exists.
 * @param {Array<{path: string, source: string}>} files
 */
export function checkNoDesktopRoutes(files) {
  const problems = [];
  for (const file of files) {
    // Strip comments first. A route file may legitimately EXPLAIN that no desktop
    // package route exists — flagging that explanation is the failure mode where a
    // checker forces you to delete the rationale for the thing it checks.
    const code = file.source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const line of code.split("\n")) {
      // Only route-registration lines, not any mention.
      if (!/\.(get|post|put|patch|delete|use)\s*\(/.test(line)) continue;
      if (DESKTOP_ARTIFACT_ROUTE.test(line)) {
        problems.push(
          `${file.path}: registers what looks like a desktop distribution route ` +
            `(${line.trim().slice(0, 100)}) — DSK-00 clause 7 requires that no desktop ` +
            "package, update, manifest or installer surface exists while desktop is disabled.",
        );
      }
    }
  }
  return problems;
}

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function collectRouteFiles(root) {
  const out = [];
  for (const segments of ROUTE_ROOTS) {
    const dir = path.join(root, ...segments);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const full = path.join(entry.parentPath ?? entry.path ?? dir, entry.name);
      out.push({
        path: path.relative(root, full).replaceAll("\\", "/"),
        source: fs.readFileSync(full, "utf8"),
      });
    }
  }
  return out;
}

export function runDesktopSurfaceCheck(root = repoRoot()) {
  const docPath = path.join(root, ...DISTRIBUTION_DOC);
  const problems = [];
  if (!fs.existsSync(docPath)) {
    problems.push(`${DISTRIBUTION_DOC.join("/")} is missing — DSK-00 clause 6 cannot be checked.`);
  } else {
    problems.push(...checkDocPin(fs.readFileSync(docPath, "utf8")));
  }
  const routeFiles = collectRouteFiles(root);
  if (routeFiles.length === 0) {
    // A sweep that found nothing to sweep proves nothing. Fail loudly rather than
    // reporting a clean bill of health for an empty set.
    problems.push("no route files were scanned — DSK-00 clause 7 would pass vacuously.");
  }
  problems.push(...checkNoDesktopRoutes(routeFiles));
  return { problems, scanned: routeFiles.length };
}

function main() {
  const { problems, scanned } = runDesktopSurfaceCheck();
  if (problems.length > 0) {
    console.error("desktop surface disabled: FAIL");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`desktop surface disabled: PASS (${scanned} route files scanned)`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href) {
  main();
}
