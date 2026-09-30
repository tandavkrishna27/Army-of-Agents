import { describe, expect, it } from "vitest";

import { classifyEventUploadResponse } from "../events/event-upload.js";
import type { WorkerOperationHttpResponse } from "../transport/client.js";

import { eventIdentity } from "./support/event-fixtures.js";

const ID = eventIdentity();

function ackResponse(
  status: string,
  fields: { acceptedThroughSeq: number; rejectedEventId?: string },
): WorkerOperationHttpResponse {
  return {
    status: 200,
    body: {
      protocolVersion: 1,
      correlationId: "00000000-0000-4000-8000-0000000000c0",
      serverTime: "2026-08-14T00:00:00.000Z",
      ack: {
        protocolVersion: 1,
        organizationId: ID.organizationId,
        companyId: ID.companyId,
        workerId: ID.workerId,
        jobId: ID.jobId,
        attempt: ID.attempt,
        leaseId: ID.leaseId,
        fenceToken: ID.fenceToken,
        acceptedThroughSeq: fields.acceptedThroughSeq,
        expectedNextSeq: fields.acceptedThroughSeq + 1,
        status,
        ...(fields.rejectedEventId ? { rejectedEventId: fields.rejectedEventId } : {}),
      },
    },
  };
}

function errorResponse(status: number, code: string, retryAfterMs: number | null = null): WorkerOperationHttpResponse {
  return {
    status,
    body: {
      protocolVersion: 1,
      code,
      correlationId: "00000000-0000-4000-8000-0000000000c1",
      message: "denied",
      retryAfterMs,
      serverTime: "2026-08-14T00:00:00.000Z",
      redaction: "secret",
      detail: {},
    },
  };
}

describe("classifyEventUploadResponse — closed mapping (mirrors classifyRenewResponse)", () => {
  it("accepted → advance-cursor outcome with acceptedThroughSeq/expectedNextSeq", () => {
    expect(classifyEventUploadResponse(ackResponse("accepted", { acceptedThroughSeq: 5 }))).toEqual({
      kind: "accepted",
      acceptedThroughSeq: 5,
      expectedNextSeq: 6,
    });
  });

  it("gap → resend-from-expectedNextSeq", () => {
    expect(classifyEventUploadResponse(ackResponse("gap", { acceptedThroughSeq: 3 }))).toEqual({
      kind: "gap",
      acceptedThroughSeq: 3,
      expectedNextSeq: 4,
    });
  });

  it("hash_mismatch → quarantine the rejectedEventId", () => {
    const evtId = "00000000-0000-4000-8000-0000000000ee";
    expect(
      classifyEventUploadResponse(ackResponse("hash_mismatch", { acceptedThroughSeq: 2, rejectedEventId: evtId })),
    ).toEqual({ kind: "hash_mismatch", rejectedEventId: evtId, acceptedThroughSeq: 2 });
  });

  it("stale_fence / target_revoked / terminal ack → stream_lost (stop the stream)", () => {
    for (const reason of ["stale_fence", "target_revoked", "terminal"] as const) {
      expect(classifyEventUploadResponse(ackResponse(reason, { acceptedThroughSeq: 1 }))).toEqual({
        kind: "stream_lost",
        reason,
      });
    }
  });

  it("a 200 that fails to parse → terminal malformed", () => {
    expect(classifyEventUploadResponse({ status: 200, body: { not: "an ack" } })).toEqual({
      kind: "terminal",
      code: "malformed",
    });
  });

  it("401 → unauthorized (drives session recovery)", () => {
    expect(classifyEventUploadResponse(errorResponse(401, "unauthorized"))).toEqual({ kind: "unauthorized" });
  });

  it("429/throttled + 503/internal_unavailable → transient (honor retryAfterMs)", () => {
    expect(classifyEventUploadResponse(errorResponse(429, "throttled", 2000))).toEqual({
      kind: "transient",
      label: "throttled",
      retryAfterMs: 2000,
    });
    expect(classifyEventUploadResponse(errorResponse(503, "internal_unavailable", null))).toEqual({
      kind: "transient",
      label: "internal_unavailable",
      retryAfterMs: null,
    });
  });

  it("a non-200 target_revoked code → stream_lost", () => {
    expect(classifyEventUploadResponse(errorResponse(409, "target_revoked"))).toEqual({
      kind: "stream_lost",
      reason: "target_revoked",
    });
  });

  it("any other non-200 → terminal with the code", () => {
    expect(classifyEventUploadResponse(errorResponse(400, "malformed"))).toEqual({
      kind: "terminal",
      code: "malformed",
    });
  });
});
