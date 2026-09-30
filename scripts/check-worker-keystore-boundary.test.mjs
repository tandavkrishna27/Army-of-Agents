#!/usr/bin/env node
/**
 * Mutation / decoy / bypass corpus for the worker-keystore boundary gate
 * (DSK-001 D2 / I23). Run with:
 *   node --test scripts/check-worker-keystore-boundary.test.mjs
 *
 * A checker nobody has tried to defeat is not a guard. This proves, against
 * synthetic package trees, that the gate REJECTS each way the confinement could
 * be lost, and ACCEPTS the legitimate shape — plus that the real package on disk
 * passes clean.
 *
 * The confinement matters because a private device key crosses a process
 * boundary on stdin. Every decision about how that happens is pure and OS-free so
 * it can be proven on the ubuntu-only REQUIRED lane; that only means something if
 * the dangerous capability genuinely stays in one file.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runBoundaryCheck, WORKER_KEYSTORE_BOUNDARY_PACKAGES } from "./check-worker-keystore-boundary.mjs";

const PKG_REL = "packages/worker-keystore";
const PKG_NAME = "@armyofagents/worker-keystore";
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
      // DEP-010 (D-3): the provider dep the host resolves and injects. Every case built through
      // `checkTree` stands on this default, so the three-element pin lives here, not per-case.
      "@armyofagents/sandbox-e2b-provider": "workspace:*",
      "@armyofagents/worker-daemon": "workspace:*",
      "@armyofagents/worker-protocol": "workspace:*",
    },
    devDependencies: { typescript: "^5.7.3", vitest: "^3.2.6" },
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
  const readdir = async (absolute) => {
    const rel = path.relative(ROOT, absolute).replaceAll("\\", "/");
    if (rel !== srcRel) return [];
    return Object.keys(files).map((name) => ({
      name,
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
    }));
  };
  return runBoundaryCheck(ROOT, { readFile, readdir, packages: ONE_PACKAGE });
}

const clean = { "command-runner.ts": 'import { execFileSync } from "node:child_process";\n' };

test("accepts the legitimate shape", async () => {
  const { policyErrors, readErrors } = await checkTree({ files: clean });
  assert.deepEqual(policyErrors, []);
  assert.deepEqual(readErrors, []);
});

test("accepts child_process imported from the confinement host", async () => {
  const { policyErrors } = await checkTree({
    files: { "command-runner.ts": 'import cp from "child_process";\nimport { statSync } from "node:fs";\n' },
  });
  assert.deepEqual(policyErrors, []);
});

test("REJECTS child_process imported from any other runtime file", async () => {
  for (const name of ["outcome.ts", "identity-store.ts", "index.ts", "sneaky-runner.ts"]) {
    const { policyErrors } = await checkTree({
      files: { ...clean, [name]: 'import { execFileSync } from "node:child_process";\n' },
    });
    assert.equal(policyErrors.length, 1, `${name} should be rejected`);
    assert.match(policyErrors[0], /may be imported ONLY from src\/command-runner\.ts/);
  }
});

test("REJECTS a SAME-NAMED file in a subdirectory — the confinement is a PATH, not a basename", async () => {
  // This passed before the fix: the check keyed on `path.basename`, so anyone who
  // created `src/anything/command-runner.ts` inherited spawn permission. Verified
  // live against the real tree before and after.
  const { policyErrors } = await checkTree({
    files: { ...clean, "sneaky/command-runner.ts": 'import { execFileSync } from "node:child_process";\n' },
  });
  assert.equal(policyErrors.length, 1);
  assert.match(policyErrors[0], /ONE PATH/);
});

test("REJECTS the bare `child_process` specifier too, not just the node: form", async () => {
  const { policyErrors } = await checkTree({
    files: { ...clean, "outcome.ts": 'import { execFileSync } from "child_process";\n' },
  });
  assert.equal(policyErrors.length, 1);
});

test("REJECTS the real ENTRY POINT spawning a subprocess", async () => {
  // Plan §1D asked for this case specifically. `bin/aoa-worker-desktop.ts` is the
  // shipped executable and the process that holds an enrollment ticket; it is
  // exactly where someone would reach for a shell "just to check something".
  // It composes `command-runner` like every other module and never spawns itself.
  const { policyErrors } = await checkTree({
    files: {
      ...clean,
      "bin/aoa-worker-desktop.ts": 'import { execFileSync } from "node:child_process";\n',
    },
  });
  assert.equal(policyErrors.length, 1);
  assert.match(policyErrors[0], /ONE PATH/);
});

test("REJECTS existsSync ANYWHERE, including in the confinement host itself", async () => {
  // The boolean absence oracle. `node:fs` stays legitimate — statSync throws with
  // a discriminating errno and is what the probe is built on — so this is banned
  // by NAME, not by specifier. existsSync returns false for ANY error, so a
  // permission-denied probe reads as "never enrolled", the daemon mints a second
  // identity, and the server denies it forever. That bug shipped once.
  const cases = [
    ["command-runner.ts", 'import { existsSync } from "node:fs";'],
    ["outcome.ts", 'import fs from "node:fs";\nconst ok = fs.existsSync(p);'],
  ];
  for (const [name, source] of cases) {
    const { policyErrors } = await checkTree({ files: { ...clean, [name]: source + "\n" } });
    assert.ok(
      policyErrors.some((e) => e.includes("existsSync is forbidden")),
      `${name} should be rejected: ${JSON.stringify(policyErrors)}`,
    );
  }
});

test("ACCEPTS statSync — the ban is on the ORACLE, not on node:fs", async () => {
  const { policyErrors } = await checkTree({
    files: { ...clean, "outcome.ts": 'import { statSync } from "node:fs";\n' },
  });
  assert.deepEqual(policyErrors, []);
});

test("ACCEPTS the word inside a COMMENT — explaining the bug must stay legal", async () => {
  // The real package documents why existsSync was removed. A raw-substring scan
  // flagged exactly that documentation, which would have forced deleting the
  // explanation of the bug in order to satisfy the checker.
  const { policyErrors } = await checkTree({
    files: {
      ...clean,
      "outcome.ts": "// an earlier version used existsSync, which fails open\nexport const x = 1;\n",
    },
  });
  assert.deepEqual(policyErrors, []);
});

// ─── DEP-010 — the provider package is confined to ONE PATH, and the credential is banned ───
//
// The widening (a third runtime dependency, @armyofagents/sandbox-e2b-provider) is PAID FOR by
// making the guard tighter, per go-book §8 D-3 condition (b): the dangerous package may be named
// from EXACTLY ONE file, and the provider-control credential may be named from ZERO — not "one
// host file", zero, because this package has no legitimate reason to carry the credential's name.

test("ACCEPTS the provider package imported from the ONE confinement path", async () => {
  const { policyErrors } = await checkTree({
    files: { ...clean, "bin/sandbox-provider.ts": 'const m = await import("@armyofagents/sandbox-e2b-provider");\n' },
  });
  assert.deepEqual(policyErrors, []);
});

test("REJECTS the provider package imported from any OTHER runtime file", async () => {
  for (const name of ["bin/desktop-host.ts", "identity-store.ts"]) {
    const { policyErrors } = await checkTree({
      files: { ...clean, [name]: 'const m = await import("@armyofagents/sandbox-e2b-provider");\n' },
    });
    assert.equal(policyErrors.length, 1, `${name} should be rejected`);
    assert.match(policyErrors[0], /may be imported ONLY from src\/bin\/sandbox-provider\.ts/);
  }
});

test("REJECTS a SAME-NAMED provider file in a subdirectory — the confinement is a PATH, not a basename", async () => {
  // The exact hole the SUBPROCESS_HOST_PATH history taught: a basename check let
  // `src/anything/command-runner.ts` inherit spawn permission. The provider path keys on the
  // full package-relative path for the same reason.
  const { policyErrors } = await checkTree({
    files: { ...clean, "bin/nested/sandbox-provider.ts": 'const m = await import("@armyofagents/sandbox-e2b-provider");\n' },
  });
  assert.equal(policyErrors.length, 1);
  assert.match(policyErrors[0], /may be imported ONLY from src\/bin\/sandbox-provider\.ts/);
});

test("REJECTS the provider-control credential token in CODE", async () => {
  const { policyErrors } = await checkTree({
    files: { ...clean, "outcome.ts": "const k = process.env.E2B_API_KEY;\n" },
  });
  assert.ok(policyErrors.some((e) => e.includes("E2B_API_KEY")), JSON.stringify(policyErrors));
});

test("REJECTS the provider-control credential token in a COMMENT — the scan is over RAW source", async () => {
  // Unlike existsSync (whose explanation stays legal), the credential's NAME must not live in
  // this key-holding package at ALL. This is the case that passes by accident if the scan
  // tokenizes instead of reading bytes; it mirrors sandbox-e2b-provider-boundary.mjs's raw scan.
  const { policyErrors } = await checkTree({
    files: { ...clean, "outcome.ts": "// the transport reads E2B_API_KEY itself; never named here\nexport const x = 1;\n" },
  });
  assert.ok(policyErrors.some((e) => e.includes("E2B_API_KEY")), JSON.stringify(policyErrors));
});

test("REJECTS a native keychain binding added as a runtime dependency", async () => {
  // The package is injected INTO the daemon's process; keytar arriving here by
  // accident is precisely what the daemon's own two-dependency pin forbids.
  for (const dep of ["keytar", "@napi-rs/keyring", "electron"]) {
    const { policyErrors } = await checkTree({
      files: clean,
      pkg: manifest({
        dependencies: {
          // The provider dep is present, so the ONLY difference from the required set is the
          // keychain binding — otherwise this case would pass even if the keychain ban were
          // removed (the set would still be wrong for the MISSING provider).
          "@armyofagents/sandbox-e2b-provider": "workspace:*",
          "@armyofagents/worker-daemon": "workspace:*",
          "@armyofagents/worker-protocol": "workspace:*",
          [dep]: "^1.0.0",
        },
      }),
    });
    assert.equal(policyErrors.length, 1, `${dep} should be rejected`);
    assert.match(policyErrors[0], /runtime dependencies must equal/);
  }
});

test("REJECTS a dependency moved into peerDependencies to dodge the check", async () => {
  const { policyErrors } = await checkTree({
    files: clean,
    pkg: manifest({ peerDependencies: { keytar: "^7.9.0" } }),
  });
  assert.equal(policyErrors.length, 1);
});

test("REJECTS a non-literal import, which would defeat lexical confinement entirely", async () => {
  const { policyErrors } = await checkTree({
    files: { ...clean, "outcome.ts": "const m = await import(someName);\n" },
  });
  assert.equal(policyErrors.length, 1);
  assert.match(policyErrors[0], /non-literal/);
});

test("REJECTS the node:module createRequire bridge", async () => {
  // createRequire resolves ANY package from the hoisted monorepo node_modules at
  // runtime — a general-purpose escape from every rule above.
  for (const spec of ["node:module", "module"]) {
    const { policyErrors } = await checkTree({
      files: { ...clean, "outcome.ts": `import { createRequire } from "${spec}";\n` },
    });
    assert.equal(policyErrors.length, 1, spec);
  }
});

test("REJECTS a forbidden bare import into a package holding a private key", async () => {
  for (const spec of ["@armyofagents/db", "@armyofagents/server", "drizzle-orm", "pg", "express"]) {
    const { policyErrors } = await checkTree({
      files: { ...clean, "outcome.ts": `import x from "${spec}";\n` },
    });
    assert.equal(policyErrors.length, 1, spec);
  }
});

test("REJECTS a relative import that escapes the package src", async () => {
  const { policyErrors } = await checkTree({
    files: { ...clean, "outcome.ts": 'import x from "../../worker-daemon/src/secret.js";\n' },
  });
  assert.equal(policyErrors.length, 1);
  assert.match(policyErrors[0], /escapes package src/);
});

test("REJECTS a runtime import of test source", async () => {
  const { policyErrors } = await checkTree({
    files: { ...clean, "outcome.ts": 'import x from "./helper.test.js";\n' },
  });
  assert.equal(policyErrors.length, 1);
});

test("REJECTS a wrong package name", async () => {
  const { policyErrors } = await checkTree({ files: clean, pkg: manifest({ name: "@armyofagents/not-this" }) });
  assert.equal(policyErrors.length, 1);
});

test("the REAL package on disk passes clean", async () => {
  const { policyErrors, readErrors } = await runBoundaryCheck(REPO_ROOT, {
    packages: WORKER_KEYSTORE_BOUNDARY_PACKAGES,
  });
  assert.deepEqual(readErrors, []);
  assert.deepEqual(policyErrors, []);
});
