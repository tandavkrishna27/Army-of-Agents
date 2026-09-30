#!/usr/bin/env node
/**
 * Mutation / decoy / bypass corpus for the adapter-manager boundary gate
 * (DEP-012 Slice 3 · Wave β2, §β2.2.2 / §β2.4.1). Run with:
 *   node --test scripts/check-adapter-manager-boundary.test.mjs
 *
 * A checker nobody has tried to defeat is not a guard. This proves, against
 * synthetic package trees, that the gate REJECTS each way the `e2b` provider
 * closure could leak into the adapter-manager REQUEST PATH, and ACCEPTS the
 * legitimate shape — plus that the real package on disk passes clean.
 *
 * WHY THE CONFINEMENT MATTERS. `packages/adapter-manager` is the out-of-process
 * host of the per-op SandboxProvider. Its request-path files (server.ts, the
 * ownership gate, the create-gate, the durable ledger, the capability verifier,
 * the keyed mutex) must stay PROVIDER-FREE: the `e2b` network SDK (and the
 * provider-control credential it fronts) may enter this process image from
 * EXACTLY ONE composition-root file, `src/bin/adapter-manager.ts`, and nowhere
 * else. Review cannot guarantee that; a mechanical PATH+prefix confinement can.
 *
 * ★ SUBPATH-AWARE ALLOW-LIST (review G1). Unlike the worker-keystore template's
 * EXACT-match ALLOWED_BARE, the adapter-manager request path legitimately imports
 * provider-wire SUBPATHS (`@armyofagents/provider-wire/codec`,
 * `@armyofagents/provider-wire/capability`). A faithful exact-match copy would RED
 * the shipped tree; so the non-confined deps are allow-listed BARE and by subpath.
 * The provider package, by contrast, is confined PREFIX-based (bare AND subpath)
 * to the one bin file — a bare-only match would let a provider subpath leak.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runBoundaryCheck, ADAPTER_MANAGER_BOUNDARY_PACKAGES } from "./check-adapter-manager-boundary.mjs";

const PKG_REL = "packages/adapter-manager";
const PKG_NAME = "@armyofagents/adapter-manager";
const ONE_PACKAGE = [{ rel: PKG_REL, name: PKG_NAME }];
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = "/synthetic";

function manifest(over = {}) {
  return {
    name: PKG_NAME,
    version: "0.1.0",
    private: true,
    type: "module",
    dependencies: {
      // β2.2.3: the provider dep is a RUNTIME dependency (devDep→dep), because the
      // composition-root bin dynamically imports it. The exact three-element pin
      // lives here so every `checkTree` case stands on the required set.
      "@armyofagents/provider-wire": "workspace:*",
      "@armyofagents/sandbox-e2b-provider": "workspace:*",
      "@armyofagents/worker-daemon": "workspace:*",
    },
    devDependencies: { "@types/node": "^24.6.0", typescript: "^5.7.3", vitest: "^3.2.6" },
    ...over,
  };
}

/** Build an in-memory package tree and run the real checker against it. */
function checkTree({ files, pkg = manifest() }) {
  const srcRel = `${PKG_REL}/src`;
  const readFile = async (absolute) => {
    const rel = path.relative(ROOT, absolute).replaceAll("\\", "/");
    if (rel === `${PKG_REL}/package.json`) return JSON.stringify(pkg);
    const name = rel.slice(srcRel.length + 1);
    if (Object.hasOwn(files, name)) return files[name];
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  // Directory listing that understands nested directories (so a same-named file in
  // a subdirectory is actually walked, which is how the PATH-vs-basename case bites).
  const readdir = async (absolute) => {
    const rel = path.relative(ROOT, absolute).replaceAll("\\", "/");
    const prefix = rel === srcRel ? "" : `${rel.slice(srcRel.length + 1)}/`;
    const childDirs = new Set();
    const childFiles = [];
    for (const name of Object.keys(files)) {
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) childFiles.push(rest);
      else childDirs.add(rest.slice(0, slash));
    }
    return [
      ...[...childDirs].map((name) => ({
        name,
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      })),
      ...childFiles.map((name) => ({
        name,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      })),
    ];
  };
  return runBoundaryCheck(ROOT, { readFile, readdir, packages: ONE_PACKAGE });
}

// The legitimate request-path shape: provider-wire bare AND subpath, worker-daemon
// bare, node builtins — all provider-free — plus the ONE bin that names the provider.
const clean = {
  "server.ts":
    'import { createServer } from "node:http";\n' +
    'import { decodeOpRequest } from "@armyofagents/provider-wire/codec";\n' +
    'import type { OwnedLabelsCapability } from "@armyofagents/provider-wire";\n' +
    'import type { SandboxProvider } from "@armyofagents/worker-daemon";\n',
  "capability-verify.ts":
    'import { createPublicKey } from "node:crypto";\n' +
    'import { decodeCapability } from "@armyofagents/provider-wire/capability";\n' +
    'import type { ProviderOpContext } from "@armyofagents/worker-daemon";\n',
  "bin/adapter-manager.ts":
    'const mod = await import("@armyofagents/sandbox-e2b-provider");\n',
};

test("accepts the legitimate provider-free request-path shape + the confined bin", async () => {
  const { policyErrors, readErrors } = await checkTree({ files: clean });
  assert.deepEqual(policyErrors, []);
  assert.deepEqual(readErrors, []);
});

test("ACCEPTS a provider-wire SUBPATH from a request-path file — the false positive an exact-match copy would RED", async () => {
  // server.ts:36 imports `@armyofagents/provider-wire/codec`; capability-verify.ts:28
  // imports `@armyofagents/provider-wire/capability`. The allow-list MUST be subpath-aware.
  const { policyErrors } = await checkTree({
    files: {
      "owned-op-gate.ts": 'import { redactProjection } from "@armyofagents/provider-wire/capability";\n',
    },
  });
  assert.deepEqual(policyErrors, []);
});

test("ACCEPTS worker-daemon bare AND a worker-daemon subpath from a request-path file", async () => {
  const { policyErrors } = await checkTree({
    files: {
      "create-gate.ts":
        'import type { SandboxProvider } from "@armyofagents/worker-daemon";\n' +
        'import { SandboxNotFoundError } from "@armyofagents/worker-daemon/errors";\n',
    },
  });
  assert.deepEqual(policyErrors, []);
});

test("REJECTS the provider package imported BARE from a request-path (non-bin) file", async () => {
  for (const name of ["server.ts", "owned-op-gate.ts", "create-gate.ts", "index.ts"]) {
    const { policyErrors } = await checkTree({
      files: { [name]: 'const m = await import("@armyofagents/sandbox-e2b-provider");\n' },
    });
    assert.equal(policyErrors.length, 1, `${name} should be rejected`);
    assert.match(policyErrors[0], /may be imported ONLY from src\/bin\/adapter-manager\.ts/);
  }
});

test("REJECTS a provider SUBPATH from a request-path (non-bin) file — the bare-only-match bypass this closes", async () => {
  // The prefix-based confinement: `@armyofagents/sandbox-e2b-provider/real-transport.js`
  // ALSO pulls the `e2b` SDK, so it is confined to the bin exactly like the bare barrel.
  const { policyErrors } = await checkTree({
    files: { "server.ts": 'import { createRealE2bTransport } from "@armyofagents/sandbox-e2b-provider/real-transport.js";\n' },
  });
  assert.equal(policyErrors.length, 1);
  assert.match(policyErrors[0], /may be imported ONLY from src\/bin\/adapter-manager\.ts/);
});

test("ACCEPTS the provider package imported BARE from the ONE bin path", async () => {
  const { policyErrors } = await checkTree({
    files: { "bin/adapter-manager.ts": 'const m = await import("@armyofagents/sandbox-e2b-provider");\n' },
  });
  assert.deepEqual(policyErrors, []);
});

test("REJECTS a SAME-NAMED bin file in a subdirectory — the confinement is a PATH, not a basename", async () => {
  // The exact hole the worker-keystore SUBPROCESS_HOST_PATH history taught: a basename
  // check let `src/anything/<host>.ts` inherit the permission. Keyed on the full path.
  for (const name of ["bin/nested/adapter-manager.ts", "sneaky/adapter-manager.ts"]) {
    const { policyErrors } = await checkTree({
      files: { [name]: 'const m = await import("@armyofagents/sandbox-e2b-provider");\n' },
    });
    assert.equal(policyErrors.length, 1, `${name} should be rejected`);
    assert.match(policyErrors[0], /may be imported ONLY from src\/bin\/adapter-manager\.ts/);
  }
});

test("REJECTS a direct `e2b` import ANYWHERE — including the bin (the SDK is transitive, never named)", async () => {
  for (const name of ["server.ts", "bin/adapter-manager.ts"]) {
    const { policyErrors } = await checkTree({
      files: { [name]: 'import { Sandbox } from "e2b";\n' },
    });
    assert.equal(policyErrors.length, 1, `${name} should be rejected`);
    assert.match(policyErrors[0], /forbidden runtime import/);
  }
});

test("REJECTS the provider-control credential token in CODE, in ANY file (incl. the bin)", async () => {
  for (const name of ["server.ts", "owned-op-gate.ts", "bin/adapter-manager.ts"]) {
    const { policyErrors } = await checkTree({
      files: { [name]: "const k = process.env.E2B_API_KEY;\n" },
    });
    assert.ok(
      policyErrors.some((e) => e.includes("E2B_API_KEY")),
      `${name}: ${JSON.stringify(policyErrors)}`,
    );
  }
});

test("REJECTS the provider-control credential token in a COMMENT — the scan is over RAW source", async () => {
  const { policyErrors } = await checkTree({
    files: { "server.ts": "// the transport reads E2B_API_KEY itself; never named here\nexport const x = 1;\n" },
  });
  assert.ok(policyErrors.some((e) => e.includes("E2B_API_KEY")), JSON.stringify(policyErrors));
});

test("REJECTS `e2b` added to the required runtime dependency set (exact-set)", async () => {
  const { policyErrors } = await checkTree({
    files: clean,
    pkg: manifest({
      dependencies: {
        "@armyofagents/provider-wire": "workspace:*",
        "@armyofagents/sandbox-e2b-provider": "workspace:*",
        "@armyofagents/worker-daemon": "workspace:*",
        e2b: "^1.0.0",
      },
    }),
  });
  assert.equal(policyErrors.length, 1);
  assert.match(policyErrors[0], /runtime dependencies must equal/);
});

test("REJECTS dropping the provider dep from the required set (exact-set)", async () => {
  const { policyErrors } = await checkTree({
    files: clean,
    pkg: manifest({
      dependencies: {
        "@armyofagents/provider-wire": "workspace:*",
        "@armyofagents/worker-daemon": "workspace:*",
      },
    }),
  });
  assert.equal(policyErrors.length, 1);
  assert.match(policyErrors[0], /runtime dependencies must equal/);
});

test("REJECTS a dependency moved into peerDependencies to dodge the exact-set check", async () => {
  const { policyErrors } = await checkTree({
    files: clean,
    pkg: manifest({ peerDependencies: { e2b: "^1.0.0" } }),
  });
  assert.equal(policyErrors.length, 1);
  assert.match(policyErrors[0], /runtime dependencies must equal/);
});

test("REJECTS a non-literal import, which would defeat lexical confinement entirely", async () => {
  const { policyErrors } = await checkTree({
    files: { "server.ts": "const m = await import(someName);\n" },
  });
  assert.equal(policyErrors.length, 1);
  assert.match(policyErrors[0], /non-literal/);
});

test("REJECTS a forbidden bare import into the request-path host", async () => {
  for (const spec of ["@armyofagents/db", "@armyofagents/server", "drizzle-orm", "pg", "express"]) {
    const { policyErrors } = await checkTree({
      files: { "server.ts": `import x from "${spec}";\n` },
    });
    assert.equal(policyErrors.length, 1, spec);
    assert.match(policyErrors[0], /forbidden runtime import/);
  }
});

test("REJECTS a relative import that escapes the package src", async () => {
  const { policyErrors } = await checkTree({
    files: { "server.ts": 'import x from "../../sandbox-e2b-provider/src/real-transport.js";\n' },
  });
  assert.equal(policyErrors.length, 1);
  assert.match(policyErrors[0], /escapes package src/);
});

test("REJECTS a wrong package name", async () => {
  const { policyErrors } = await checkTree({ files: clean, pkg: manifest({ name: "@armyofagents/not-this" }) });
  assert.equal(policyErrors.length, 1);
  assert.match(policyErrors[0], /unexpected package name/);
});

test("the REAL package on disk passes clean", async () => {
  const { policyErrors, readErrors } = await runBoundaryCheck(REPO_ROOT, {
    packages: ADAPTER_MANAGER_BOUNDARY_PACKAGES,
  });
  assert.deepEqual(readErrors, []);
  assert.deepEqual(policyErrors, []);
});
