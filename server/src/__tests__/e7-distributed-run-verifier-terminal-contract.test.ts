// Drift guard for evidence-verifier A clause 3.
//
// A's pure service copies TERMINAL_RUN_STATUSES locally (it cannot import heartbeat.ts
// without dragging drizzle into its pure store-fixture tests — the whole point of the
// {store} split). This contract test — which IS allowed to load heartbeat.ts, exactly
// as heartbeat-terminal-latch.test.ts does — pins the copy to its source of truth so a
// drift reddens CI rather than silently over- or under-refusing at clause 3.

import { describe, expect, it } from "vitest";
import { E7_TERMINAL_RUN_STATUSES } from "../services/e7-distributed-run-verifier.js";
import { TERMINAL_RUN_STATUSES } from "../services/heartbeat.js";

describe("evidence-verifier A — clause 3 terminal-status contract", () => {
  it("A's local terminal set is exactly heartbeat.ts TERMINAL_RUN_STATUSES", () => {
    expect([...E7_TERMINAL_RUN_STATUSES].sort()).toEqual([...TERMINAL_RUN_STATUSES].sort());
  });
});
