#!/usr/bin/env node
// BRW-hostspawn-gate — the boot-root browser-spawn guard (driver).
//
//   node scripts/check-boot-roots-browser-spawn-free.mjs
//
// Commander/crew/org-agent runs spawn `@playwright/mcp` (`npx --headless`) as a HOST-side
// stdio MCP server whenever `browser_use` is enabled (buildMcpConfig, cli-mode.ts). E8's
// exit gate promises "no host-side browser spawn reachable from a boot root", which is false
// in fact today (E8 is backlog) and, before this guard, uncovered. This is the browser-spawn
// sibling of check-boot-roots-provider-free.mjs, in trackable-strict OWNED-DEFERRAL form: it
// enumerates host-spawn SITES (non-test source files under the config-writer scan roots whose
// text carries a host-browser-spawn signature, PLUS a per-file occurrence count), reads the
// deferral manifest, and delegates the verdict to the pure evaluator. It FAILS on: an
// undeclared spawn (a new file OR a SECOND spawn injected into the declared file — the count
// deviates), a stale/removed spawn whose deferral remains, a malformed declaration, an
// unreadable source, an absent manifest, or a vacuous scan (all fail closed). It does NOT
// close the spawn — closing is BRW-008 proper, gated on the governed browser-runtime path.
//
// The scan roots + the signature set are the small, named review surface. A new spawn package
// or a new host config-writer tree is a one-line, attributable diff here — not a silent gap.
// packages/browser-runtime is EXCLUDED (via EXCLUDED_SUBTREES) — it uses RAW Playwright, a
// different specifier, and the governed runtime must not be flagged. main() is GUARDED so the
// self-test can import the discovery layer without running the scan.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { evaluateBrowserSpawnFree } from "./lib/boot-roots-browser-spawn-free.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectationPath = path.join(repoRoot, "scripts", "browser-spawn-expectation.json");

// The source trees that materialize host-side stdio-MCP `command`/`args` from a control-plane
// boot root. server/src holds buildMcpConfig; the full `packages/` library surface holds the
// codex/opencode host config-writers (renderMcpBlock / toOpenCodeEntry) AND the SHARED
// MCP-spec library packages/adapter-utils (McpServerSpec / mergeExternalMcpServers) that
// cli-mode.ts itself imports — so a host `@playwright/mcp` spec relocated into any sibling
// package stays in scope. (A server/src + packages/adapters-only scan missed adapter-utils, a
// concrete boot-reachable evasion; scanning all of `packages/` closes the whole sibling class
// and is green at rest — nothing under packages/ carries the signature today.) The governed
// packages/browser-runtime is EXCLUDED below: it uses RAW Playwright (a different specifier,
// never the MCP package) and must not be flagged.
export const SCAN_ROOTS = ["server/src", "packages"];

// Subtrees skipped even though they sit under a scan root. packages/browser-runtime is the
// governed BRW-002 runtime (raw Playwright) — the one package the guard must never flag.
const EXCLUDED_SUBTREES = new Set(["packages/browser-runtime"]);

// The host-browser-spawn signature. Substrings, so a version bump of the literal does not
// blind the scan; the bare words `playwright`/`chromium` are deliberately EXCLUDED (they occur
// in governed config and reserved-name validation, neither of which is a host spawn).
export const SIGNATURES = ["@playwright/mcp", "PLAYWRIGHT_MCP_PACKAGE"];

// Directories never descended: build output, VCS, deps — and `__tests__`, whose files are
// out of scope (the behaviour-lock tests legitimately name the spawn).
const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build", "out", "coverage", "__tests__"]);

/** Total non-overlapping matches of any signature substring in `text`. */
export function countSignatureOccurrences(text, signatures) {
  let total = 0;
  for (const sig of signatures) {
    if (!sig) continue;
    total += text.split(sig).length - 1;
  }
  return total;
}

function isInScopeSourceFile(name) {
  if (!name.endsWith(".ts")) return false;
  // Exclude type-only decls and test files. `.spec.ts` matches the repo's own isTestFile
  // convention (scripts/lib/test-inventory.mjs) — a spec is a test, never boot-reachable, so
  // one legitimately naming the signature must not read as an undeclared host spawn.
  if (name.endsWith(".d.ts") || name.endsWith(".test.ts") || name.endsWith(".spec.ts")) return false;
  return true;
}

/**
 * Walk the scan roots and enumerate host-spawn SITES.
 * @returns {{foundSites: Array<{path: string, occurrences: number}>, unreadableSources: string[], scannedFileCount: number}}
 */
export function discoverHostSpawnSites(root, { scanRoots, signatures }) {
  const foundSites = [];
  const unreadableSources = [];
  let scannedFileCount = 0;

  for (const scanRoot of scanRoots) {
    const stack = [scanRoot];
    while (stack.length > 0) {
      const rel = stack.pop();
      let entries;
      try {
        entries = readdirSync(path.join(root, rel), { withFileTypes: true });
      } catch {
        continue; // a scan root (or subtree) that does not exist contributes nothing
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue; // never follow links out of the tree
        const childRel = `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRS.has(entry.name) && !EXCLUDED_SUBTREES.has(childRel)) stack.push(childRel);
          continue;
        }
        if (!entry.isFile() || !isInScopeSourceFile(entry.name)) continue;
        scannedFileCount += 1;
        let content;
        try {
          content = readFileSync(path.join(root, childRel), "utf8");
        } catch {
          unreadableSources.push(childRel); // fail closed in the evaluator (A2)
          continue;
        }
        const occurrences = countSignatureOccurrences(content, signatures);
        if (occurrences > 0) foundSites.push({ path: childRel, occurrences });
      }
    }
  }

  foundSites.sort((a, b) => a.path.localeCompare(b.path));
  unreadableSources.sort();
  return { foundSites, unreadableSources, scannedFileCount };
}

function main() {
  let expectation;
  try {
    expectation = JSON.parse(readFileSync(expectationPath, "utf8"));
  } catch {
    expectation = null; // absent/unreadable manifest → fail-closed sentinel (A0)
  }

  const { foundSites, unreadableSources, scannedFileCount } = discoverHostSpawnSites(repoRoot, {
    scanRoots: SCAN_ROOTS,
    signatures: SIGNATURES,
  });

  const violations = evaluateBrowserSpawnFree({
    foundSites,
    expectation,
    unreadableSources,
    scannedFileCount,
    signatures: SIGNATURES,
  });

  if (violations.length > 0) {
    console.error("check-boot-roots-browser-spawn-free FAILED:");
    for (const v of violations) console.error(`  - ${v}`);
    return 1;
  }
  console.log(
    `check-boot-roots-browser-spawn-free OK — scanned ${scannedFileCount} in-scope file(s), ` +
      `${foundSites.length} declared host-spawn site(s), no undeclared browser spawn reachable from a boot root.`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-boot-roots-browser-spawn-free.mjs")) {
  process.exit(main());
}
