// WRK-008 slice 2b Step 9a — self-test for the D1-dispatch declaration evaluator.
//
//   node --test scripts/lib/__tests__/d1-dispatch-declared.test.mjs
//
// NON-VACUOUS: the valid fixture passes (0 violations) and each defect fixture flips exactly one
// fact and asserts the corresponding violation fires — including a defect on a NON-flag gate, so
// a checker that inspected only AOA_WORKER_DISPATCH_ENABLED would fail here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateD1Dispatch } from "../d1-dispatch-declared.mjs";

const EXPECTATION = {
  workers: {
    "worker-a": {
      dispatchEnabled: { var: "AOA_WORKER_DISPATCH_ENABLED", expect: "absent" },
      keyStoreMode: { var: "AOA_WORKER_KEY_STORE_MODE", expect: "mounted_secret" },
      sandboxProvider: { var: "AOA_WORKER_SANDBOX_PROVIDER", expect: "absent" },
      providerUrl: { var: "AOA_WORKER_PROVIDER_URL", expect: "present" },
    },
  },
};

const VALID_ENV = {
  "worker-a": {
    AOA_WORKER_KEY_STORE_MODE: "mounted_secret",
    AOA_WORKER_PROVIDER_URL: "http://fake-provider:8080",
  },
};

test("the valid fixture has ZERO violations (non-vacuity anchor)", () => {
  assert.deepEqual(evaluateD1Dispatch(VALID_ENV, EXPECTATION), []);
});

test("declared-ABSENT but SET fires a violation (accidental enable)", () => {
  const env = { "worker-a": { ...VALID_ENV["worker-a"], AOA_WORKER_DISPATCH_ENABLED: "1" } };
  const v = evaluateD1Dispatch(env, EXPECTATION);
  assert.equal(v.length, 1);
  assert.match(v[0], /AOA_WORKER_DISPATCH_ENABLED.*declared ABSENT/);
});

test("declared-PRESENT but ABSENT fires a violation (a live variable becoming dead-and-gone)", () => {
  const env = { "worker-a": { AOA_WORKER_KEY_STORE_MODE: "mounted_secret" } };
  const v = evaluateD1Dispatch(env, EXPECTATION);
  assert.ok(v.some((m) => /AOA_WORKER_PROVIDER_URL.*declared PRESENT/.test(m)));
});

test("a NON-flag gate divergence is caught (keyStoreMode) — a flag-only checker would miss this", () => {
  const env = { "worker-a": { ...VALID_ENV["worker-a"], AOA_WORKER_KEY_STORE_MODE: "os_keychain" } };
  const v = evaluateD1Dispatch(env, EXPECTATION);
  assert.ok(v.some((m) => /AOA_WORKER_KEY_STORE_MODE/.test(m)));
});

test("a worker with NO parsed env is a fail-closed violation, never a silent pass", () => {
  const v = evaluateD1Dispatch({}, EXPECTATION);
  assert.ok(v.some((m) => /worker-a: no environment parsed/.test(m)));
});
