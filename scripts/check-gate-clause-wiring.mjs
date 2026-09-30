#!/usr/bin/env node
// An epic gate clause may not claim a capability whose production path has no caller.
//
// See `scripts/lib/gate-clause-wiring.mjs` for why. Short version: the 2026-08-25 exit-gate
// audit found 17 gate clauses across E0..E11 whose named production path has ZERO callers —
// inside epics reported `complete`. Every ticket doc was honest; the aggregation was not.
// This gives "epic complete" a mechanical meaning it did not have.
//
// Usage:
//   node scripts/check-gate-clause-wiring.mjs
//   node scripts/check-gate-clause-wiring.mjs --counts   # print measured caller counts

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  evaluateGateClauseWiring,
  evaluateProviderCapabilityClaims,
  providerCapabilityClaimKey,
} from "./lib/gate-clause-wiring.mjs";

export const MANIFEST_RELATIVE_PATH = "scripts/gate-clause-wiring.json";

/** Source roots that constitute PRODUCTION. Tests are excluded by `isTestPath`. */
const SOURCE_ROOTS = ["server/src", "packages", "cli"];

const TEST_MARKERS = ["__tests__", ".test.", ".spec.", "/tests/", "\\tests\\", "/testing/", "\\testing\\"];

export function isTestPath(rel) {
  const n = rel.replaceAll("\\", "/");
  return TEST_MARKERS.some((m) => n.includes(m.replaceAll("\\", "/")));
}

/** Strip block and line comments so a symbol NAMED IN A COMMENT is never counted as a call.
 * This repo has mistaken a comment for a call site more than once — including a comment
 * whose entire content was "this function has zero callers". */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * W5U1 — strip the CONTENTS of string literals, for exactly the reason comments are stripped.
 *
 * ★ WHY. `stripComments`'s own docstring records that this repo "has mistaken a comment for a
 * call site more than once — including a comment whose entire content was 'this function has
 * zero callers'". The same sentence, one quoting style over, was still being counted:
 * `createResultCommitter`'s ONLY non-test, non-comment, non-re-export reference in the entire
 * tree is the STRING at `server/src/services/e7-distributed-run-verifier.ts:513`, whose text is
 * *"buildWorkspacePatch/createResultCommitter have zero production callers"*. The guard read
 * that as a production caller. `createSupervisor` was inflated the same way: 2 of its 4
 * references are its own `throw new Error("createSupervisor: …")` messages.
 *
 * A count of 0 is the guard's only DEFINITIVE verdict, so anything that manufactures a
 * phantom non-zero is a direct attack on the one thing it can prove.
 *
 * ★ SHAPE, and why it is a scanner rather than a regex. Quotes nest inside each other and
 * template literals carry REAL CODE in `${…}` — a regex cannot tell `` `${createSupervisor()}` ``
 * (a genuine reference) from `"createSupervisor: bad"` (prose). So:
 *   - `"…"` / `'…'` — contents dropped, DELIMITERS KEPT. Keeping the quotes matters: the caller
 *     blanks `import … from "…"` before calling this, and an emptied quote pair would break a
 *     later reader's expectations for no gain.
 *   - a quote with no closer ON ITS LINE is treated as not-a-string and abandoned at the newline.
 *     JS string literals cannot contain a raw newline, so this BOUNDS any mis-detection (an
 *     apostrophe in surviving prose, a quote inside a regex literal) to a single line instead of
 *     letting it eat the rest of the file. Under-stripping over-counts, which is the safe
 *     direction for this guard; over-stripping could fake a zero, which is not.
 *   - `` `…` `` — literal text dropped, `${…}` interpolations COPIED VERBATIM (brace-depth
 *     tracked), and newlines preserved so line structure survives for the caller's line scan.
 *
 * Deliberately NOT recursive: a string inside a `${…}` is copied through unstripped. That
 * over-counts rather than under-counts, and the case does not occur in this tree.
 */
export function stripStringLiterals(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      out += ch;
      i += 1;
      while (i < n && text[i] !== ch && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      if (i < n && text[i] === ch) {
        out += ch;
        i += 1;
      }
      continue;
    }
    if (ch === "`") {
      out += ch;
      i += 1;
      while (i < n) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === "`") {
          out += "`";
          i += 1;
          break;
        }
        if (text[i] === "$" && text[i + 1] === "{") {
          out += "${";
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            const c = text[i];
            if (c === "{") depth += 1;
            else if (c === "}") depth -= 1;
            out += c;
            i += 1;
          }
          continue;
        }
        if (text[i] === "\n") out += "\n";
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function* walk(root) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      yield* walk(full);
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

/**
 * Count PRODUCTION references to `symbol`, excluding test paths, comments, the definition
 * itself, `import` statements, and re-export blocks — including MULTI-LINE ones. A barrel
 * that lists the symbol on its own line is exactly how several of the 17 looked "used".
 *
 * ★ WHAT THIS MEASURES, STATED HONESTLY. A count of 0 is DEFINITIVE: nothing outside a test
 * so much as mentions the symbol, so no production path can reach it. A count > 0 is
 * NECESSARY BUT NOT SUFFICIENT for reachability — the referencing code may itself be
 * unreachable. `runBrowserSession` is precisely that case: `runner.ts` genuinely calls it,
 * but nothing invokes `runner.ts`, because no package depends on `browser-runtime` at all.
 * Proving full boot-root reachability needs an import-graph walk this guard deliberately
 * does not attempt — inferring it cheaply is the kind of guess that has been wrong here
 * before. So the guard catches the zero case with certainty and the `reason` field carries
 * the rest.
 */
export function countProductionCallers(root, symbol) {
  let count = 0;
  const definition = new RegExp(
    `(export\\s+)?(async\\s+)?(function|class|const|let|interface|type)\\s+${symbol}\\b`,
  );
  const use = new RegExp(`\\b${symbol}\\b`);
  for (const rootDir of SOURCE_ROOTS) {
    for (const file of walk(path.join(root, rootDir))) {
      const rel = path.relative(root, file);
      if (isTestPath(rel)) continue;
      const text = stripComments(readFileSync(file, "utf8"));
      // Blank out every import statement and every re-export block BEFORE scanning lines.
      // Doing it over the whole file — not line by line — is what makes multi-line work.
      //
      // ★ ORDER IS LOAD-BEARING. String stripping runs AFTER this, never before: both
      // expressions match a module SPECIFIER (`from "…"`), and an already-emptied
      // `from ""` fails `["'][^"']+["']`, so stripping first would un-blank every import
      // in the tree and inflate the count instead of correcting it.
      const scannable = stripStringLiterals(
        text
          .replace(/import\s[\s\S]*?from\s*["'][^"']+["']\s*;?/g, "")
          .replace(/export\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["']\s*;?/g, ""),
      );
      for (const line of scannable.split(/\r?\n/)) {
        if (!use.test(line)) continue;
        if (definition.test(line)) continue;
        count += 1;
      }
    }
  }
  return count;
}

/**
 * W4U1 — read the literal a source file assigns to a class-property declaration.
 *
 * Returns the string literal, `null` when the file declares the property nowhere (or does
 * not exist), or an ARRAY of the distinct literals when it declares it more than once — an
 * ambiguity the caller must refuse rather than pick a winner from.
 *
 * Comments are stripped FIRST, using the same `stripComments` the caller-count above uses,
 * and for the same reason: `e2b-provider.ts` carries a doc comment that still says
 * `artifactExportMode` is "honestly `none`" three lines below the declaration that says
 * `"grant_upload"`. Reading a comment as a declaration would have made this guard certify
 * the very string it exists to refuse.
 *
 * `=(?!=)` excludes `if (this.artifactExportMode === "none")` — a comparison, not a
 * declaration. Both shipped providers contain that exact line.
 */
export function readDeclaredPropertyLiteral(root, file, property) {
  const abs = path.join(root, file);
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  const text = stripComments(readFileSync(abs, "utf8"));
  const pattern = new RegExp(
    "\\b" + property + "\\b\\s*(?::[^=\\n;]*)?=(?!=)\\s*[\"']([^\"']+)[\"']",
    "g",
  );
  const values = new Set();
  for (const match of text.matchAll(pattern)) values.add(match[1]);
  if (values.size === 0) return null;
  if (values.size > 1) return [...values].sort();
  return [...values][0];
}

const ROOT = process.cwd();
const manifestPath = path.join(ROOT, MANIFEST_RELATIVE_PATH);
const declared = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, "utf8")).clauses ?? {})
  : {};

const symbols = [...new Set(Object.values(declared).map((e) => e && e.symbol).filter(Boolean))];
const callerCounts = Object.fromEntries(symbols.map((s) => [s, countProductionCallers(ROOT, s)]));

if (process.argv.includes("--counts")) {
  for (const s of symbols.sort()) console.log(`  ${String(callerCounts[s]).padStart(3)}  ${s}`);
  process.exit(0);
}

const result = evaluateGateClauseWiring({ declared, callerCounts });

// W4U1 — measure the source side of every declared provider-capability claim.
const sourceValues = {};
for (const entry of Object.values(declared)) {
  if (!entry || !Array.isArray(entry.providerCapabilityClaims)) continue;
  for (const claim of entry.providerCapabilityClaims) {
    if (!claim || typeof claim.file !== "string" || typeof claim.property !== "string") continue;
    sourceValues[providerCapabilityClaimKey(claim)] = readDeclaredPropertyLiteral(
      ROOT,
      claim.file,
      claim.property,
    );
  }
}
const claims = evaluateProviderCapabilityClaims({ declared, sourceValues });

const EXPLAIN = {
  claimed_wired_but_no_caller: "declared WIRED but nothing in production calls it — the capability cannot run",
  unwired_but_now_has_caller: "declared unwired but it now HAS a caller — promote it to wired",
  malformed_declaration: "entry needs status wired|unwired, a symbol, and (if unwired) a reason",
  symbol_not_measured: "internal: the symbol was not measured",
  malformed_input: "internal: the guard was handed something it could not read",
  capability_claim_source_mismatch:
    "the register's claim about a provider capability no longer matches the source that declares it",
  capability_claim_source_missing: "the register names a capability the cited file does not declare",
  capability_claim_source_ambiguous:
    "the cited file declares the capability more than once — the guard refuses to pick a winner",
  capability_claim_absent_from_reason:
    "the structured claim and the clause's prose disagree — the sentence never states the declared value",
  capability_claim_unbacked_in_reason:
    "the clause's prose asserts a capability value no claim on this clause declares",
  capability_claim_undeclared:
    "the clause's prose names a watched provider capability with no `providerCapabilityClaims` entry to check it",
  capability_claim_not_measured: "internal: the claim's source value was not measured",
  malformed_capability_claim: "a `providerCapabilityClaims` entry needs file, property and expect",
};

if (!claims.ok) {
  console.error(
    "gate-clause-wiring: a register claim about provider capability does not match the source.\n",
  );
  for (const p of claims.problems) {
    console.error(`  - ${p.clause}: ${EXPLAIN[p.kind] ?? p.kind}${p.detail ? ` (${p.detail})` : ""}`);
  }
  console.error(
    "\nA `reason` that describes SOURCE must be checked against source. `E5-2`'s said BOTH\n" +
      "shipped providers declared artifactExportMode=none for weeks after PR #353 changed one\n" +
      "of them, because nothing read it. Update the claim AND the sentence together, or, if the\n" +
      "source really did change, say so in the reason — but do not leave them disagreeing.",
  );
  process.exit(1);
}

if (!result.ok) {
  console.error("gate-clause-wiring: a gate clause claims a capability its code cannot deliver.\n");
  for (const p of result.problems) {
    console.error(`  - ${p.clause}: ${EXPLAIN[p.kind] ?? p.kind}${p.detail ? ` (${p.detail})` : ""}`);
  }
  console.error(
    "\nA gate clause names a capability; a ticket delivers the mechanism; this checks that a\n" +
      "production path actually reaches it. Declare `unwired` with a reason if it is honestly\n" +
      "dormant — that is allowed and reported. What is not allowed is claiming it works.",
  );
  process.exit(1);
}

console.log(
  `gate-clause-wiring: OK (${result.wiredCount} wired clause(s), ${result.unwired.length} declared dormant, ` +
    `${claims.claimCount} provider-capability claim(s) matched to source)`,
);
if (result.unwired.length > 0) {
  // Printed on a GREEN run, deliberately: a dormant capability must stay visible rather
  // than passing silently as complete. This is the line the exit-gate audit had to
  // reconstruct by hand across ~70 clauses.
  console.log(`  DORMANT, on the record: ${result.unwired.join(", ")}`);
}
