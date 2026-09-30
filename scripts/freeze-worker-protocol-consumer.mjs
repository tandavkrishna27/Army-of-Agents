#!/usr/bin/env node
/**
 * freeze-worker-protocol-consumer.mjs
 *
 * Generate the FROZEN, hash-pinned, independent worker-protocol v1 consumer
 * baseline (`tests/fixtures/worker-protocol-consumers/v1/`). It bundles the built
 * `packages/worker-protocol/dist/index.js` PLUS its exact Zod runtime into a
 * single self-contained ESM module with NO runtime dependency and NO import of
 * any current protocol source, copies the emitted declaration tree + minimal
 * package metadata, records a dependency lock (source SHA, package/lock
 * integrity, exact Zod + esbuild versions, bundler options), normalizes every
 * declared text file to UTF-8/LF, and writes the sorted POSIX-path SHA-256
 * manifest (excluding itself).
 *
 * It is DETERMINISTIC: re-running against the same source commit + toolchain
 * produces byte-identical output. It is also a one-way door — it REFUSES to
 * overwrite an existing fixture and refuses `--force`. A future breaking protocol
 * version adds a NEW versioned fixture; frozen bytes are never hand-edited.
 *
 * Preconditions (all enforced, fail-closed):
 *   * `--source-sha <40-hex>` is provided and equals `git rev-parse HEAD`;
 *   * `packages/worker-protocol/src` has no working-tree diff;
 *   * the output directory does not already exist;
 *   * the package has been built (`dist/index.js` + declaration tree present).
 *
 * Usage:
 *   pnpm freeze:worker-protocol-v1 -- --source-sha <40-hex>
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import * as esbuild from "esbuild";

import { BUNDLER_OPTIONS, FIXTURE_SEGMENTS, LOCK_NAME, MANIFEST_NAME, PACKAGE_NAME, recomputeManifestBytes } from "./check-frozen-worker-protocol-consumer.mjs";

const PACKAGE_SEGMENTS = ["packages", "worker-protocol"];

function die(message) {
  console.error(`freeze aborted: ${message}`);
  process.exit(1);
}

/** LF-normalize text: strip CR so a Windows toolchain cannot emit CRLF. */
function toLf(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Deterministic dependency-lock serialization with a fixed key order. */
function serializeLock(lock) {
  const ordered = {
    sourceSha: lock.sourceSha,
    zodVersion: lock.zodVersion,
    esbuildVersion: lock.esbuildVersion,
    lockfileIntegrity: lock.lockfileIntegrity,
    packageIntegrity: lock.packageIntegrity,
    bundlerOptions: {
      bundle: BUNDLER_OPTIONS.bundle,
      format: BUNDLER_OPTIONS.format,
      platform: BUNDLER_OPTIONS.platform,
      target: BUNDLER_OPTIONS.target,
      sourcemap: BUNDLER_OPTIONS.sourcemap,
      legalComments: BUNDLER_OPTIONS.legalComments,
      minify: BUNDLER_OPTIONS.minify,
    },
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--force")) die("--force is not permitted; the frozen baseline is a one-way door");
  const i = argv.indexOf("--source-sha");
  const sourceSha = i !== -1 ? argv[i + 1] : undefined;
  if (!sourceSha || !/^[0-9a-f]{40}$/.test(sourceSha)) {
    die("provide --source-sha <40-hex>");
  }

  const repoRoot = process.cwd();

  // Precondition: HEAD equals the supplied source commit.
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  if (head.status !== 0) die(`git rev-parse HEAD failed: ${(head.stderr || "").trim()}`);
  if (head.stdout.trim() !== sourceSha) die(`HEAD ${head.stdout.trim()} != --source-sha ${sourceSha}`);

  // Precondition: no working-tree diff under the runtime source.
  const status = spawnSync("git", ["status", "--porcelain", "--", "packages/worker-protocol/src"], { cwd: repoRoot, encoding: "utf8" });
  if (status.status !== 0) die(`git status failed: ${(status.stderr || "").trim()}`);
  if (status.stdout.trim().length > 0) die(`packages/worker-protocol/src has an uncommitted diff:\n${status.stdout}`);

  const packageDir = path.join(repoRoot, ...PACKAGE_SEGMENTS);
  const builtDist = path.join(packageDir, "dist");
  const builtIndex = path.join(builtDist, "index.js");
  if (!fs.existsSync(builtIndex)) die(`missing ${path.relative(repoRoot, builtIndex)} — run: pnpm --filter @armyofagents/worker-protocol build`);

  const outDir = path.join(repoRoot, ...FIXTURE_SEGMENTS);
  if (fs.existsSync(outDir)) die(`output directory already exists (refusing to overwrite): ${path.relative(repoRoot, outDir)}`);

  // Resolve the exact Zod + esbuild versions + integrity anchors.
  const require = createRequire(path.join(packageDir, PACKAGE_NAME));
  const rootRequire = createRequire(path.join(repoRoot, PACKAGE_NAME));
  const zodVersion = JSON.parse(fs.readFileSync(require.resolve("zod/package.json"), "utf8")).version;
  const esbuildVersion = JSON.parse(fs.readFileSync(rootRequire.resolve("esbuild/package.json"), "utf8")).version;
  if (esbuildVersion !== esbuild.version) die(`resolved esbuild ${esbuildVersion} != loaded esbuild ${esbuild.version}`);
  const lockfileIntegrity = createHash("sha256").update(fs.readFileSync(path.join(repoRoot, "pnpm-lock.yaml"))).digest("hex");
  const packageIntegrity = createHash("sha256").update(fs.readFileSync(path.join(packageDir, PACKAGE_NAME))).digest("hex");

  // Bundle the built entry + Zod into one self-contained ESM module. Deterministic
  // options, no sourcemap/banner/timestamp; relative paths only (absWorkingDir).
  const result = await esbuild.build({
    entryPoints: ["packages/worker-protocol/dist/index.js"],
    outfile: "tests/fixtures/worker-protocol-consumers/v1/dist/index.js",
    absWorkingDir: repoRoot,
    write: false,
    ...BUNDLER_OPTIONS,
  });
  const bundle = toLf(result.outputFiles[0].text);
  // Fast local guard: a fully bundled module must have no `import/export … from "…"`
  // specifier and no `import(...)`/`require(...)` call. The checker enforces this
  // authoritatively over the checked-in bytes.
  if (
    /(?:^|[;\n])\s*(?:import|export)\s+(?:[^"'()]*?\s+from\s*)?["'][^"']+["']/m.test(bundle) ||
    /\bimport\s*\(\s*["'][^"']+["']\s*\)/.test(bundle) ||
    /\brequire\s*\(\s*["'][^"']+["']\s*\)/.test(bundle)
  ) {
    die("the bundled output still references an external module specifier — bundling did not inline everything");
  }

  // Write the frozen tree.
  const frozenDist = path.join(outDir, "dist");
  fs.mkdirSync(frozenDist, { recursive: true });
  fs.writeFileSync(path.join(frozenDist, "index.js"), Buffer.from(bundle, "utf8"));

  // Copy the emitted declaration tree (strip sourceMappingURL, LF-normalize).
  for (const name of fs.readdirSync(builtDist).sort()) {
    if (!name.endsWith(".d.ts")) continue; // skip .js, .js.map, .d.ts.map
    const raw = toLf(fs.readFileSync(path.join(builtDist, name), "utf8"));
    const stripped = raw.replace(/\n\/\/#\s*sourceMappingURL=[^\n]*\n?$/, "\n");
    fs.writeFileSync(path.join(frozenDist, name), Buffer.from(stripped, "utf8"));
  }

  // Minimal package metadata — NO runtime dependency.
  const frozenPackage = {
    name: "@armyofagents/worker-protocol-frozen-v1",
    version: "1.0.0",
    private: true,
    type: "module",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  };
  fs.writeFileSync(path.join(outDir, PACKAGE_NAME), Buffer.from(`${JSON.stringify(frozenPackage, null, 2)}\n`, "utf8"));

  // Dependency lock.
  fs.writeFileSync(
    path.join(outDir, LOCK_NAME),
    Buffer.from(serializeLock({ sourceSha, zodVersion, esbuildVersion, lockfileIntegrity, packageIntegrity }), "utf8"),
  );

  // Sorted POSIX-path SHA-256 manifest (excludes itself), computed by the SAME
  // helper the checker recomputes with — so the freeze writes exactly what the
  // checker verifies.
  fs.writeFileSync(path.join(outDir, MANIFEST_NAME), recomputeManifestBytes(outDir));

  console.log(`froze worker-protocol v1 baseline at ${path.relative(repoRoot, outDir)} (sourceSha ${sourceSha}, zod ${zodVersion}, esbuild ${esbuildVersion})`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
