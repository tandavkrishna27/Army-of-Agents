import { describe, it, expect } from "vitest";
import {
  OPERATION_DESCRIPTORS,
  WORKER_PROTOCOL_OPERATIONS,
  isRetryableProtocolErrorCode,
} from "@armyofagents/worker-protocol";
import { sizeRefusalCode } from "../services/worker-protocol-http.js";
import {
  WORKER_CONTROL_EVENTS_BODY_LIMIT_BYTES,
  WORKER_CONTROL_BODY_LIMIT_BYTES,
  WORKER_CONTROL_BODY_HEADROOM_BYTES,
  WORKER_CONTROL_EVENTS_PATH,
  WORKER_CONTROL_PATH_PREFIX,
} from "../worker-control-body-limits.js";
import { SESSION_RENEW_DESCRIPTOR } from "../services/worker-session-renewal.js";

// BRW-003d-1 — the parser cliff.
//
// These run in the PLAIN unit tier on purpose. The only harness that boots the
// real app is `describe.skipIf(win32 && !AOA_RUN_WIN_INTEGRATION)`, so a
// Windows developer would see the bounding clause "pass" by skipping. The
// derivation invariant is pure, so it can and must run everywhere.
describe("BRW-003d-1 worker-control body limits are DERIVED from the frozen contract", () => {
  it("mounts a limit STRICTLY GREATER than every operation's declared maxRequestBytes", () => {
    // The crux, measured rather than argued: if the mount EQUALS the contract
    // limit, express rejects at the same threshold the handler would, so the
    // handler's guard stays dead and the refusal keeps the wrong (non-protocol)
    // shape. Only a mount strictly above the contract lets the protocol-shaped
    // refusal win the race.
    for (const op of WORKER_PROTOCOL_OPERATIONS) {
      const declared = OPERATION_DESCRIPTORS[op].maxRequestBytes;
      const mounted = op === "event_upload"
        ? WORKER_CONTROL_EVENTS_BODY_LIMIT_BYTES
        : WORKER_CONTROL_BODY_LIMIT_BYTES;
      expect(
        mounted,
        `${op} declares ${declared} bytes but its path mounts ${mounted}`,
      ).toBeGreaterThan(declared);
    }
  });

  it("★ WRK-010: the LOCAL session-renew descriptor mounts STRICTLY BELOW the prefix limit", () => {
    // The session-renew route lives under the shared /api/worker-control prefix, so its
    // effective express body limit is WORKER_CONTROL_BODY_LIMIT_BYTES. Its descriptor is
    // LOCAL (not a frozen operation), so the loop above — which iterates
    // WORKER_PROTOCOL_OPERATIONS — cannot see it. If the descriptor's ceiling ever reaches
    // or exceeds the mount, express refuses first, the handler's own size guard stays dead,
    // and the refusal keeps the wrong (non-protocol) shape. Kills mutant M8.
    expect(SESSION_RENEW_DESCRIPTOR.maxRequestBytes).toBeLessThan(WORKER_CONTROL_BODY_LIMIT_BYTES);
  });

  it("derives each limit from the descriptors rather than hand-typing a number", () => {
    const others = WORKER_PROTOCOL_OPERATIONS
      .filter((op) => op !== "event_upload")
      .map((op) => OPERATION_DESCRIPTORS[op].maxRequestBytes);
    expect(WORKER_CONTROL_BODY_LIMIT_BYTES).toBe(
      Math.max(...others) + WORKER_CONTROL_BODY_HEADROOM_BYTES,
    );
    expect(WORKER_CONTROL_EVENTS_BODY_LIMIT_BYTES).toBe(
      OPERATION_DESCRIPTORS.event_upload.maxRequestBytes + WORKER_CONTROL_BODY_HEADROOM_BYTES,
    );
  });

  it("keeps the wide limit off every path except the one operation that needs it", () => {
    // event_upload is 4 MiB; the next largest operation is 256 KiB. Mounting the
    // 4 MiB limit prefix-wide would give a 64 KiB operation a 4 MiB pre-auth
    // parse buffer for no contractual reason.
    expect(WORKER_CONTROL_EVENTS_BODY_LIMIT_BYTES).toBeGreaterThan(
      WORKER_CONTROL_BODY_LIMIT_BYTES,
    );
    expect(WORKER_CONTROL_EVENTS_PATH.startsWith(WORKER_CONTROL_PATH_PREFIX)).toBe(true);
    // The more specific mount must be registered first to win; asserting the
    // prefix relationship is what makes that ordering requirement checkable.
    expect(WORKER_CONTROL_EVENTS_PATH).not.toBe(WORKER_CONTROL_PATH_PREFIX);
  });

  it("★ never refuses with a code outside the operation's own frozen vocabulary", () => {
    // Raising a mount REVIVES ceiling guards that the 100 KB default had kept
    // dead by construction. A revived guard must speak a word its operation
    // declares: `workerOperationProtocolErrorV1` throws on anything else, the
    // route's catch swallows the throw, and the fallthrough answers
    // `internal_unavailable` — a RETRYABLE code — for a body that can never
    // succeed. Four of the six emit sites hard-coded `payload_too_large`; only
    // four of the ten operations declare it.
    for (const op of WORKER_PROTOCOL_OPERATIONS) {
      const code = sizeRefusalCode(op);
      expect(
        OPERATION_DESCRIPTORS[op].errors as readonly string[],
        `${op} cannot express "${code}"`,
      ).toContain(code);
    }
  });

  it("keeps the size refusal NON-RETRYABLE for operations that cannot say payload_too_large", () => {
    // The failure mode is not just a wrong word, it is an infinite retry loop:
    // every operation here carries an idempotent_retry rule.
    for (const op of WORKER_PROTOCOL_OPERATIONS) {
      if (OPERATION_DESCRIPTORS[op].errors.includes("payload_too_large")) continue;
      expect(sizeRefusalCode(op)).toBe("malformed");
      expect(isRetryableProtocolErrorCode(sizeRefusalCode(op))).toBe(false);
    }
  });

  it("pins the express default it exists to escape", () => {
    // 100 KB is what express applies when no limit is passed. Every operation
    // above this number had a provably dead ceiling guard before this ticket.
    const EXPRESS_DEFAULT_BYTES = 100 * 1024;
    const above = WORKER_PROTOCOL_OPERATIONS.filter(
      (op) => OPERATION_DESCRIPTORS[op].maxRequestBytes > EXPRESS_DEFAULT_BYTES,
    );
    // enrollment, event_upload, artifact_commit, quarantine_finalize, control_command
    expect(above.length).toBeGreaterThanOrEqual(5);
    expect(above).toContain("event_upload");
  });
});
