#!/usr/bin/env node
/**
 * Mutation / decoy / bypass corpus for the sandbox-e2b-provider boundary gate
 * (CLI-001). Run with:
 *   node --test scripts/check-sandbox-e2b-provider-boundary.test.mjs
 *
 * Proves, against synthetic package trees:
 *   - ACCEPTANCE of the allowed dep set {sandbox-provider-contract, worker-daemon,
 *     worker-protocol, e2b, zod} + Node builtins + `zod/*` + relative src imports;
 *   - rejection of forbidden server/db/shared/adapters/fake-provider/drizzle/pg/
 *     Express bare imports;
 *   - `e2b` may be imported ONLY from `real-transport.ts` (elsewhere = violation);
 *   - the `E2B_API_KEY` credential token is confined to `real-transport.ts`;
 *   - manifest deps must equal EXACTLY the allowed five; name must match;
 *   - CommonJS require + node:module bridge + alternate extensions + test-source
 *     imports + relative escapes + symlinks are rejected;
 *   - the REAL package on disk passes clean.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runBoundaryCheck, SANDBOX_E2B_BOUNDARY_PACKAGES } from "./check-sandbox-e2b-provider-boundary.mjs";

const PKG_REL = "packages/sandbox-e2b-provider";
const PKG_NAME = "@armyofagents/sandbox-e2b-provider";
const ONE_PACKAGE = [{ rel: PKG_REL, name: PKG_NAME }];
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function defaultManifest() {
  return {
    name: PKG_NAME,
    version: "0.1.0",
    private: true,
    type: "module",
    dependencies: {
      "@armyofagents/sandbox-provider-contract": "workspace:*",
      "@armyofagents/worker-daemon": "workspace:*",
      "@armyofagents/worker-protocol": "workspace:*",
      e2b: "^2.30.5",
      zod: "3.24.2",
    },
  };
}

function setup(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sep-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkgDir = path.join(root, ...PKG_REL.split("/"));
  const srcDir = path.join(pkgDir, "src");
  if (opts.manifestText !== null) {
    fs.mkdirSync(pkgDir, { recursive: true });
    const text = opts.manifestText ?? JSON.stringify(opts.manifestObject ?? defaultManifest(), null, 2);
    fs.writeFileSync(path.join(pkgDir, "package.json"), text);
  }
  if (opts.src !== null) {
    fs.mkdirSync(srcDir, { recursive: true });
    for (const [name, content] of Object.entries(opts.src ?? {})) {
      const abs = path.join(srcDir, name);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }
  return { root, pkgDir, srcDir };
}

const run = (root, deps = {}) => runBoundaryCheck(root, { packages: ONE_PACKAGE, ...deps });
const hasSubstr = (arr, sub) => arr.some((e) => e.includes(sub));

test("valid baseline: allowed deps + builtins + relative + real-transport e2b import pass clean", async (t) => {
  const { root } = setup(t, {
    src: {
      "index.ts": [
        'import { perOpToInvokeDriver } from "./per-op-adapter.js";',
        'import type { SandboxProvider } from "@armyofagents/worker-daemon";',
        'import type { SandboxProviderDriver } from "@armyofagents/sandbox-provider-contract";',
        'import { PROVIDER_OPERATIONS } from "@armyofagents/worker-protocol";',
        'import { z } from "zod";',
        'import { createHash } from "node:crypto";',
        "export const v = perOpToInvokeDriver && PROVIDER_OPERATIONS && z && createHash;",
        "",
      ].join("\n"),
      "per-op-adapter.ts": "export const perOpToInvokeDriver = 1;\n",
      "real-transport.ts": 'import { Sandbox } from "e2b";\nexport const key = process.env.E2B_API_KEY;\nexport const s = Sandbox;\n',
    },
  });
  const { policyErrors, readErrors } = await run(root);
  assert.deepEqual(policyErrors, [], `unexpected policy errors: ${policyErrors.join(" | ")}`);
  assert.deepEqual(readErrors, [], `unexpected read errors: ${readErrors.join(" | ")}`);
});

const FORBIDDEN_IMPORTS = {
  "@armyofagents/db": 'import { db } from "@armyofagents/db";\n',
  "@armyofagents/server": 'import { app } from "@armyofagents/server";\n',
  "@armyofagents/shared": 'import { x } from "@armyofagents/shared";\n',
  "@armyofagents/adapters": 'import { r } from "@armyofagents/adapters";\n',
  "@armyofagents/sandbox-fake-provider": 'import { f } from "@armyofagents/sandbox-fake-provider";\n',
  "drizzle-orm": 'import { sql } from "drizzle-orm";\n',
  pg: 'import { Pool } from "pg";\n',
  express: 'import express from "express";\n',
};
for (const [spec, src] of Object.entries(FORBIDDEN_IMPORTS)) {
  test(`rejects forbidden runtime import ${spec}`, async (t) => {
    const { root } = setup(t, { src: { "index.ts": src } });
    const { policyErrors } = await run(root);
    assert.ok(hasSubstr(policyErrors, `forbidden runtime import ${JSON.stringify(spec)}`), `got: ${policyErrors.join(" | ")}`);
  });
}

test("e2b imported OUTSIDE real-transport.ts is rejected", async (t) => {
  const { root } = setup(t, { src: { "e2b-provider.ts": 'import { Sandbox } from "e2b";\nexport const s = Sandbox;\n' } });
  const { policyErrors } = await run(root);
  assert.ok(hasSubstr(policyErrors, "may be imported ONLY from real-transport.ts"), `got: ${policyErrors.join(" | ")}`);
});

test("e2b imported INSIDE real-transport.ts is allowed", async (t) => {
  const { root } = setup(t, { src: { "real-transport.ts": 'import { Sandbox } from "e2b";\nexport const s = Sandbox;\n' } });
  const { policyErrors } = await run(root);
  assert.deepEqual(policyErrors, [], policyErrors.join(" | "));
});

test("E2B_API_KEY token OUTSIDE real-transport.ts is rejected (credential confinement)", async (t) => {
  const { root } = setup(t, { src: { "per-op-adapter.ts": "export const k = process.env.E2B_API_KEY;\n" } });
  const { policyErrors } = await run(root);
  assert.ok(hasSubstr(policyErrors, "provider-control credential"), `got: ${policyErrors.join(" | ")}`);
});

test("E2B_API_KEY token INSIDE real-transport.ts is allowed", async (t) => {
  const { root } = setup(t, { src: { "real-transport.ts": 'import { Sandbox } from "e2b";\nexport const k = process.env.E2B_API_KEY;\nexport const s = Sandbox;\n' } });
  const { policyErrors } = await run(root);
  assert.deepEqual(policyErrors, [], policyErrors.join(" | "));
});

test("CommonJS require() is rejected", async (t) => {
  const { root } = setup(t, { src: { "index.ts": 'export const s = require("e2b");\n' } });
  const { policyErrors } = await run(root);
  assert.ok(hasSubstr(policyErrors, "CommonJS require() is forbidden"), policyErrors.join(" | "));
});

test("node:module createRequire bridge is rejected", async (t) => {
  const { root } = setup(t, { src: { "index.ts": 'import { createRequire } from "node:module";\nexport const r = createRequire;\n' } });
  const { policyErrors } = await run(root);
  assert.ok(hasSubstr(policyErrors, 'forbidden runtime import "node:module"'), policyErrors.join(" | "));
});

for (const ext of ["d.ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
  test(`rejects alternate runtime-source extension .${ext}`, async (t) => {
    const { root } = setup(t, { src: { "index.ts": 'import { z } from "zod";\nexport const a = z;\n', [`extra.${ext}`]: "export {};\n" } });
    const { policyErrors } = await run(root);
    assert.ok(hasSubstr(policyErrors, `extra.${ext}: alternate runtime-source extensions are forbidden`), policyErrors.join(" | "));
  });
}

test("rejects runtime import of test source", async (t) => {
  const { root } = setup(t, { src: { "index.ts": 'import { x } from "./thing.test.js";\nexport const y = x;\n' } });
  const { policyErrors } = await run(root);
  assert.ok(hasSubstr(policyErrors, "runtime import of test source is forbidden"), policyErrors.join(" | "));
});

test("rejects a relative escape out of src", async (t) => {
  const { root } = setup(t, { src: { "index.ts": 'import { x } from "../../../server/x.js";\nexport const y = x;\n' } });
  const { policyErrors } = await run(root);
  assert.ok(hasSubstr(policyErrors, "relative import escapes package src"), policyErrors.join(" | "));
});

test("rejects an extra runtime dependency", async (t) => {
  const manifest = defaultManifest();
  manifest.dependencies = { ...manifest.dependencies, pino: "^9.0.0" };
  const { root } = setup(t, { manifestObject: manifest, src: { "index.ts": "export const a = 1;\n" } });
  const { policyErrors } = await run(root);
  assert.ok(hasSubstr(policyErrors, "runtime dependencies must equal"), policyErrors.join(" | "));
});

test("rejects a missing runtime dependency", async (t) => {
  const manifest = defaultManifest();
  delete manifest.dependencies.e2b;
  const { root } = setup(t, { manifestObject: manifest, src: { "index.ts": "export const a = 1;\n" } });
  const { policyErrors } = await run(root);
  assert.ok(hasSubstr(policyErrors, "runtime dependencies must equal"), policyErrors.join(" | "));
});

test("a forbidden dep hidden in optionalDependencies is rejected", async (t) => {
  const manifest = defaultManifest();
  manifest.optionalDependencies = { "drizzle-orm": "*" };
  const { root } = setup(t, { manifestObject: manifest, src: { "index.ts": "export const x = 1;\n" } });
  const { policyErrors } = await run(root);
  assert.ok(hasSubstr(policyErrors, "runtime dependencies must equal"), policyErrors.join(" | "));
});

test("rejects a wrong package name", async (t) => {
  const manifest = defaultManifest();
  manifest.name = "@armyofagents/not-e2b";
  const { root } = setup(t, { manifestObject: manifest, src: { "index.ts": "export const a = 1;\n" } });
  const { policyErrors } = await run(root);
  assert.ok(hasSubstr(policyErrors, "unexpected package name"), policyErrors.join(" | "));
});

test("a runtime-source symlink under src is rejected", async (t) => {
  const { root, srcDir } = setup(t, { src: { "index.ts": 'import { z } from "zod";\nexport const a = z;\n' } });
  const syntheticDirent = { name: "linked.ts", isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
  const readdir = async (dir, options) => {
    const real = await fs.promises.readdir(dir, options);
    if (path.resolve(dir) === path.resolve(srcDir)) return [...real, syntheticDirent];
    return real;
  };
  const { policyErrors } = await run(root, { readdir });
  assert.ok(hasSubstr(policyErrors, "linked.ts: runtime-source symlinks are forbidden"), policyErrors.join(" | "));
});

test("missing manifest AND src are read errors, not policy", async (t) => {
  const { root } = setup(t, { manifestText: null, src: null });
  const { policyErrors, readErrors } = await run(root);
  assert.ok(hasSubstr(readErrors, `${PKG_REL}/package.json: missing or unreadable`), readErrors.join(" | "));
  assert.ok(hasSubstr(readErrors, `${PKG_REL}/src: missing`), readErrors.join(" | "));
  assert.deepEqual(policyErrors, []);
});

test("the exported package list covers the e2b leaf", () => {
  assert.ok(Array.isArray(SANDBOX_E2B_BOUNDARY_PACKAGES));
  assert.deepEqual(SANDBOX_E2B_BOUNDARY_PACKAGES.map((p) => p.name), ["@armyofagents/sandbox-e2b-provider"]);
});

test("the REAL package on disk passes the boundary clean", async () => {
  const { policyErrors, readErrors } = await runBoundaryCheck(REPO_ROOT);
  assert.deepEqual(policyErrors, [], `real package policy errors: ${policyErrors.join(" | ")}`);
  assert.deepEqual(readErrors, [], `real package read errors: ${readErrors.join(" | ")}`);
});
