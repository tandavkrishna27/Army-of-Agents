/**
 * Minimal "server" consumer of the packed @armyofagents/worker-protocol
 * tarball. Run by scripts/check-worker-protocol-package.mjs from inside a
 * temp directory that has the exact tarball extracted into
 * node_modules/@armyofagents/worker-protocol (no network, no package manager).
 *
 * It proves the public root export works AND that private/deep subpaths are
 * NOT reachable through the package `exports` map.
 */
import assert from "node:assert/strict";

import { MIN_PROTOCOL_VERSION, PROTOCOL_VERSION } from "@armyofagents/worker-protocol";

assert.equal(PROTOCOL_VERSION, 1, "PROTOCOL_VERSION must be 1");
assert.equal(MIN_PROTOCOL_VERSION, 1, "MIN_PROTOCOL_VERSION must be 1");

async function importFails(specifier) {
  try {
    await import(specifier);
    return false;
  } catch {
    return true;
  }
}

// The exports map declares only ".", so every private/deep subpath must be
// blocked (ERR_PACKAGE_PATH_NOT_EXPORTED). Source must never ship, and even the
// real dist internals must not be reachable except through the root entry.
assert.equal(
  await importFails("@armyofagents/worker-protocol/src/index.js"),
  true,
  "src subpath must not be importable",
);
assert.equal(
  await importFails("@armyofagents/worker-protocol/dist/version.js"),
  true,
  "deep dist subpath must not be importable",
);
assert.equal(
  await importFails("@armyofagents/worker-protocol/package.json"),
  true,
  "package.json subpath must not be importable (not declared in exports)",
);

console.log("server-consumer OK");
