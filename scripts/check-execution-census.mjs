#!/usr/bin/env node
/**
 * check-execution-census.mjs — TRACK-002.
 *
 * FAILS when a `*.test.mjs` file exists on disk with no entry in the census manifest, when
 * an entry is malformed or stale, when a declared step no longer exists or no longer names
 * the file, or when a package containing vitest specs is absent from vitest.config.ts's
 * hand-maintained `projects[]`.
 *
 * See scripts/lib/execution-census.mjs for why this is declaration-based rather than
 * observation-based, and — importantly — for the NAMED LIMIT of the `runs` direction. Do
 * not describe a green run here as proof that these files executed.
 *
 * Filesystem + YAML layer only; every verdict is delegated to the pure module.
 *
 * Usage:
 *   node scripts/check-execution-census.mjs
 *   node scripts/check-execution-census.mjs --write   # scaffold entries for new files
 */

import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { evaluateExecutionCensus } from "./lib/execution-census.mjs";

export const MANIFEST_RELATIVE_PATH = "scripts/test-execution-census.json";
const SEARCH_ROOTS = ["scripts", "docker"];
const EXCLUDED = new Set(["node_modules", ".git", "dist", "coverage", ".pnpm-store"]);

/**
 * Find every `*.test.mjs`. Uses `withFileTypes` so a Dirent's lstat semantics keep the walk
 * out of symlinks — the same property `check-test-inventory.mjs` documents, and for the same
 * reason: a walk that follows links counts files outside the repository.
 */
export function findMjsTests(repoRoot) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(repoRoot, rel);
    if (!existsSync(abs)) return;
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      if (d.isSymbolicLink()) continue;
      const child = `${rel}/${d.name}`;
      if (d.isDirectory()) {
        if (!EXCLUDED.has(d.name)) walk(child);
      } else if (d.isFile() && d.name.endsWith(".test.mjs")) {
        out.push(child);
      }
    }
  };
  for (const r of SEARCH_ROOTS) walk(r);
  return out.sort();
}

/**
 * Extract each workflow step's `run:` block, keyed "<workflow basename>::<step name>".
 *
 * A deliberately small line-based parser rather than a YAML dependency: the sibling guards
 * in this directory are dependency-free, and the shape consumed here is narrow (a `- name:`
 * followed later by `run: |` and an indented block).
 */
export function collectStepRunText(repoRoot) {
  const dir = path.join(repoRoot, ".github", "workflows");
  const map = new Map();
  if (!existsSync(dir)) return map;
  for (const wf of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const lines = readFileSync(path.join(dir, wf), "utf8").split(/\r?\n/);
    let step = null;
    let runIndent = null;
    let buf = [];
    const flush = () => {
      if (step && buf.length) map.set(`${wf}::${step}`, buf.join("\n"));
      buf = [];
      runIndent = null;
    };
    for (const line of lines) {
      const name = /^\s*-\s+name:\s*(.+?)\s*$/.exec(line);
      if (name) {
        flush();
        step = name[1].replace(/^["']|["']$/g, "");
        continue;
      }
      const run = /^(\s*)run:\s*(.*)$/.exec(line);
      if (run && step) {
        flush();
        const rest = run[2].trim();
        // ★ BOTH FORMS. A first cut handled only the block form (`run: |`) and silently
        // produced FOUR FALSE `unrun` declarations for steps written as a single line
        // (`run: node --test scripts/x.test.mjs`). It was caught only because the count
        // disagreed with an independently derived baseline — a false excuse is the worst
        // output this guard can produce, since it retires a real test with a reason.
        if (rest === "" || rest === "|" || rest === ">" || /^[|>][-+]?\d*$/.test(rest)) {
          runIndent = run[1].length;
        } else {
          map.set(`${wf}::${step}`, rest);
        }
        continue;
      }
      if (runIndent !== null) {
        if (line.trim() === "") { buf.push(""); continue; }
        const indent = line.length - line.trimStart().length;
        if (indent > runIndent) buf.push(line);
        else flush();
      }
    }
    flush();
  }
  return map;
}

/** The hand-maintained `projects[]` from vitest.config.ts. */
export function readVitestProjects(repoRoot) {
  const p = path.join(repoRoot, "vitest.config.ts");
  if (!existsSync(p)) return [];
  const m = /projects:\s*\[([\s\S]*?)\]/.exec(readFileSync(p, "utf8"));
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}

/**
 * Every package owning its own `vitest.config.ts`.
 *
 * A second, independent discovery axis. The spec-suffix walk below misses a package whose
 * suite is named `*.spec.ts` (one exists, and had never run); keying on the config file
 * catches it without dragging in the playwright `.spec.ts` trees, which own a
 * playwright.config.ts and no vitest config.
 */
export function findVitestConfigPackages(repoRoot) {
  const found = [];
  const walk = (rel, depth) => {
    if (depth > 6) return;
    const abs = path.join(repoRoot, rel);
    if (!existsSync(abs)) return;
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    if (entries.some((d) => d.isFile() && d.name === "vitest.config.ts")) found.push(rel);
    for (const d of entries) {
      if (d.isDirectory() && !d.isSymbolicLink() && !EXCLUDED.has(d.name)) walk(`${rel}/${d.name}`, depth + 1);
    }
  };
  for (const r of ["packages", "server", "ui", "cli"]) walk(r, 0);
  return found.sort();
}

/** Every package (nearest ancestor with a package.json) containing at least one vitest spec. */
export function findPackagesWithSpecs(repoRoot) {
  const found = new Set();
  const walk = (rel, depth) => {
    if (depth > 6) return;
    const abs = path.join(repoRoot, rel);
    if (!existsSync(abs)) return;
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    const hasSpec = entries.some((d) => d.isFile() && /\.test\.tsx?$/.test(d.name));
    if (hasSpec) {
      let cur = rel;
      while (cur && cur !== ".") {
        if (existsSync(path.join(repoRoot, cur, "package.json"))) { found.add(cur); break; }
        cur = path.dirname(cur).replace(/\\/g, "/");
      }
    }
    for (const d of entries) {
      if (d.isDirectory() && !d.isSymbolicLink() && !EXCLUDED.has(d.name)) walk(`${rel}/${d.name}`, depth + 1);
    }
  };
  for (const r of ["packages", "server", "ui", "cli", "tests"]) walk(r, 0);
  return [...found].sort();
}

function main() {
  const repoRoot = process.cwd();
  const manifestPath = path.join(repoRoot, MANIFEST_RELATIVE_PATH);
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { files: {} };

  const mjsTestFiles = findMjsTests(repoRoot);

  if (process.argv.includes("--write")) {
    const files = { ...(manifest.files || {}) };
    for (const f of mjsTestFiles) {
      if (!files[f]) files[f] = { status: "unrun", reason: "TODO: wire it, or say what would have to change" };
    }
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, files }, null, 2)}\n`, "utf8");
    console.log(`wrote ${MANIFEST_RELATIVE_PATH} (${Object.keys(files).length} entries) — review every scaffolded reason`);
    return;
  }

  const r = evaluateExecutionCensus({
    mjsTestFiles,
    manifest,
    stepRunText: collectStepRunText(repoRoot),
    vitestProjects: readVitestProjects(repoRoot),
    packagesWithSpecs: findPackagesWithSpecs(repoRoot),
    vitestConfigPackages: findVitestConfigPackages(repoRoot),
  });

  if (!r.ok) {
    console.error("execution-census: the tree and the census manifest disagree.\n");
    for (const p of r.problems) console.error(`  - [${p.kind}] ${p.file ?? ""} ${p.detail}`);
    console.error(
      `\n${r.problems.length} problem(s). A test file that nothing runs is not coverage —\n` +
        `wire it, or declare it 'unrun' with a reason saying what would have to change.\n` +
        `\`node ${path.posix.join("scripts", "check-execution-census.mjs")} --write\` scaffolds entries; the reasons are yours to write.`,
    );
    process.exit(1);
  }

  const c = r.counts;
  console.log(
    `execution-census: OK (${c.onDisk} *.test.mjs on disk, ${c.runs} declared running, ${c.unrun} declared unrun; ` +
      `${c.packagesWithSpecs} packages with vitest specs and ${c.vitestConfigPackages} owning a vitest config, ` +
      `all present among ${c.vitestProjects} projects). ` +
      `NOTE: 'runs' means the declaration still matches the tree, NOT observed execution — see lib header.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-execution-census.mjs")) {
  main();
}
