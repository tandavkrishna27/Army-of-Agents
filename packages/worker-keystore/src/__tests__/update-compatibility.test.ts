/**
 * DSK-004 Lane B / I4 — an incompatible build is refused BEFORE the swap.
 *
 * Two properties, and the second is the one with teeth:
 *
 *   COMPATIBILITY IS NEGOTIATION, NOT COMPARISON. It is whether the candidate's protocol
 *   range still intersects what the control plane requires — `negotiateProtocolVersion`,
 *   the same function the lease matcher uses. A build-number comparison would be a second,
 *   weaker notion of compatibility beside the one the protocol defines, and they would drift.
 *
 *   A MANIFEST'S CLAIM IS NOT EVIDENCE. An update manifest may carry the compatibility its
 *   publisher believed at signing time. It is ignored. What matters is the intersection
 *   with the server this device is actually talking to, evaluated NOW.
 */

import { describe, expect, it } from "vitest";

import { evaluateUpdateCompatibility } from "../update-compatibility.js";

const server = { min: 1, max: 2 };

describe("DSK-004/I4 — compatibility is the intersection", () => {
  it("admits a candidate whose range overlaps", () => {
    expect(evaluateUpdateCompatibility({ candidateProtocol: { min: 1, max: 2 }, serverProtocol: server }))
      .toEqual({ compatible: true, negotiated: 2 });
  });

  it("admits the N-1 case — an older candidate the server still speaks", () => {
    // {1,1} against {1,2} negotiates 1. Refusing this would make every rollback
    // impossible, which is the opposite of what DSK-004 exists to enable.
    expect(evaluateUpdateCompatibility({ candidateProtocol: { min: 1, max: 1 }, serverProtocol: server }))
      .toEqual({ compatible: true, negotiated: 1 });
  });

  it("admits a NEWER candidate the server can still meet", () => {
    expect(evaluateUpdateCompatibility({ candidateProtocol: { min: 2, max: 3 }, serverProtocol: server }))
      .toEqual({ compatible: true, negotiated: 2 });
  });

  it("refuses a candidate that is too NEW for the server", () => {
    expect(evaluateUpdateCompatibility({ candidateProtocol: { min: 3, max: 4 }, serverProtocol: server }))
      .toEqual({ compatible: false, reason: "no_protocol_overlap" });
  });

  it("negotiates the HIGHEST common version, not the lowest", () => {
    // Reported so a caller can record what the new build will actually speak; the floor
    // would understate it.
    const result = evaluateUpdateCompatibility({
      candidateProtocol: { min: 1, max: 5 }, serverProtocol: { min: 1, max: 3 },
    });
    expect(result.compatible && result.negotiated).toBe(3);
  });
});

describe("DSK-004/I4 — a manifest's claim is not evidence", () => {
  it("IGNORES a manifest that declares itself compatible", () => {
    // The publisher's belief at signing time is not a fact about this device's server.
    expect(evaluateUpdateCompatibility({
      candidateProtocol: { min: 9, max: 9 }, serverProtocol: server, declaredCompatible: true,
    })).toEqual({ compatible: false, reason: "no_protocol_overlap" });
  });

  it("IGNORES a manifest that declares itself incompatible", () => {
    // Symmetrically: a stale claim must not veto a build that genuinely negotiates, or
    // devices strand on an old version forever.
    expect(evaluateUpdateCompatibility({
      candidateProtocol: { min: 1, max: 2 }, serverProtocol: server, declaredCompatible: false,
    }).compatible).toBe(true);
  });
});

describe("DSK-004/I4 — malformed input is refused, never guessed", () => {
  it("refuses a missing range on either side", () => {
    for (const input of [
      { serverProtocol: server },
      { candidateProtocol: { min: 1, max: 1 } },
      {},
      undefined,
    ]) {
      const r = evaluateUpdateCompatibility(input as never);
      expect(r, JSON.stringify(input)).toEqual({ compatible: false, reason: "malformed_range" });
    }
  });

  it("refuses an INVERTED range rather than negotiating nonsense", () => {
    // `negotiateProtocolVersion` documents that callers must have validated min <= max.
    // An update manifest read from disk has passed through no schema, so this module
    // validates: handing the negotiator {min:5,max:1} returns a number for an impossible
    // peer.
    expect(evaluateUpdateCompatibility({
      candidateProtocol: { min: 5, max: 1 }, serverProtocol: server,
    })).toEqual({ compatible: false, reason: "malformed_range" });
  });

  it("refuses non-integer and non-positive versions", () => {
    for (const bad of [{ min: 1.5, max: 2 }, { min: 0, max: 2 }, { min: "1", max: 2 }]) {
      expect(
        evaluateUpdateCompatibility({ candidateProtocol: bad, serverProtocol: server } as never),
        JSON.stringify(bad),
      ).toEqual({ compatible: false, reason: "malformed_range" });
    }
  });

  it("never throws for caller-supplied garbage", () => {
    for (const bad of [null, 0, "", [], { candidateProtocol: 7, serverProtocol: server }]) {
      expect(evaluateUpdateCompatibility(bad as never).compatible, JSON.stringify(bad)).toBe(false);
    }
  });
});
