import { describe, expect, it } from "vitest";
import type { UniverseDraftPayload } from "@armyofagents/shared";
import {
  buildApprovalSubmission,
  buildRuntimeDecisionSubmission,
  buildWorkQuestionSubmission,
} from "./structured-submit-adapters";

describe("Universe structured submission adapters", () => {
  it("builds a canonical work-question answer with the frozen key and version", () => {
    const payload: UniverseDraftPayload = {
      kind: "question",
      expectedVersion: 5,
      text: "  Use option A  ",
      selectedValues: ["a"],
    };
    expect(buildWorkQuestionSubmission(payload, "question-answer-1", ["a", "b"])).toEqual({
      answer: { text: "Use option A", selectedValues: ["a"] },
      expectedVersion: 5,
      idempotencyKey: "question-answer-1",
    });
  });

  it("rejects a work-question option that is no longer canonical", () => {
    const payload: UniverseDraftPayload = {
      kind: "question",
      expectedVersion: 5,
      text: "",
      selectedValues: ["removed"],
    };
    expect(() => buildWorkQuestionSubmission(payload, "question-answer-1", ["a"])).toThrow(/option/i);
  });

  it("uses the freshly read runtime nonce without persisting it in the draft", () => {
    const payload: UniverseDraftPayload = {
      kind: "runtime_decision",
      expectedSourceRevision: 8,
      answer: { kind: "permission", decision: "allow_once" },
    };
    expect(buildRuntimeDecisionSubmission(payload, {
      sourceRevision: 8,
      nonce: "fresh-nonce",
      idempotencyKey: "runtime-answer-1",
    })).toEqual({
      kind: "permission",
      decision: "allow_once",
      expectedSourceRevision: 8,
      nonce: "fresh-nonce",
      idempotencyKey: "runtime-answer-1",
    });
    expect(payload).not.toHaveProperty("nonce");
  });

  it("requires review when the runtime source revision changed", () => {
    const payload: UniverseDraftPayload = {
      kind: "runtime_decision",
      expectedSourceRevision: 8,
      answer: { kind: "permission", decision: "deny" },
    };
    expect(() => buildRuntimeDecisionSubmission(payload, {
      sourceRevision: 9,
      nonce: "rotated",
      idempotencyKey: "runtime-answer-1",
    })).toThrow(/changed/i);
  });

  it("maps approval selection to the existing route without idempotency or CAS fields", () => {
    const payload: UniverseDraftPayload = {
      kind: "approval",
      observedUpdatedAt: "2026-09-20T10:00:00.000Z",
      decision: "reject",
      decisionNote: "Needs evidence",
    };
    expect(buildApprovalSubmission(payload, "2026-09-20T10:00:00.000Z")).toEqual({
      action: "reject",
      decisionNote: "Needs evidence",
    });
  });

  it("requires review when an approval changed after the draft was observed", () => {
    const payload: UniverseDraftPayload = {
      kind: "approval",
      observedUpdatedAt: "2026-09-20T10:00:00.000Z",
      decision: "approve",
      decisionNote: "",
    };
    expect(() => buildApprovalSubmission(payload, "2026-09-20T10:01:00.000Z")).toThrow(/changed/i);
  });
});
