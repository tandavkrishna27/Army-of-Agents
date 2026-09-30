#!/usr/bin/env node
/**
 * check-worker-protocol-package.mjs
 *
 * Packs the built `@armyofagents/worker-protocol` package into a temporary
 * directory and proves its published shape and encapsulation:
 *
 *   1. The tarball contains ONLY declared metadata (`package/package.json`) plus
 *      `package/dist/**` — never `src`, never an emitted `*.test.*` file, never
 *      any other stray path.
 *   2. The required runtime + declaration files are present (`dist/index.js`,
 *      `dist/index.d.ts`).
 *   3. The packed manifest declares exactly one runtime dependency (`zod`) — no
 *      undeclared runtime dependency leaks.
 *   4. The exact tarball is extracted (no package manager, no network) into the
 *      `node_modules` of minimal "server" and "worker" consumer fixtures, and
 *      the package's ONE declared runtime dependency (`zod`) is provisioned
 *      alongside it OFFLINE (copied from the monorepo's installed copy, the way
 *      a real install would materialize it). Each consumer then imports ONLY
 *      the public root export, exercises a `zod`-backed schema to prove that
 *      dependency resolves, and confirms private/deep subpaths are not
 *      reachable through the package `exports` map.
 *
 * Usage: node scripts/check-worker-protocol-package.mjs
 * Run `pnpm --filter @armyofagents/worker-protocol build` first (Step 6 does).
 * If `dist` is missing this script builds it once as a convenience.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = path.join(repoRoot, "packages", "worker-protocol");
const distDir = path.join(packageDir, "dist");
const fixturesDir = path.join(repoRoot, "tests", "fixtures", "worker-protocol-import");

const errors = [];
const fail = (msg) => errors.push(msg);

// Resolve the package's DECLARED runtime dependency (`zod`) from the monorepo's
// installed node_modules so it can be provisioned OFFLINE into each temp
// consumer — exactly what a real `npm install` of the tarball would
// materialize, but with no network and no package manager. Anchored at the
// source package.json so it follows the pnpm symlink
// (`packages/worker-protocol/node_modules/zod` -> `.pnpm/zod@<v>/…`).
function resolveInstalledZodDir() {
  const requireFromPackage = createRequire(path.join(packageDir, "package.json"));
  const zodManifest = requireFromPackage.resolve("zod/package.json");
  return path.dirname(zodManifest);
}

function run(command, args, options) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

// pnpm resolves to a .cmd shim on Windows, which spawnSync can only launch via
// a shell. Pass the whole command as one string (not shell + args array) to
// avoid the Node DEP0190 unescaped-args deprecation while staying cross-platform.
function runShell(commandString, options) {
  return spawnSync(commandString, { encoding: "utf8", shell: true, ...options });
}

function ensureBuilt() {
  if (fs.existsSync(path.join(distDir, "index.js"))) return true;
  const built = runShell("pnpm --filter @armyofagents/worker-protocol build", {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (built.status !== 0) {
    fail("failed to build @armyofagents/worker-protocol (run `pnpm --filter @armyofagents/worker-protocol build`)");
    return false;
  }
  return fs.existsSync(path.join(distDir, "index.js"));
}

function main() {
  if (!ensureBuilt()) return finish();

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "wpp-"));
  try {
    const packDest = path.join(tmpBase, "pack");
    fs.mkdirSync(packDest, { recursive: true });

    // 1. Pack.
    const packed = runShell(`pnpm pack --pack-destination "${packDest}"`, { cwd: packageDir });
    if (packed.status !== 0) {
      fail(`pnpm pack failed: ${packed.stderr || packed.stdout || "unknown error"}`);
      return finish();
    }
    const tarballs = fs.readdirSync(packDest).filter((f) => f.endsWith(".tgz"));
    if (tarballs.length !== 1) {
      fail(`expected exactly one tarball, found ${JSON.stringify(tarballs)}`);
      return finish();
    }
    const tarballName = tarballs[0];

    // 2. List tarball entries and enforce the allow-list.
    // tar is invoked with cwd = packDest and colon-free relative paths so GNU
    // tar on Windows does not misparse a `C:\…` drive letter as a remote host
    // (works identically for bsdtar); no `--force-local` needed.
    const listed = run("tar", ["-tzf", tarballName], { cwd: packDest });
    if (listed.status !== 0) {
      fail(`tar -tzf failed: ${listed.stderr || "unknown error"}`);
      return finish();
    }
    const entries = listed.stdout
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^\.\//, ""))
      .filter(Boolean)
      // tar may or may not list bare directory entries; ignore pure dir markers.
      .filter((e) => !e.endsWith("/"));
    const allowedMetadata = /^package\/(package\.json|README(\.[A-Za-z]+)?|LICENSE(\.[A-Za-z]+)?|CHANGELOG(\.[A-Za-z]+)?)$/;
    let sawIndexJs = false;
    let sawIndexDts = false;
    for (const entry of entries) {
      if (!entry.startsWith("package/")) {
        fail(`tarball entry outside package/: ${entry}`);
        continue;
      }
      if (entry.startsWith("package/src/") || entry === "package/src") {
        fail(`tarball must not ship src: ${entry}`);
        continue;
      }
      if (/\.test\./.test(entry)) {
        fail(`tarball must not ship test files: ${entry}`);
        continue;
      }
      if (entry.startsWith("package/dist/")) {
        if (entry === "package/dist/index.js") sawIndexJs = true;
        if (entry === "package/dist/index.d.ts") sawIndexDts = true;
        continue;
      }
      if (allowedMetadata.test(entry)) continue;
      fail(`unexpected tarball entry: ${entry}`);
    }
    if (!sawIndexJs) fail("tarball missing required runtime file dist/index.js");
    if (!sawIndexDts) fail("tarball missing required declaration file dist/index.d.ts");

    // 3. Extract and inspect the packed manifest. Extract into a subdir of
    // packDest so both tar arguments stay colon-free relative paths.
    const extractDir = path.join(packDest, "extract");
    fs.mkdirSync(extractDir, { recursive: true });
    const extracted = run("tar", ["-xzf", tarballName, "-C", "extract"], { cwd: packDest });
    if (extracted.status !== 0) {
      fail(`tar -xzf failed: ${extracted.stderr || "unknown error"}`);
      return finish();
    }
    const extractedPackage = path.join(extractDir, "package");
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(extractedPackage, "package.json"), "utf8"));
    } catch (err) {
      fail(`cannot read packed package.json: ${err.message}`);
      return finish();
    }
    const runtimeDeps = Object.keys(manifest.dependencies ?? {}).sort();
    if (JSON.stringify(runtimeDeps) !== JSON.stringify(["zod"])) {
      fail(`packed runtime dependencies must equal ["zod"], got ${JSON.stringify(runtimeDeps)}`);
    }
    if (manifest.name !== "@armyofagents/worker-protocol") {
      fail(`packed package name unexpected: ${JSON.stringify(manifest.name)}`);
    }
    if (fs.existsSync(path.join(extractedPackage, "src"))) {
      fail("extracted package still contains a src directory");
    }

    // 4. Resolve the declared runtime dependency ONCE, failing CLOSED if it is
    // unavailable: a real dependency install would provide it, so if we cannot
    // provision it offline the smoke is invalid and must stay RED rather than
    // silently skip the transitive import it is meant to exercise.
    let zodDir;
    try {
      zodDir = resolveInstalledZodDir();
    } catch (err) {
      fail(`cannot resolve the declared runtime dependency "zod" to provision offline: ${err.message}`);
      return finish();
    }
    if (!fs.existsSync(path.join(zodDir, "package.json"))) {
      fail(`resolved zod directory has no package.json: ${zodDir}`);
      return finish();
    }

    // 5. Link the exact tarball into each consumer fixture and run it.
    for (const consumer of ["server-consumer", "worker-consumer"]) {
      const fixture = path.join(fixturesDir, `${consumer}.mjs`);
      if (!fs.existsSync(fixture)) {
        fail(`missing consumer fixture: ${consumer}.mjs`);
        continue;
      }
      const consumerDir = path.join(tmpBase, consumer);
      const depDir = path.join(consumerDir, "node_modules", "@armyofagents", "worker-protocol");
      fs.mkdirSync(depDir, { recursive: true });
      fs.cpSync(extractedPackage, depDir, { recursive: true });
      // Provision the package's DECLARED runtime dependency (`zod`) into the
      // consumer's node_modules — OFFLINE, by copying the exact installed copy
      // from the monorepo — so the consumer's transitive `import "zod"`
      // (reached from the package's `dist/*.js`) resolves. This does NOT weaken
      // any packaging check: the tarball allow-list above already proved the
      // package ships only declared metadata + `dist` and declares exactly
      // ["zod"]; here we merely materialize that one declared dependency the
      // way a real install would, instead of papering over a resolution error.
      const zodDest = path.join(consumerDir, "node_modules", "zod");
      fs.cpSync(zodDir, zodDest, { recursive: true });
      const runFixture = path.join(consumerDir, `${consumer}.mjs`);
      fs.copyFileSync(fixture, runFixture);
      const result = run(process.execPath, [runFixture], { cwd: consumerDir });
      if (result.status !== 0) {
        fail(`${consumer} failed (exit ${result.status}): ${result.stderr || result.stdout}`);
        continue;
      }
      if (!/\bOK\b/.test(result.stdout)) {
        fail(`${consumer} did not report OK: ${result.stdout}`);
      }
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
  return finish();
}

function finish() {
  if (errors.length > 0) {
    console.error("worker protocol package check FAILED:");
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log("worker protocol package: PASS");
}

main();
