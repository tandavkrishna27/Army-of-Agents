/**
 * Minimal "worker" consumer of the packed @armyofagents/worker-protocol
 * tarball. Run by scripts/check-worker-protocol-package.mjs from inside a
 * temp directory that has the exact tarball extracted into
 * node_modules/@armyofagents/worker-protocol (no network, no package manager).
 *
 * A future worker package must be able to depend on this leaf package the same
 * way the control plane does: import only the public root export, never reach
 * into `src` or private dist internals.
 */
import assert from "node:assert/strict";

import * as protocol from "@armyofagents/worker-protocol";

// Version constants: the stable wire-contract floor/ceiling.
assert.equal(protocol.PROTOCOL_VERSION, 1, "PROTOCOL_VERSION must be 1");
assert.equal(protocol.MIN_PROTOCOL_VERSION, 1, "MIN_PROTOCOL_VERSION must be 1");

// The public surface is large (~275 exports today) and GROWS as the protocol
// expands, so pinning the exact list is brittle. Instead assert that a stable,
// load-bearing SAMPLE of the public wire surface is present — enough to prove a
// real root import resolved, without hard-coding the full surface.
const sampleExports = [
  "jobEnvelopeV1Schema",
  "workerEventV1Schema",
  "leaseOfferV1Schema",
  "executionSourceV1Schema",
  "registeredTargetProfileV1Schema",
  "controlCommandV1Schema",
  "canonicalizeJsonV1",
];
for (const name of sampleExports) {
  assert.notEqual(protocol[name], undefined, `expected public export missing: ${name}`);
}

// Genuinely EXERCISE a zod-backed schema so this smoke proves the package's
// declared `zod` runtime dependency was actually provisioned into the consumer
// (not merely that the module namespace loaded). An empty object must fail the
// strict job envelope, which runs real zod validation.
assert.equal(
  typeof protocol.jobEnvelopeV1Schema.safeParse,
  "function",
  "jobEnvelopeV1Schema must be a zod schema exposing safeParse",
);
const parsed = protocol.jobEnvelopeV1Schema.safeParse({});
assert.equal(
  parsed.success,
  false,
  "empty object must fail jobEnvelopeV1Schema (exercises zod validation)",
);

async function importFails(specifier) {
  try {
    await import(specifier);
    return false;
  } catch {
    return true;
  }
}

assert.equal(
  await importFails("@armyofagents/worker-protocol/src/version.js"),
  true,
  "src subpath must not be importable",
);
assert.equal(
  await importFails("@armyofagents/worker-protocol/dist/index.js"),
  true,
  "deep dist subpath must not be importable",
);

console.log("worker-consumer OK");
