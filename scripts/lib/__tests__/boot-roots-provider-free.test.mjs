// WRK-008 slice 2b Step 9b — self-test for the boot-roots-provider-free evaluator.
//
//   node --test scripts/lib/__tests__/boot-roots-provider-free.test.mjs
//
// NON-VACUOUS: the valid fixture passes (0 violations); each defect flips one fact. The
// load-bearing directions are (a) a quietly-added UNDECLARED root, and (c) a resolver that
// DEFAULTS to a provider — the two a matcher written against the pre-DEP-010 wording would miss.

import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateBootRoots } from "../boot-roots-provider-free.mjs";

const EXPECTATION = {
  roots: {
    "a/bin/worker-daemon.ts": { providerPosture: "none" },
    "a/bin/desktop-host.ts": { providerPosture: "resolver", resolverFile: "a/bin/sandbox-provider.ts", resolverNoneMarker: 'return { kind: "none" };' },
  },
};
const RESOLVER_OK = { "a/bin/sandbox-provider.ts": 'if (unset) return { kind: "none" };' };
const FOUND = ["a/bin/desktop-host.ts", "a/bin/worker-daemon.ts"];

test("the valid fixture has ZERO violations (non-vacuity anchor)", () => {
  assert.deepEqual(evaluateBootRoots({ foundRoots: FOUND, expectation: EXPECTATION, resolverContents: RESOLVER_OK }), []);
});

test("an UNDECLARED boot root fires a violation (a quietly-added third root)", () => {
  const v = evaluateBootRoots({ foundRoots: [...FOUND, "a/bin/rogue-host.ts"], expectation: EXPECTATION, resolverContents: RESOLVER_OK });
  assert.ok(v.some((m) => /undeclared boot root: a\/bin\/rogue-host\.ts/.test(m)));
});

test("a STALE declaration (declared root no longer found) fires a violation", () => {
  const v = evaluateBootRoots({ foundRoots: ["a/bin/desktop-host.ts"], expectation: EXPECTATION, resolverContents: RESOLVER_OK });
  assert.ok(v.some((m) => /worker-daemon\.ts no longer obtains/.test(m)));
});

test("★ a resolver that DEFAULTS to a provider (none-marker missing) fires a violation", () => {
  const bad = { "a/bin/sandbox-provider.ts": 'return new E2bSandboxProvider();' };
  const v = evaluateBootRoots({ foundRoots: FOUND, expectation: EXPECTATION, resolverContents: bad });
  assert.ok(v.some((m) => /does not default to no provider/.test(m)));
});

test("an unreadable resolver source is a fail-closed violation, never a pass", () => {
  const v = evaluateBootRoots({ foundRoots: FOUND, expectation: EXPECTATION, resolverContents: { "a/bin/sandbox-provider.ts": undefined } });
  assert.ok(v.some((m) => /could not be read \(fail closed\)/.test(m)));
});
