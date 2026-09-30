import { describe, expect, it } from "vitest";
import type { UniverseDraftPayload } from "@armyofagents/shared";
import {
  acknowledgeStructuredAttempt,
  createStructuredAttempt,
  markStructuredAttemptUnknown,
} from "./structured-draft-state";

const question = (text: string): UniverseDraftPayload => ({
  kind: "question",
  expectedVersion: 3,
  text,
  selectedValues: [],
});

describe("structured draft recovery state", () => {
  it("allocates source idempotency only for question and runtime attempts", () => {
    expect(createStructuredAttempt({
      kind: "question",
      draftRevision: 4,
      payloadHash: "hash-1",
      attemptId: "attempt-1",
      idempotencyKey: "answer-1",
    })).toMatchObject({ attemptId: "attempt-1", idempotencyKey: "answer-1", state: "pending" });

    expect(() => createStructuredAttempt({
      kind: "approval",
      draftRevision: 4,
      payloadHash: "hash-1",
      attemptId: "attempt-1",
      idempotencyKey: "invented-key",
    })).toThrow(/approval/i);

    expect(createStructuredAttempt({
      kind: "approval",
      draftRevision: 4,
      payloadHash: "hash-1",
      attemptId: "attempt-1",
    })).not.toHaveProperty("idempotencyKey");
  });

  it("keeps the frozen identity and payload hash when an outcome becomes unknown", () => {
    const pending = createStructuredAttempt({
      kind: "runtime_decision",
      draftRevision: 7,
      payloadHash: "hash-runtime",
      attemptId: "attempt-runtime",
      idempotencyKey: "runtime-answer-1",
    });
    expect(markStructuredAttemptUnknown(pending)).toEqual({ ...pending, state: "unknown" });
  });

  it("clears only the acknowledged question snapshot", () => {
    const sentPayload = question("first");
    const attempt = createStructuredAttempt({
      kind: "question",
      draftRevision: 4,
      payloadHash: "hash-first",
      attemptId: "attempt-1",
      idempotencyKey: "answer-1",
    });
    const result = acknowledgeStructuredAttempt(
      { revision: 4, payload: sentPayload, pendingAttempt: attempt },
      { payload: sentPayload, attempt },
    );
    expect(result).toEqual({
      revision: 4,
      payload: { ...sentPayload, text: "", selectedValues: [] },
      pendingAttempt: null,
    });
  });

  it("preserves edits made while the acknowledged answer was in flight", () => {
    const sentPayload = question("first");
    const attempt = createStructuredAttempt({
      kind: "question",
      draftRevision: 4,
      payloadHash: "hash-first",
      attemptId: "attempt-1",
      idempotencyKey: "answer-1",
    });
    const currentPayload = question("second");
    const result = acknowledgeStructuredAttempt(
      { revision: 5, payload: currentPayload, pendingAttempt: attempt },
      { payload: sentPayload, attempt },
    );
    expect(result).toEqual({ revision: 5, payload: currentPayload, pendingAttempt: null });
  });

  it("clears approval selection without inventing a retry guarantee", () => {
    const payload: UniverseDraftPayload = {
      kind: "approval",
      observedUpdatedAt: "2026-09-20T10:00:00.000Z",
      decision: "approve",
      decisionNote: "Looks good",
    };
    const attempt = createStructuredAttempt({
      kind: "approval",
      draftRevision: 2,
      payloadHash: "hash-approval",
      attemptId: "attempt-approval",
    });
    expect(acknowledgeStructuredAttempt(
      { revision: 2, payload, pendingAttempt: attempt },
      { payload, attempt },
    ).payload).toEqual({ ...payload, decision: null, decisionNote: "" });
  });
});
