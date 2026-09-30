// -----------------------------------------------------------------------------
// Plan §3 focused-command alias for the DEP-002 static corpus.
//
//   node --test scripts/lib/__tests__/d1-compose-invariants.test.mjs
//
// The authoritative corpus lives in scripts/check-d1-compose.test.mjs (the
// operator-named entry). Importing it registers every case on the shared node:test
// runner so this plan-named path runs the identical suite. A local smoke assertion
// keeps this file meaningful if run in isolation.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateComposeInvariants } from "../d1-compose-invariants.mjs";

import "../../check-d1-compose.test.mjs";

test("evaluateComposeInvariants flags an empty compose", () => {
  const { violations } = evaluateComposeInvariants({});
  assert.ok(violations.length > 0);
});
