#!/usr/bin/env node
// A REGISTER ID MUST NAME ONE THING.
//
// See `scripts/lib/register-id-uniqueness.mjs` for why this exists. Short version: on
// 2026-09-03 this repo had two live duplicate-id defects at once — `## Decision #104` twice
// in the locked-decisions register (cited as load-bearing in FOUR places in CLAUDE.md), and
// `## E1-F008` twice in one findings register, both severity HIGH, where the ownership
// guard keys by id and one silently shadowed the other. Nothing anywhere asked the question.
//
// Usage:
//   node scripts/check-register-id-uniqueness.mjs

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  evaluateIdUniqueness,
  extractHeadingIds,
  FINDING_HEADING,
  DECISION_HEADING,
  EPIC_DECISION_HEADING,
  DECISION_TABLE_ROW,
  DA_HEADING,
  DECISION_REVISION,
  DECISION_REVISION_BODY,
  FINDING_ID_RANGE_HEADING,
} from "./lib/register-id-uniqueness.mjs";

const EPICS_RELATIVE_PATH = "docs/replatform/epics";
const DECISIONS_RELATIVE_PATH = "docs/architecture/decisions.md";
export const WAIVER_RELATIVE_PATH = "scripts/register-id-duplicates.json";

/** Duplicates a human has seen and owes a decision on. Missing file = no waivers, which is
 * the correct default: the guard must fail on an unknown duplicate, never pass on one. */
export function loadWaivers(root) {
  const file = path.join(root, WAIVER_RELATIVE_PATH);
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return parsed && typeof parsed === "object" && parsed.duplicates ? parsed.duplicates : {};
}

/** Every register this guard reads, as {file, kind, pattern}.
 *
 * ★ `decisions.md` contributes THREE sources, not one. Its decisions are written in three
 * shapes — 91 as `| N | … |` table rows, 27 as `### DA-N:` headings, 35 as `## Decision #N`
 * headings — and the first version of this guard read only the last, i.e. 35 of 153 ids.
 * The table rows and the `## Decision #N` headings share the SAME `decision` namespace
 * (they are one continuous numbering: rows are 1-91, headings run 14 and 92-125), so a
 * heading colliding with its own table entry is caught. `DA-N` is a separate namespace. */
export function findSourceFiles(root) {
  const out = [];
  if (existsSync(path.join(root, DECISIONS_RELATIVE_PATH))) {
    out.push({ file: DECISIONS_RELATIVE_PATH, kind: "decision", pattern: DECISION_HEADING, skipGenuineRevisions: true });
    out.push({ file: DECISIONS_RELATIVE_PATH, kind: "decision", pattern: DECISION_TABLE_ROW });
    out.push({ file: DECISIONS_RELATIVE_PATH, kind: "da-decision", pattern: DA_HEADING });
  }
  const epics = path.join(root, EPICS_RELATIVE_PATH);
  if (!existsSync(epics)) return out;
  for (const entry of readdirSync(epics, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    // Findings are checked GLOBALLY, not per register: the ids are epic-prefixed, so a
    // cross-register collision is a defect too, and the ownership guard's own map is global.
    const findings = `${EPICS_RELATIVE_PATH}/${entry.name}/findings.md`;
    if (existsSync(path.join(root, findings))) {
      out.push({ file: findings, kind: "finding", pattern: FINDING_HEADING });
    }
    // Epic-scoped decisions are namespaced per epic by their own prefix (E2-D01), so the
    // same global treatment is correct and catches a prefix typo as a bonus.
    const decisions = `${EPICS_RELATIVE_PATH}/${entry.name}/decisions.md`;
    if (existsSync(path.join(root, decisions))) {
      out.push({ file: decisions, kind: "epic-decision", pattern: EPIC_DECISION_HEADING });
    }
  }
  return out;
}

export function collectSources(root) {
  // Only headings that pass BOTH revision gates are withheld from the definition count.
  // A heading in the documented shape whose body does NOT declare the revision is therefore
  // still counted as a definition, and collides — the safe direction.
  const genuineRevisionLines = new Set(collectRevisions(root).map((r) => `${r.file}:${r.line}`));
  return findSourceFiles(root).map(({ file, kind, pattern, skipGenuineRevisions }) => ({
    file,
    kind,
    ids: extractHeadingIds(readFileSync(path.join(root, file), "utf8"), pattern, {
      skipLine: skipGenuineRevisions ? (line) => genuineRevisionLines.has(`${file}:${line}`) : undefined,
    }),
  }));
}

/** `## Decision #14 (revised …)` restates an existing decision rather than defining a new
 * one, so it is excluded from the uniqueness count — and then checked here, because an
 * exclusion nobody validates is a hole. */
export function collectRevisions(root) {
  const file = DECISIONS_RELATIVE_PATH;
  if (!existsSync(path.join(root, file))) return [];
  const text = readFileSync(path.join(root, file), "utf8");
  // GATE 2: the BODY must declare the revision too. A heading in the right shape is not
  // enough — see DECISION_REVISION's header for why one gate was demonstrably not enough.
  // A heading that passes gate 1 but not gate 2 is NOT collected here AND is not skipped by
  // the definition extractor, so it lands in the uniqueness count and collides. Fail-closed.
  const blocks = text.split(/\n(?=#{2,4}\s)/);
  const declaresRevision = new Set();
  for (const block of blocks) {
    const heading = DECISION_REVISION.exec(block.split("\n")[0]);
    if (heading && DECISION_REVISION_BODY.test(block)) declaresRevision.add(heading[1]);
  }
  return extractHeadingIds(text, DECISION_REVISION)
    .filter((r) => declaresRevision.has(r.id))
    .map((r) => ({ ...r, file, kind: "decision" }));
}

/** Findings-register headings that name a RANGE of ids. Refused — see
 * FINDING_ID_RANGE_HEADING for why teaching the form is worse than refusing it. */
export function collectRangeHeadings(root) {
  const out = [];
  for (const { file, kind } of findSourceFiles(root)) {
    if (kind !== "finding") continue;
    const lines = readFileSync(path.join(root, file), "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const m = FINDING_ID_RANGE_HEADING.exec(lines[i]);
      if (m) out.push({ file, line: i + 1, from: m[1], to: m[2] });
    }
  }
  return out;
}

const ROOT = process.cwd();
const sources = collectSources(ROOT);
const result = evaluateIdUniqueness({
  sources,
  revisions: collectRevisions(ROOT),
  rangeHeadings: collectRangeHeadings(ROOT),
  waived: loadWaivers(ROOT),
});

if (!result.ok) {
  console.error("register-id-uniqueness: an id names more than one thing.\n");
  for (const problem of result.problems) {
    if (problem.kind === "duplicate_id") {
      console.error(`  - ${problem.id} is DEFINED TWICE — ${problem.detail}`);
    } else if (problem.detail) {
      console.error(`  - ${problem.kind}: ${problem.id ?? "(input)"} — ${problem.detail}`);
    } else {
      console.error(`  - ${problem.kind}`);
    }
  }
  console.error(
    "\nA duplicate id is not a cosmetic clash. The ownership guard keys findings by id, so\n" +
      "one entry silently SHADOWS the other and stops existing for every check. A citation of\n" +
      "a duplicated decision number resolves to a coin flip.\n\n" +
      "Renumbering is a HUMAN decision, not a mechanical one — a LOCKED decision may be cited\n" +
      "from CLAUDE.md, from frozen ticket results, or from immutable QA/handoff records that\n" +
      "policy forbids rewriting. Work out which side each surviving citation MEANS, renumber\n" +
      "the side whose citations can move, and leave an alias note for the ones that cannot\n" +
      "(the E1-F008 -> E1-F009 split is the worked precedent).",
  );
  process.exit(1);
}

const summary = Object.keys(result.counts)
  .sort()
  .map((kind) => `${result.counts[kind]} ${kind}`)
  .join(", ");
console.log(`register-id-uniqueness: OK (${summary} across ${sources.length} register(s))`);
if (result.waived.length > 0) {
  // Printed on a GREEN run, deliberately — same reasoning as the ownership guard's UNOWNED
  // line. A known-and-undecided duplicate that nobody is reminded of is a forgotten one.
  console.log(`  DUPLICATE, awaiting a decision: ${result.waived.join(", ")}`);
  console.log(`  (see ${WAIVER_RELATIVE_PATH} for what each one is waiting on)`);
}
