#!/usr/bin/env node
/**
 * Mutation / decoy / bypass corpus for the worker-daemon boundary gate.
 *
 * Run with:
 *   node --test scripts/check-worker-daemon-boundary.test.mjs
 *
 * Each case builds a minimal temporary `packages/worker-daemon` tree under an
 * isolated root, runs `runBoundaryCheck(root)`, and asserts the exact
 * import-policy violation or filesystem read/parse error. The corpus proves:
 *   - rejection of forbidden server/db/shared/adapters/drizzle/pg/Express bare
 *     imports (the E4-D01 headline);
 *   - ACCEPTANCE of the allowed set: `@armyofagents/worker-protocol`, `pino`
 *     (+ `pino/*`), Node built-ins (`node:*` and bare), relative `src` imports;
 *   - rejection of every alternate runtime-source extension + runtime-source
 *     symlinks;
 *   - rejection of a runtime import of a `.test` source and relative escapes;
 *   - manifest policy: deps must equal EXACTLY {worker-protocol, pino}; name
 *     must be `@armyofagents/worker-daemon`;
 *   - that comment / string / template DECOYS never trip;
 *   - that a missing/unreadable manifest or src is a read error, not policy.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile as realReadFile } from "node:fs/promises";

import { runBoundaryCheck } from "./check-worker-daemon-boundary.mjs";

function defaultManifest() {
  return {
    name: "@armyofagents/worker-daemon",
    version: "0.1.0",
    private: true,
    type: "module",
    dependencies: {
      "@armyofagents/worker-protocol": "workspace:*",
      pino: "^9.6.0",
    },
  };
}

/**
 * @param {import("node:test").TestContext} t
 * @param {{manifestText?:string|null, manifestObject?:object, src?:Record<string,string>|null}} opts
 */
function setup(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wdb-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkgDir = path.join(root, "packages", "worker-daemon");
  const srcDir = path.join(pkgDir, "src");

  if (opts.manifestText !== null) {
    fs.mkdirSync(pkgDir, { recursive: true });
    const text =
      opts.manifestText ?? JSON.stringify(opts.manifestObject ?? defaultManifest(), null, 2);
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

const hasSubstr = (arr, sub) => arr.some((e) => e.includes(sub));

// --------------------------------------------------------------------------
// Valid baseline + decoys (the allowed set must pass CLEAN)
// --------------------------------------------------------------------------

test("valid baseline: worker-protocol + pino + node builtins + relative imports pass clean", async (t) => {
  const index = [
    'import { PROTOCOL_VERSION } from "@armyofagents/worker-protocol";',
    'import pino from "pino";',
    'import pinoStd from "pino/file";',
    'import { createServer } from "node:http";',
    'import { createHash } from "node:crypto";',
    'import os from "node:os";',
    'import fsp from "node:fs/promises";',
    'import { loadWorkerConfig } from "./config/config.js";',
    'import { helper } from "./sub/helper.js";',
    '// import evil from "@armyofagents/db"',
    '/* import bad from "drizzle-orm"; export * from "@armyofagents/server"; */',
    'const decoy = "import x from \'@armyofagents/db\'; require(\'pg\')";',
    'const tmpl = `mentions @armyofagents/server and drizzle-orm ${PROTOCOL_VERSION}`;',
    "export const value = pino && os && createServer && createHash && fsp && pinoStd;",
    "export const cfg = loadWorkerConfig; export const h = helper;",
    "",
  ].join("\n");
  const { root } = setup(t, {
    src: {
      "index.ts": index,
      "config/config.ts": "export const loadWorkerConfig = () => ({});\n",
      "sub/helper.ts": "export const helper = 1;\n",
    },
  });
  const { policyErrors, readErrors } = await runBoundaryCheck(root);
  assert.deepEqual(policyErrors, [], `unexpected policy errors: ${policyErrors.join(" | ")}`);
  assert.deepEqual(readErrors, [], `unexpected read errors: ${readErrors.join(" | ")}`);
});

test("process/Buffer/URL globals are ALLOWED in the worker daemon (unlike worker-protocol)", async (t) => {
  const { root } = setup(t, {
    src: {
      "index.ts":
        "export const a = process.env.AOA_WORKER_CONTROL_PLANE_URL;\n" +
        "export const b = new URL(\"http://127.0.0.1\");\n" +
        "export const c = Buffer.from(\"x\");\n",
    },
  });
  const { policyErrors } = await runBoundaryCheck(root);
  assert.deepEqual(policyErrors, [], `globals must not be flagged: ${policyErrors.join(" | ")}`);
});

// --------------------------------------------------------------------------
// Forbidden bare imports — the E4-D01 headline
// --------------------------------------------------------------------------

const FORBIDDEN_IMPORTS = {
  "@armyofagents/db": 'import { db } from "@armyofagents/db";\n',
  "@armyofagents/server": 'import { app } from "@armyofagents/server";\n',
  "@armyofagents/shared": 'import { x } from "@armyofagents/shared";\n',
  "@armyofagents/adapters": 'import { r } from "@armyofagents/adapters";\n',
  "drizzle-orm": 'import { sql } from "drizzle-orm";\n',
  pg: 'import { Pool } from "pg";\n',
  express: 'import express from "express";\n',
  lodash: 'import _ from "lodash";\n',
  zod: 'import { z } from "zod";\n',
};
for (const [spec, src] of Object.entries(FORBIDDEN_IMPORTS)) {
  test(`rejects forbidden runtime import ${spec}`, async (t) => {
    const { root } = setup(t, { src: { "index.ts": src } });
    const { policyErrors } = await runBoundaryCheck(root);
    assert.ok(
      hasSubstr(policyErrors, `forbidden runtime import ${JSON.stringify(spec)}`),
      `expected ${spec} rejection, got: ${policyErrors.join(" | ")}`,
    );
  });
}

test("rejects a source importing db AND server AND drizzle-orm together (non-empty violations)", async (t) => {
  const src = [
    'import { db } from "@armyofagents/db";',
    'import { app } from "@armyofagents/server";',
    'import { sql } from "drizzle-orm";',
    "export const x = db && app && sql;",
    "",
  ].join("\n");
  const { root } = setup(t, { src: { "index.ts": src } });
  const { policyErrors } = await runBoundaryCheck(root);
  assert.ok(policyErrors.length >= 3, `expected >=3 violations, got: ${policyErrors.join(" | ")}`);
  assert.ok(hasSubstr(policyErrors, '"@armyofagents/db"'), policyErrors.join(" | "));
  assert.ok(hasSubstr(policyErrors, '"@armyofagents/server"'), policyErrors.join(" | "));
  assert.ok(hasSubstr(policyErrors, '"drizzle-orm"'), policyErrors.join(" | "));
});

// One real bypass attempt per supported syntax (must trip).
const BYPASSES = {
  "side-effect": { src: 'import "@armyofagents/db";\n', needle: 'forbidden runtime import "@armyofagents/db"' },
  static: { src: 'import { db } from "@armyofagents/db";\n', needle: 'forbidden runtime import "@armyofagents/db"' },
  "export-from": { src: 'export * from "drizzle-orm";\n', needle: 'forbidden runtime import "drizzle-orm"' },
  dynamic: {
    src: 'export async function f() { return import("pg"); }\n',
    needle: 'forbidden runtime import "pg"',
  },
};
for (const [label, { src, needle }] of Object.entries(BYPASSES)) {
  test(`real ${label} import of a forbidden module is caught`, async (t) => {
    const { root } = setup(t, { src: { "index.ts": src } });
    const { policyErrors } = await runBoundaryCheck(root);
    assert.ok(hasSubstr(policyErrors, needle), `expected ${needle}, got: ${policyErrors.join(" | ")}`);
  });
}

// --------------------------------------------------------------------------
// Alternate runtime-source extensions + test-source imports + escapes + symlink
// --------------------------------------------------------------------------

for (const ext of ["d.ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
  test(`rejects alternate runtime-source extension .${ext}`, async (t) => {
    const { root } = setup(t, {
      src: { "index.ts": 'import pino from "pino";\nexport const a = pino;\n', [`extra.${ext}`]: "export {};\n" },
    });
    const { policyErrors } = await runBoundaryCheck(root);
    assert.ok(
      hasSubstr(policyErrors, `extra.${ext}: alternate runtime-source extensions are forbidden`),
      `expected alternate-extension rejection for .${ext}, got: ${policyErrors.join(" | ")}`,
    );
  });
}

for (const spec of ["./thing.test.js", "./thing.test", "./thing.test.ts"]) {
  test(`rejects runtime import of test source ${spec}`, async (t) => {
    const { root } = setup(t, { src: { "index.ts": `import { x } from "${spec}";\n` } });
    const { policyErrors } = await runBoundaryCheck(root);
    assert.ok(
      hasSubstr(policyErrors, "runtime import of test source is forbidden"),
      `expected test-source rejection for ${spec}, got: ${policyErrors.join(" | ")}`,
    );
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
    const { policyErrors } = await runBoundaryCheck(root);
    assert.ok(
      hasSubstr(policyErrors, "relative import escapes package src"),
      `expected escape rejection via ${label}, got: ${policyErrors.join(" | ")}`,
    );
  });
}

test("rejects a runtime-source symlink under src", async (t) => {
  const { root, srcDir } = setup(t, { src: { "index.ts": 'import pino from "pino";\nexport const a = pino;\n' } });
  const syntheticDirent = {
    name: "linked.ts",
    isSymbolicLink: () => true,
    isDirectory: () => false,
    isFile: () => false,
  };
  const readdir = async (dir, options) => {
    const real = await fs.promises.readdir(dir, options);
    if (path.resolve(dir) === path.resolve(srcDir)) return [...real, syntheticDirent];
    return real;
  };
  const { policyErrors, readErrors } = await runBoundaryCheck(root, { readdir });
  assert.ok(
    hasSubstr(policyErrors, "linked.ts: runtime-source symlinks are forbidden"),
    policyErrors.join(" | "),
  );
  assert.deepEqual(readErrors, []);
});

// --------------------------------------------------------------------------
// Manifest content policy
// --------------------------------------------------------------------------

test("rejects an extra runtime dependency", async (t) => {
  const manifest = defaultManifest();
  manifest.dependencies = { ...manifest.dependencies, express: "^4.0.0" };
  const { root } = setup(t, { manifestObject: manifest, src: { "index.ts": "export const a = 1;\n" } });
  const { policyErrors } = await runBoundaryCheck(root);
  assert.ok(hasSubstr(policyErrors, "runtime dependencies must equal"), policyErrors.join(" | "));
});

test("rejects a missing runtime dependency (worker-protocol only, no pino)", async (t) => {
  const manifest = defaultManifest();
  manifest.dependencies = { "@armyofagents/worker-protocol": "workspace:*" };
  const { root } = setup(t, { manifestObject: manifest, src: { "index.ts": "export const a = 1;\n" } });
  const { policyErrors } = await runBoundaryCheck(root);
  assert.ok(hasSubstr(policyErrors, "runtime dependencies must equal"), policyErrors.join(" | "));
});

test("rejects a forbidden dependency swapped in for pino", async (t) => {
  const manifest = defaultManifest();
  manifest.dependencies = { "@armyofagents/worker-protocol": "workspace:*", "@armyofagents/db": "workspace:*" };
  const { root } = setup(t, { manifestObject: manifest, src: { "index.ts": "export const a = 1;\n" } });
  const { policyErrors } = await runBoundaryCheck(root);
  assert.ok(hasSubstr(policyErrors, "runtime dependencies must equal"), policyErrors.join(" | "));
});

test("rejects a wrong package name", async (t) => {
  const manifest = defaultManifest();
  manifest.name = "@armyofagents/not-worker-daemon";
  const { root } = setup(t, { manifestObject: manifest, src: { "index.ts": "export const a = 1;\n" } });
  const { policyErrors } = await runBoundaryCheck(root);
  assert.ok(hasSubstr(policyErrors, "unexpected package name"), policyErrors.join(" | "));
});

// --------------------------------------------------------------------------
// Filesystem read/parse errors are reported separately
// --------------------------------------------------------------------------

test("RED baseline: missing package reports missing manifest AND missing src", async (t) => {
  const { root } = setup(t, { manifestText: null, src: null });
  const { policyErrors, readErrors } = await runBoundaryCheck(root);
  assert.ok(hasSubstr(readErrors, "packages/worker-daemon/package.json: missing or unreadable"), readErrors.join(" | "));
  assert.ok(hasSubstr(readErrors, "packages/worker-daemon/src: missing"), readErrors.join(" | "));
  assert.deepEqual(policyErrors, []);
});

test("invalid manifest JSON is a read/parse error", async (t) => {
  const { root } = setup(t, { manifestText: "{ not json ", src: { "index.ts": "export const a = 1;\n" } });
  const { readErrors } = await runBoundaryCheck(root);
  assert.ok(hasSubstr(readErrors, "package.json: invalid JSON"), readErrors.join(" | "));
});

test("an unreadable source file reports its real path/cause as a read error, not a policy result", async (t) => {
  const { root, srcDir } = setup(t, { src: { "index.ts": 'import pino from "pino";\nexport const a = pino;\n' } });
  const target = path.join(srcDir, "index.ts");
  const readFile = async (p, enc) => {
    if (path.resolve(p) === path.resolve(target)) {
      const err = new Error("permission denied");
      err.code = "EACCES";
      throw err;
    }
    return realReadFile(p, enc);
  };
  const { policyErrors, readErrors } = await runBoundaryCheck(root, { readFile });
  assert.ok(hasSubstr(readErrors, "index.ts: unreadable source (EACCES)"), readErrors.join(" | "));
  assert.deepEqual(policyErrors, [], `should not be mislabeled as policy: ${policyErrors.join(" | ")}`);
});

// --------------------------------------------------------------------------
// B1/S1/S4 regression corpus — CommonJS require bridge, hidden dependency
// types, and pino subpath traversal (added after the WRK-001 adversarial review).
// --------------------------------------------------------------------------

test("B1: CommonJS require() call is rejected (bypasses the static import allowlist)", async (t) => {
  const { root } = setup(t, { src: { "index.ts": 'export const pool = require("pg");\n' } });
  const { policyErrors } = await runBoundaryCheck(root);
  assert.ok(
    hasSubstr(policyErrors, "CommonJS require() is forbidden"),
    `expected require() rejection, got: ${policyErrors.join(" | ")}`,
  );
});

test("B1: module.require() plus its node:module bridge import are both rejected", async (t) => {
  const { root } = setup(t, {
    src: { "index.ts": 'import m from "node:module"; export const x = m.require("@armyofagents/db");\n' },
  });
  const { policyErrors } = await runBoundaryCheck(root);
  assert.ok(
    hasSubstr(policyErrors, 'forbidden runtime import "node:module"') &&
      hasSubstr(policyErrors, "CommonJS require() is forbidden"),
    `expected node:module + require() rejection, got: ${policyErrors.join(" | ")}`,
  );
});

test("B1: node:module (createRequire source) is rejected even though it is a Node builtin", async (t) => {
  const { root } = setup(t, {
    src: {
      "index.ts":
        'import { createRequire } from "node:module";\n' +
        "export const r = createRequire(import.meta.url);\n",
    },
  });
  const { policyErrors } = await runBoundaryCheck(root);
  assert.ok(
    hasSubstr(policyErrors, 'forbidden runtime import "node:module"'),
    `expected node:module rejection, got: ${policyErrors.join(" | ")}`,
  );
});

for (const field of ["optionalDependencies", "peerDependencies"]) {
  test(`S1: a forbidden dep hidden in ${field} is rejected`, async (t) => {
    const manifest = defaultManifest();
    manifest[field] = { "drizzle-orm": "*" };
    const { root } = setup(t, { manifestObject: manifest, src: { "index.ts": "export const x = 1;\n" } });
    const { policyErrors } = await runBoundaryCheck(root);
    assert.ok(
      hasSubstr(policyErrors, "runtime dependencies must equal"),
      `expected ${field} rejection, got: ${policyErrors.join(" | ")}`,
    );
  });
}

test("S1: a forbidden dep in bundledDependencies is rejected", async (t) => {
  const manifest = defaultManifest();
  manifest.bundledDependencies = ["pg"];
  const { root } = setup(t, { manifestObject: manifest, src: { "index.ts": "export const x = 1;\n" } });
  const { policyErrors } = await runBoundaryCheck(root);
  assert.ok(
    hasSubstr(policyErrors, "runtime dependencies must equal"),
    `expected bundledDependencies rejection, got: ${policyErrors.join(" | ")}`,
  );
});

test("S4: a pino/.. traversal specifier is rejected", async (t) => {
  const { root } = setup(t, { src: { "index.ts": 'import { db } from "pino/../@armyofagents/db";\n' } });
  const { policyErrors } = await runBoundaryCheck(root);
  assert.ok(
    hasSubstr(policyErrors, "forbidden runtime import"),
    `expected pino/.. traversal rejection, got: ${policyErrors.join(" | ")}`,
  );
});
