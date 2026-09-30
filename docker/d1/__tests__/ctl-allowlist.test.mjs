// -----------------------------------------------------------------------------
// DEP-002 FIX B — fake-provider control-endpoint allowlist FAIL-CLOSED proofs.
//
//   node --test docker/d1/__tests__/ctl-allowlist.test.mjs
//
// Pure unit tests for docker/d1/ctl-allowlist.mjs (the decision the control
// endpoint uses to admit or 403 a peer). Runs on any platform with zero Docker /
// heavy deps. `isCtlPeerAllowed(...) === false` is exactly the `return 403` path in
// fake-provider-entry.mjs, so these assertions map directly to the HTTP behavior:
// empty/unset => 403; '*' => allow; explicit list => allow listed, 403 others.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCtlAllow, isCtlPeerAllowed } from "../ctl-allowlist.mjs";

// docker-DNS resolution stub: worker-a -> 10.0.0.11, test-runner -> 10.0.0.13.
const RESOLVED = new Set(["10.0.0.11", "10.0.0.13"]);
const UNKNOWN_IP = "10.0.0.99";

test("parseCtlAllow trims, drops empties, and detects the '*' sentinel", () => {
  assert.deepEqual(parseCtlAllow("worker-a, worker-b , test-runner"), {
    open: false,
    peers: ["worker-a", "worker-b", "test-runner"],
  });
  assert.deepEqual(parseCtlAllow(""), { open: false, peers: [] });
  assert.deepEqual(parseCtlAllow(undefined), { open: false, peers: [] });
  assert.deepEqual(parseCtlAllow("   "), { open: false, peers: [] });
  assert.deepEqual(parseCtlAllow("*"), { open: true, peers: [] });
  // '*' anywhere opens it; the sentinel is stripped from the peer list.
  assert.deepEqual(parseCtlAllow("worker-a,*"), { open: true, peers: ["worker-a"] });
});

test("FAIL-CLOSED: an EMPTY allowlist denies every peer (=> 403)", () => {
  const spec = parseCtlAllow("");
  assert.equal(isCtlPeerAllowed(spec, RESOLVED, "10.0.0.11"), false);
  assert.equal(isCtlPeerAllowed(spec, RESOLVED, UNKNOWN_IP), false);
});

test("FAIL-CLOSED: an UNSET allowlist denies every peer (=> 403)", () => {
  const spec = parseCtlAllow(undefined);
  assert.equal(isCtlPeerAllowed(spec, new Set(), "10.0.0.11"), false);
});

test("the explicit '*' sentinel opens the endpoint to ALL peers", () => {
  const spec = parseCtlAllow("*");
  assert.equal(isCtlPeerAllowed(spec, new Set(), "10.0.0.11"), true);
  assert.equal(isCtlPeerAllowed(spec, new Set(), UNKNOWN_IP), true);
});

test("an explicit peer list admits resolved peers and 403s the rest", () => {
  const spec = parseCtlAllow("worker-a,worker-b,test-runner");
  assert.equal(isCtlPeerAllowed(spec, RESOLVED, "10.0.0.11"), true); // worker-a resolved
  assert.equal(isCtlPeerAllowed(spec, RESOLVED, "10.0.0.13"), true); // test-runner resolved
  assert.equal(isCtlPeerAllowed(spec, RESOLVED, UNKNOWN_IP), false); // e.g. control-plane => 403
});

test("a non-Set / missing allowedIps with an explicit list denies (=> 403)", () => {
  const spec = parseCtlAllow("worker-a");
  assert.equal(isCtlPeerAllowed(spec, undefined, "10.0.0.11"), false);
});
