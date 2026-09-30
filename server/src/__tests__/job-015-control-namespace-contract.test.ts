/**
 * JOB-015 — the server's projection and the daemon's reader must agree on the
 * extension namespace and the ACK detail, and they CANNOT import each other: the
 * daemon's E4-D01 boundary permits `@armyofagents/worker-protocol` + relative modules
 * only, and the server is not on that list. Two independently declared string
 * constants that must match is exactly the shape that drifts silently — a renamed
 * namespace on one side turns every delivery into "no commands pending" on the other,
 * with no error anywhere.
 *
 * This is the same guard `cli-008-staged-input-contract.test.ts` puts on the staged-input
 * pointer namespace, for the same reason.
 */

import { describe, expect, it } from "vitest";

import {
  CONTROL_EXTENSION_NAMESPACE as DAEMON_NAMESPACE,
  OVERSIZED_FOR_RENEW_CHANNEL as DAEMON_OVERSIZED_DETAIL,
} from "@armyofagents/worker-daemon";
import {
  CONTROL_EXTENSION_NAMESPACE as SERVER_NAMESPACE,
  OVERSIZED_FOR_RENEW_CHANNEL as SERVER_OVERSIZED_DETAIL,
} from "../services/control-command-projection.js";

describe("JOB-015 — the control-extension contract across the E4-D01 boundary", () => {
  it("publisher and reader name the SAME namespace", () => {
    expect(DAEMON_NAMESPACE).toBe(SERVER_NAMESPACE);
    expect(SERVER_NAMESPACE).toBe("dev.aoa.job/control-v1");
  });

  it("the oversized-leading ACK detail is the same string on both sides", () => {
    // The server's projection documents the terminal; the worker sends it. A drift here
    // would make the unblock invisible in the durable `ack_detail` record.
    expect(DAEMON_OVERSIZED_DETAIL).toBe(SERVER_OVERSIZED_DETAIL);
    expect(SERVER_OVERSIZED_DETAIL).toBe("oversized_for_renew_channel");
  });
});
