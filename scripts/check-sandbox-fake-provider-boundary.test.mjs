#!/usr/bin/env node
/**
 * Mutation / decoy / bypass corpus for the sandbox-fake-provider boundary gate
 * (DEP-000). It proves the machine-checkable "no tenant/server/db code on the
 * host worker" seam for BOTH new leaf packages.
 *
 * Run with:
 *   node --test scripts/check-sandbox-fake-provider-boundary.test.mjs
 *
 * Each case builds a minimal temporary package tree under an isolated root, runs
 * `runBoundaryCheck(root, { packages:[…] })` against a single synthetic package,
 * and asserts the exact import-policy violation or read/parse error. The corpus
 * proves:
 *   - rejection of forbidden server/db/shared/adapters/worker-daemon/contract/
 *     drizzle/pg/Express bare imports (the DEP-000 headline);
 *   - ACCEPTANCE of the allowed set: `@armyofagents/worker-protocol`, `zod`
 *     (+ `zod/*`), Node built-ins (`node:*` and bare), relative `src` imports;
 *   - rejection of the CommonJS require bridge + node:module;
 *   - rejection of every alternate runtime-source extension, `.test` imports,
 *     relative escapes, and runtime-source symlinks;
 *   - manifest policy: deps must equal EXACTLY {worker-protocol, zod}; the name
 *     must match; hidden optional/peer/bundled deps are caught;
 *   - that comment / string / template DECOYS never trip;
 *   - that a missing/unreadable manifest or src is a read error, not policy.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile as realReadFile } from "node:fs/promises";

import { runBoundaryCheck } from "./check-sandbox-fake-provider-boundary.mjs";

const PKG_REL = "packages/sandbox-fake-provider";
const PKG_NAME = "@armyofagents/sandbox-fake-provider";
const ONE_PACKAGE = [{ rel: PKG_REL, name: PKG_NAME }];

function defaultManifest() {
  return {
    name: PKG_NAME,
    version: "0.1.0",
    private: true,
    type: "module",
    dependencies: {
      "@armyofagents/worker-protocol": "workspace:*",
      zod: "3.24.2",
    },
  };
}

function setup(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfp-"));
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

// --------------------------------------------------------------------------
// Valid baseline + decoys
// --------------------------------------------------------------------------

test("valid baseline: worker-protocol + zod + node builtins + relative imports pass clean", async (t) => {
  const index = [
    'import { PROVIDER_OPERATIONS } from "@armyofagents/worker-protocol";',
    'import { z } from "zod";',
    'import { createServer } from "node:http";',
    'import { createHash } from "node:crypto";',
    'import os from "node:os";',
    'import fsp from "node:fs/promises";',
    'import { ledger } from "./invocation-ledger.js";',
    'import { helper } from "./sub/helper.js";',
    '// import evil from "@armyofagents/db"',
    '/* import bad from "drizzle-orm"; export * from "@armyofagents/server"; */',
    'const decoy = "import x from \'@armyofagents/db\'; require(\'pg\')";',
    "const tmpl = `mentions @armyofagents/server and drizzle-orm ${PROVIDER_OPERATIONS.length}`;",
    "export const value = z && os && createServer && createHash && fsp && ledger && helper && tmpl;",
    "",
  ].join("\n");
  const { root } = setup(t, {
    src: {
      "index.ts": index,
      "invocation-ledger.ts": "export const ledger = 1;\n",
      "sub/helper.ts": "export const helper = 1;\n",
    },
  });
  const { policyErrors, readErrors } = await run(root);
  assert.deepEqual(policyErrors, [], `unexpected policy errors: ${policyErrors.join(" | ")}`);
  assert.deepEqual(readErrors, [], `unexpected read errors: ${readErrors.join(" | ")}`);
});

test("process/Buffer/URL globals are ALLOWED (the fake is a runtime program)", async (t) => {
  const { root } = setup(t, {
    src: {
      "index.ts":
        "export const a = process.env.PORT;\n" +
        'export const b = new URL("http://127.0.0.1");\n' +
        'export const c = Buffer.from("x");\n',
    },
  });
  const { policyErrors } = await run(root);
  assert.deepEqual(policyErrors, [], `globals must not be flagged: ${policyErrors.join(" | ")}`);
});

test("zod subpath imports are allowed", async (t) => {
  const { root } = setup(t, { src: { "index.ts": 'import { z } from "zod/lib";\nexport const a = z;\n' } });
  const { policyErrors } = await run(root);
  assert.deepEqual(policyErrors, [], policyErrors.join(" | "));
});

// --------------------------------------------------------------------------
// Forbidden bare imports — the DEP-000 headline
// --------------------------------------------------------------------------

const FORBIDDEN_IMPORTS = {
  "@armyofagents/db": 'import { db } from "@armyofagents/db";\n',
  "@armyofagents/server": 'import { app } from "@armyofagents/server";\n',
  "@armyofagents/shared": 'import { x } from "@armyofagents/shared";\n',
  "@armyofagents/adapters": 'import { r } from "@armyofagents/adapters";\n',
  "@armyofagents/worker-daemon": 'import { d } from "@armyofagents/worker-daemon";\n',
  "@armyofagents/sandbox-provider-contract": 'import { c } from "@armyofagents/sandbox-provider-contract";\n',
  "drizzle-orm": 'import { sql } from "drizzle-orm";\n',
  pg: 'import { Pool } from "pg";\n',
  express: 'import express from "express";\n',
  pino: 'import pino from "pino";\n',
  lodash: 'import _ from "lodash";\n',
};
for (const [spec, src] of Object.entries(FORBIDDEN_IMPORTS)) {
  test(`rejects forbidden runtime import ${spec}`, async (t) => {
    const { root } = setup(t, { src: { "index.ts": src } });
    const { policyErrors } = await run(root);
    assert.ok(
      hasSubstr(policyErrors, `forbidden runtime import ${JSON.stringify(spec)}`),
      `expected ${spec} rejection, got: ${policyErrors.join(" | ")}`,
    );
  });
}

test("rejects db + server + drizzle together (non-empty violations)", async (t) => {
  const src = [
    'import { db } from "@armyofagents/db";',
    'import { app } from "@armyofagents/server";',
    'import { sql } from "drizzle-orm";',
    "export const x = db && app && sql;",
    "",
  ].join("\n");
  const { root } = setup(t, { src: { "index.ts": src } });
  const { policyErrors } = await run(root);
  assert.ok(policyErrors.length >= 3, `expected >=3 violations, got: ${policyErrors.join(" | ")}`);
  assert.ok(hasSubstr(policyErrors, '"@armyofagents/db"'), policyErrors.join(" | "));
  assert.ok(hasSubstr(policyErrors, '"@armyofagents/server"'), policyErrors.join(" | "));
  assert.ok(hasSubstr(policyErrors, '"drizzle-orm"'), policyErrors.join(" | "));
});

const BYPASSES = {
  "side-effect": { src: 'import "@armyofagents/db";\n', needle: 'forbidden runtime import "@armyofagents/db"' },
  static: { src: 'import { db } from "@armyofagents/db";\n', needle: 'forbidden runtime import "@armyofagents/db"' },
  "export-from": { src: 'export * from "drizzle-orm";\n', needle: 'forbidden runtime import "drizzle-orm"' },
  dynamic: { src: 'export async function f() { return import("pg"); }\n', needle: 'forbidden runtime import "pg"' },
};
for (const [label, { src, needle }] of Object.entries(BYPASSES)) {
  test(`real ${label} import of a forbidden module is caught`, async (t) => {
    const { root } = setup(t, { src: { "index.ts": src } });
    const { policyErrors } = await run(root);
    assert.ok(hasSubstr(policyErrors, needle), `expected ${needle}, got: ${policyErrors.join(" | ")}`);
  });
}

// --------------------------------------------------------------------------
// CommonJS bridge + alternate extensions + test imports + escapes + symlink
// --------------------------------------------------------------------------

test("CommonJS require() is rejected (bypasses the static import allowlist)", async (t) => {
  const { root } = setup(t, { src: { "index.ts": 'export const pool = require("pg");\n' } });
  const { policyErrors } = await run(root);
  assert.ok(hasSubstr(policyErrors, "CommonJS require() is forbidden"), policyErrors.join(" | "));
});

test("node:module (createRequire bridge) is rejected even though it is a Node builtin", async (t) => {
  const { root } = setup(t, {
    src: { "index.ts": 'import { createRequire } from "node:module";\nexport const r = createRequire;\n' },
  });
  const { policyErrors } = await run(root);
  assert.ok(hasSubstr(policyErrors, 'forbidden runtime import "node:module"'), policyErrors.join(" | "));
});

for (const ext of ["d.ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
  test(`rejects alternate runtime-source extension .${ext}`, async (t) => {
    const { root } = setup(t, {
      src: { "index.ts": 'import { z } from "zod";\nexport const a = z;\n', [`extra.${ext}`]: "export {};\n" },
    });
    const { policyErrors } = await run(root);
    assert.ok(
      hasSubstr(policyErrors, `extra.${ext}: alternate runtime-source extensions are forbidden`),
      `expected alternate-extension rejection for .${ext}, got: ${policyErrors.join(" | ")}`,
    );
  });
}

for (const spec of ["./thing.test.js", "./thing.test", "./thing.test.ts"]) {
  test(`rejects runtime import of test source ${spec}`, async (t) => {
    const { root } = setup(t, { src: { "index.ts": `import { x } from "${spec}";\n` } });
    const { policyErrors } = await run(root);
    assert.ok(hasSubstr(policyErrors, "runtime import of test source is forbidden"), policyErrors.join(" | "));
  });
}

const ESCAPES = {
  "static import": 'import { x } from "../../../server/x.js";\n',
  "side-effect import": 'import "../../server/y.js";\n',
  "export ... from": 'export { z } from "../../../server/z.js";\n',
  "dynamic import": 'export async function f() { return import("../../../server/w.js"); }\n',
};
for (const [label, src] of Object.entries(ESCAPES)) {
  test(`rejects relative escape via ${label}`, async (t) => {
    const { root } = setup(t, { src: { "index.ts": src } });
    const { policyErrors } = await run(root);
    assert.ok(hasSubstr(policyErrors, "relative import escapes package src"), policyErrors.join(" | "));
  });
}

test("rejects a runtime-source symlink under src", async (t) => {
  const { root, srcDir } = setup(t, { src: { "index.ts": 'import { z } from "zod";\nexport const a = z;\n' } });
  const syntheticDirent = { name: "linked.ts", isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
  const readdir = async (dir, options) => {
    const real = await fs.promises.readdir(dir, options);
    if (path.resolve(dir) === path.resolve(srcDir)) return [...real, syntheticDirent];
    return real;
  };
  const { policyErrors, readErrors } = await run(root, { readdir });
  assert.ok(hasSubstr(policyErrors, "linked.ts: runtime-source symlinks are forbidden"), policyErrors.join(" | "));
  assert.deepEqual(readErrors, []);
});

// --------------------------------------------------------------------------
// Manifest content policy
// --------------------------------------------------------------------------

test("rejects an extra runtime dependency", async (t) => {
  const manifest = defaultManifest();
  manifest.dependencies = { ...manifest.dependencies, pino: "^9.0.0" };
  const { root } = setup(t, { manifestObject: manifest, src: { "index.ts": "export const a = 1;\n" } });
  const { policyErrors } = await run(root);
  assert.ok(hasSubstr(policyErrors, "runtime dependencies must equal"), policyErrors.join(" | "));
});

test("rejects a missing runtime dependency (worker-protocol only, no zod)", async (t) => {
  const manifest = defaultManifest();
  manifest.dependencies = { "@armyofagents/worker-protocol": "workspace:*" };
  const { root } = setup(t, { manifestObject: manifest, src: { "index.ts": "export const a = 1;\n" } });
  const { policyErrors } = await run(root);
  assert.ok(hasSubstr(policyErrors, "runtime dependencies must equal"), policyErrors.join(" | "));
});

for (const field of ["optionalDependencies", "peerDependencies"]) {
  test(`a forbidden dep hidden in ${field} is rejected`, async (t) => {
    const manifest = defaultManifest();
    manifest[field] = { "drizzle-orm": "*" };
    const { root } = setup(t, { manifestObject: manifest, src: { "index.ts": "export const x = 1;\n" } });
    const { policyErrors } = await run(root);
    assert.ok(hasSubstr(policyErrors, "runtime dependencies must equal"), policyErrors.join(" | "));
  });
}

test("a forbidden dep in bundledDependencies is rejected", async (t) => {
  const manifest = defaultManifest();
  manifest.bundledDependencies = ["pg"];
  const { root } = setup(t, { manifestObject: manifest, src: { "index.ts": "export const x = 1;\n" } });
  const { policyErrors } = await run(root);
  assert.ok(hasSubstr(policyErrors, "runtime dependencies must equal"), policyErrors.join(" | "));
});

test("rejects a wrong package name", async (t) => {
  const manifest = defaultManifest();
  manifest.name = "@armyofagents/not-the-fake";
  const { root } = setup(t, { manifestObject: manifest, src: { "index.ts": "export const a = 1;\n" } });
  const { policyErrors } = await run(root);
  assert.ok(hasSubstr(policyErrors, "unexpected package name"), policyErrors.join(" | "));
});

// --------------------------------------------------------------------------
// Read/parse errors separated from policy
// --------------------------------------------------------------------------

test("missing package reports missing manifest AND missing src (read errors, not policy)", async (t) => {
  const { root } = setup(t, { manifestText: null, src: null });
  const { policyErrors, readErrors } = await run(root);
  assert.ok(hasSubstr(readErrors, `${PKG_REL}/package.json: missing or unreadable`), readErrors.join(" | "));
  assert.ok(hasSubstr(readErrors, `${PKG_REL}/src: missing`), readErrors.join(" | "));
  assert.deepEqual(policyErrors, []);
});

test("invalid manifest JSON is a read/parse error", async (t) => {
  const { root } = setup(t, { manifestText: "{ not json ", src: { "index.ts": "export const a = 1;\n" } });
  const { readErrors } = await run(root);
  assert.ok(hasSubstr(readErrors, "package.json: invalid JSON"), readErrors.join(" | "));
});

test("an unreadable source file is a read error, not a policy result", async (t) => {
  const { root, srcDir } = setup(t, { src: { "index.ts": 'import { z } from "zod";\nexport const a = z;\n' } });
  const target = path.join(srcDir, "index.ts");
  const readFile = async (p, enc) => {
    if (path.resolve(p) === path.resolve(target)) {
      const err = new Error("permission denied");
      err.code = "EACCES";
      throw err;
    }
    return realReadFile(p, enc);
  };
  const { policyErrors, readErrors } = await run(root, { readFile });
  assert.ok(hasSubstr(readErrors, "index.ts: unreadable source (EACCES)"), readErrors.join(" | "));
  assert.deepEqual(policyErrors, [], policyErrors.join(" | "));
});

// --------------------------------------------------------------------------
// Both real packages are covered by the default package list
// --------------------------------------------------------------------------

test("the default package list covers BOTH sandbox packages", async (t) => {
  const { runBoundaryCheck: real, SANDBOX_BOUNDARY_PACKAGES } = await import("./check-sandbox-fake-provider-boundary.mjs");
  assert.ok(Array.isArray(SANDBOX_BOUNDARY_PACKAGES), "SANDBOX_BOUNDARY_PACKAGES should be exported");
  const names = SANDBOX_BOUNDARY_PACKAGES.map((p) => p.name).sort();
  assert.deepEqual(names, ["@armyofagents/sandbox-fake-provider", "@armyofagents/sandbox-provider-contract"]);
  assert.equal(typeof real, "function");
});
