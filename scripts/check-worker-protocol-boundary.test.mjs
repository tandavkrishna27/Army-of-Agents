#!/usr/bin/env node
/**
 * Mutation / decoy / bypass corpus for the worker-protocol boundary gate.
 *
 * Run with:
 *   node --test scripts/check-worker-protocol-boundary.test.mjs
 *
 * Each case builds a minimal temporary package tree under an isolated root,
 * runs `runBoundaryCheck(root)`, and asserts the exact import-policy violation
 * or filesystem read/parse error. The corpus proves:
 *   - rejection of every alternate runtime-source extension;
 *   - rejection of a runtime import of a `.test` source;
 *   - rejection of Node/runtime globals + `require()` / `module.require()`;
 *   - rejection of `node:fs`, bare `fs`/`crypto`, and every non-`zod` bare pkg;
 *   - rejection of runtime-source symlinks;
 *   - rejection of relative escapes across static, side-effect, `export … from`,
 *     and literal dynamic `import(...)`;
 *   - that comment / string / template / multiline DECOYS never trip, while one
 *     real bypass attempt per syntax DOES;
 *   - that a missing/unreadable source is reported as a read error (with its
 *     real path/cause), never mislabeled as a policy result;
 *   - that `zod` and relative specifiers inside `src` are ALLOWED.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile as realReadFile } from "node:fs/promises";

import { runBoundaryCheck } from "./check-worker-protocol-boundary.mjs";
import {
  extractModuleSpecifiers,
  findForbiddenGlobals,
} from "./lib/worker-protocol-boundary.mjs";

const VALID_VERSION_TS = "export const MIN_PROTOCOL_VERSION = 1 as const;\nexport const PROTOCOL_VERSION = 1 as const;\n";

function defaultManifest() {
  return {
    name: "@armyofagents/worker-protocol",
    version: "0.1.0",
    private: true,
    type: "module",
    dependencies: { zod: "3.24.2" },
  };
}

/**
 * @param {import("node:test").TestContext} t
 * @param {{manifestText?:string|null, manifestObject?:object, src?:Record<string,string>|null}} opts
 */
function setup(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wpb-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkgDir = path.join(root, "packages", "worker-protocol");
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
// Valid baseline + decoys
// --------------------------------------------------------------------------

test("valid baseline with zod, relative imports, and decoys passes clean", async (t) => {
  const decoys = [
    "import { z } from \"zod\";",
    "import { PROTOCOL_VERSION } from \"./version.js\";",
    "import { helper } from \"./sub/helper.js\";",
    "// import evil from \"node:fs\"",
    "/* import bad from \"fs\";\n   export * from \"crypto\"; */",
    "const decoyString = \"import x from 'node:fs'; require('fs'); process.exit()\";",
    "const tmpl = `text mentioning process and require( and import from fs ${PROTOCOL_VERSION}`;",
    "const re = /import\\s+process\\s+from\\s+\"fs\"/;",
    "export {",
    "  z,",
    "  PROTOCOL_VERSION,",
    "} from \"zod\";",
    "export const value = z ? PROTOCOL_VERSION : helper;",
    "",
  ].join("\n");
  const { root } = setup(t, {
    src: {
      "version.ts": VALID_VERSION_TS,
      "sub/helper.ts": "export const helper = 1;\n",
      "index.ts": decoys,
    },
  });
  const { policyErrors, readErrors } = await runBoundaryCheck(root);
  assert.deepEqual(policyErrors, [], `unexpected policy errors: ${policyErrors.join(" | ")}`);
  assert.deepEqual(readErrors, [], `unexpected read errors: ${readErrors.join(" | ")}`);
});

// --------------------------------------------------------------------------
// Alternate runtime-source extensions
// --------------------------------------------------------------------------

for (const ext of ["d.ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
  test(`rejects alternate runtime-source extension .${ext}`, async (t) => {
    const { root } = setup(t, {
      src: { "version.ts": VALID_VERSION_TS, [`extra.${ext}`]: "export {};\n" },
    });
    const { policyErrors, readErrors } = await runBoundaryCheck(root);
    assert.ok(
      hasSubstr(policyErrors, `extra.${ext}: alternate runtime-source extensions are forbidden`),
      `expected alternate-extension rejection for .${ext}, got: ${policyErrors.join(" | ")}`,
    );
    assert.deepEqual(readErrors, []);
  });
}

// --------------------------------------------------------------------------
// Test-source imports
// --------------------------------------------------------------------------

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

// --------------------------------------------------------------------------
// Node/runtime globals + require()
// --------------------------------------------------------------------------

const GLOBAL_SNIPPETS = {
  process: "export const a = process.env.HOME;\n",
  Buffer: "export const a = Buffer.from(\"x\");\n",
  globalThis: "export const a = globalThis;\n",
  global: "export const a = global;\n",
  Deno: "export const a = Deno;\n",
  Bun: "export const a = Bun;\n",
  __dirname: "export const a = __dirname;\n",
  __filename: "export const a = __filename;\n",
};
for (const [name, src] of Object.entries(GLOBAL_SNIPPETS)) {
  test(`rejects Node/runtime global ${name}`, async (t) => {
    const { root } = setup(t, { src: { "index.ts": src } });
    const { policyErrors } = await runBoundaryCheck(root);
    assert.ok(
      hasSubstr(policyErrors, `forbidden Node/runtime global ${JSON.stringify(name)}`),
      `expected ${name} rejection, got: ${policyErrors.join(" | ")}`,
    );
  });
}

test("rejects require() call", async (t) => {
  const { root } = setup(t, { src: { "index.ts": "const fs = require(\"fs\");\nexport { fs };\n" } });
  const { policyErrors } = await runBoundaryCheck(root);
  assert.ok(hasSubstr(policyErrors, 'forbidden Node/runtime global "require("'), policyErrors.join(" | "));
});

test("rejects module.require() call", async (t) => {
  const { root } = setup(t, { src: { "index.ts": "const fs = module.require(\"fs\");\nexport { fs };\n" } });
  const { policyErrors } = await runBoundaryCheck(root);
  assert.ok(hasSubstr(policyErrors, 'forbidden Node/runtime global "require("'), policyErrors.join(" | "));
});

test("allows member access of a global-like name (foo.process); bare globals fail closed", async (t) => {
  // Member access (`.process`) is a property read, not a global value, so it is
  // allowed. A BARE identifier equal to a global name is flagged fail-closed —
  // the gate deliberately does NOT try to exempt property-key positions, because
  // the same relaxation would let `cond ? process : x` (a real global read)
  // slip through. Property keys named exactly like a Node global are
  // vanishingly rare in a wire-protocol schema; a false positive there is a
  // safe, visible failure the author resolves by renaming.
  const { root } = setup(t, {
    src: { "index.ts": "export const g = config.process;\nexport const h = config.Buffer;\n" },
  });
  const { policyErrors } = await runBoundaryCheck(root);
  assert.ok(
    !policyErrors.some((e) => e.includes("global")),
    `member access should not be flagged, got: ${policyErrors.join(" | ")}`,
  );
});

// --------------------------------------------------------------------------
// Forbidden bare / node: imports
// --------------------------------------------------------------------------

const FORBIDDEN_IMPORTS = {
  "node:fs": 'import { readFile } from "node:fs";\n',
  fs: 'import fs from "fs";\n',
  crypto: 'import { createHash } from "crypto";\n',
  "node:path": 'import path from "node:path";\n',
  express: 'import express from "express";\n',
  "@armyofagents/db": 'import { db } from "@armyofagents/db";\n',
  lodash: 'import _ from "lodash";\n',
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

// --------------------------------------------------------------------------
// Relative escapes across every syntax
// --------------------------------------------------------------------------

const ESCAPES = {
  "static import": 'import { x } from "../../../server/x.js";\n',
  "side-effect import": 'import "../../shared/y.js";\n',
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

// --------------------------------------------------------------------------
// One real bypass attempt per supported syntax (must trip)
// --------------------------------------------------------------------------

const BYPASSES = {
  "side-effect": { src: 'import "node:fs";\n', needle: 'forbidden runtime import "node:fs"' },
  static: { src: 'import fs from "node:fs";\n', needle: 'forbidden runtime import "node:fs"' },
  "export-from": { src: 'export * from "node:crypto";\n', needle: 'forbidden runtime import "node:crypto"' },
  dynamic: {
    src: 'export async function f() { return import("fs"); }\n',
    needle: 'forbidden runtime import "fs"',
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
// Symlink rejection (readdir injection — portable across OSes)
// --------------------------------------------------------------------------

test("rejects a runtime-source symlink under src", async (t) => {
  const { root, srcDir } = setup(t, { src: { "version.ts": VALID_VERSION_TS } });
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
// Filesystem read/parse errors are reported separately
// --------------------------------------------------------------------------

test("RED baseline: missing package reports missing manifest AND missing src", async (t) => {
  const { root } = setup(t, { manifestText: null, src: null });
  const { policyErrors, readErrors } = await runBoundaryCheck(root);
  assert.ok(hasSubstr(readErrors, `${"packages/worker-protocol/package.json"}: missing or unreadable`), readErrors.join(" | "));
  assert.ok(hasSubstr(readErrors, `${"packages/worker-protocol/src"}: missing`), readErrors.join(" | "));
  assert.deepEqual(policyErrors, []);
});

test("missing manifest is a read error, not a policy error", async (t) => {
  const { root } = setup(t, { manifestText: null, src: { "version.ts": VALID_VERSION_TS } });
  const { policyErrors, readErrors } = await runBoundaryCheck(root);
  assert.ok(hasSubstr(readErrors, "package.json: missing or unreadable"), readErrors.join(" | "));
  assert.deepEqual(policyErrors, []);
});

test("invalid manifest JSON is a read/parse error", async (t) => {
  const { root } = setup(t, { manifestText: "{ not json ", src: { "version.ts": VALID_VERSION_TS } });
  const { readErrors } = await runBoundaryCheck(root);
  assert.ok(hasSubstr(readErrors, "package.json: invalid JSON"), readErrors.join(" | "));
});

test("missing src directory is a read error", async (t) => {
  const { root } = setup(t, { src: null });
  const { policyErrors, readErrors } = await runBoundaryCheck(root);
  assert.ok(hasSubstr(readErrors, "packages/worker-protocol/src: missing"), readErrors.join(" | "));
  assert.deepEqual(policyErrors, []);
});

test("an unreadable source file reports its real path/cause as a read error, not a policy result", async (t) => {
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
  const { policyErrors, readErrors } = await runBoundaryCheck(root, { readFile });
  assert.ok(hasSubstr(readErrors, "index.ts: unreadable source (EACCES)"), readErrors.join(" | "));
  assert.deepEqual(policyErrors, [], `should not be mislabeled as policy: ${policyErrors.join(" | ")}`);
});

// --------------------------------------------------------------------------
// Manifest content policy
// --------------------------------------------------------------------------

test("rejects an extra runtime dependency", async (t) => {
  const manifest = defaultManifest();
  manifest.dependencies = { zod: "3.24.2", express: "^4.0.0" };
  const { root } = setup(t, { manifestObject: manifest, src: { "version.ts": VALID_VERSION_TS } });
  const { policyErrors } = await runBoundaryCheck(root);
  assert.ok(hasSubstr(policyErrors, "runtime dependencies must equal"), policyErrors.join(" | "));
});

test("rejects a wrong package name", async (t) => {
  const manifest = defaultManifest();
  manifest.name = "@armyofagents/not-worker-protocol";
  const { root } = setup(t, { manifestObject: manifest, src: { "version.ts": VALID_VERSION_TS } });
  const { policyErrors } = await runBoundaryCheck(root);
  assert.ok(hasSubstr(policyErrors, "unexpected package name"), policyErrors.join(" | "));
});

test("allows an empty dependencies object only if it equals [zod] — rejects none", async (t) => {
  const manifest = defaultManifest();
  delete manifest.dependencies;
  const { root } = setup(t, { manifestObject: manifest, src: { "version.ts": VALID_VERSION_TS } });
  const { policyErrors } = await runBoundaryCheck(root);
  assert.ok(hasSubstr(policyErrors, "runtime dependencies must equal"), policyErrors.join(" | "));
});

// --------------------------------------------------------------------------
// Direct scanner unit contracts (decoy correctness)
// --------------------------------------------------------------------------

test("extractModuleSpecifiers ignores comment/string/template decoys", () => {
  const src = [
    '// import a from "node:fs"',
    '/* import b from "fs" */',
    'const s = "import c from \'crypto\'";',
    "const t = `import d from ${\"zzz\"} fs`;",
    'import { z } from "zod";',
    'export * from "./local.js";',
  ].join("\n");
  const specs = extractModuleSpecifiers(src).map((s) => s.value);
  assert.deepEqual(specs, ["zod", "./local.js"]);
});

test("extractModuleSpecifiers handles multiline import and dynamic import", () => {
  const src = 'import {\n  a,\n  b,\n} from "zod";\nconst p = import("./x.js");\n';
  const specs = extractModuleSpecifiers(src).map((s) => s.value);
  assert.deepEqual(specs, ["zod", "./x.js"]);
});

test("findForbiddenGlobals sees interpolation code but not string/comment text", () => {
  const src = [
    'const a = "process and Buffer and require()";',
    "// process Buffer require(",
    "const b = `${process}`;",
  ].join("\n");
  assert.deepEqual(findForbiddenGlobals(src), ["process"]);
});
