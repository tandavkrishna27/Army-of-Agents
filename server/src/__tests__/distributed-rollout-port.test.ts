// Unit 1.5 — the module-level rollout port.
//
// Companion to `cli-006-rollout-port-wiring.test.ts`, which proves the port is READ by a
// bare `heartbeatService(db)` and REGISTERED by the composition root. This file covers the
// port module itself, with nothing mocked.

import { beforeEach, describe, expect, it } from "vitest";
import {
  getDistributedRolloutPort,
  setDistributedRolloutPort,
} from "../services/distributed-rollout-port.js";
import type { HeartbeatDistributedRolloutHook } from "../services/heartbeat-distributed-rollout.js";

// Only the shape matters here; the hook's own behaviour is covered by
// heartbeat-distributed-rollout.test.ts.
const hook = { marker: "hook-a" } as unknown as HeartbeatDistributedRolloutHook;
const other = { marker: "hook-b" } as unknown as HeartbeatDistributedRolloutHook;

beforeEach(() => {
  setDistributedRolloutPort(undefined);
});

describe("Unit 1.5 — the module-level rollout port", () => {
  it("is absent until registered", () => {
    // The flag-off default. `index.ts` registers only inside the distributed block, so a
    // deployment that never composed distributed execution reads `undefined` here and every
    // heartbeat instance behaves exactly as it did before this port existed.
    expect(getDistributedRolloutPort()).toBeUndefined();
  });

  it("is readable from a caller holding no service instance at all", () => {
    // The whole point. The instances that execute task runs are built as bare
    // `heartbeatService(db)` in routes/issues.ts and issue-assignee-wakeup.ts, so the hook
    // must not travel through a constructor option.
    setDistributedRolloutPort(hook);
    expect(getDistributedRolloutPort()).toBe(hook);
  });

  it("can be cleared, so a test or a reload cannot leak one deployment's hook", () => {
    setDistributedRolloutPort(hook);
    setDistributedRolloutPort(undefined);
    expect(getDistributedRolloutPort()).toBeUndefined();
  });

  it("replaces rather than accumulates", () => {
    // A second registration must win outright. Two live hooks would mean two rollout
    // decisions for one deployment — the ambiguity the single-comparator rule in
    // distributed-shadow-port-registration.test.ts exists to prevent.
    setDistributedRolloutPort(hook);
    setDistributedRolloutPort(other);
    expect(getDistributedRolloutPort()).toBe(other);
  });
});
