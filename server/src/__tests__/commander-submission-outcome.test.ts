import { describe, expect, it } from "vitest";
import { classifyCommanderSubmissionOutcome } from "../services/internal-agent/submission-outcome.js";

describe("classifyCommanderSubmissionOutcome", () => {
  it("reports not_found without a canonical user message", () => {
    expect(classifyCommanderSubmissionOutcome(null, null)).toEqual({ state: "not_found" });
  });

  it("reports accepted without re-executing an in-flight turn", () => {
    expect(classifyCommanderSubmissionOutcome({ id: "u1", turnStatus: "running", submissionPayloadHash: "hash" }, null)).toEqual({
      state: "accepted", userMessageId: "u1",
    });
  });

  it("reports the explicitly linked completed reply", () => {
    expect(classifyCommanderSubmissionOutcome(
      { id: "u1", turnStatus: "done", submissionPayloadHash: "hash" },
      { id: "a1" },
    )).toEqual({ state: "completed", userMessageId: "u1", assistantMessageId: "a1" });
  });

  it("reports a terminal failed claim", () => {
    expect(classifyCommanderSubmissionOutcome({ id: "u1", turnStatus: "failed", submissionPayloadHash: "hash" }, null)).toEqual({
      state: "failed", userMessageId: "u1",
    });
  });

  it("does not claim a legacy row has the same frozen identity", () => {
    expect(classifyCommanderSubmissionOutcome({id: "u1", turnStatus: "done", submissionPayloadHash: null}, null)).toEqual({state: "unknown", userMessageId: "u1", reason: "legacy_identity"});
  });
});
