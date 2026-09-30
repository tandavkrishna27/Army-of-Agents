import { describe, it, expect } from "vitest";
import { triggerMatchesEvent } from "../services/internal-agent/aoa-agents/triggers.js";

describe("triggerMatchesEvent", () => {
  it("mention trigger fires on an @agent mention event", () => {
    expect(triggerMatchesEvent({ kind: "mention" }, { type: "thread.mention", targetType: "agent" })).toBe(true);
  });
  it("mention trigger does NOT fire on an @human mention", () => {
    expect(triggerMatchesEvent({ kind: "mention" }, { type: "thread.mention", targetType: "user" })).toBe(false);
  });
  it("phase-advance trigger fires on phase change", () => {
    expect(triggerMatchesEvent({ kind: "phase-advance" }, { type: "thread.phase.changed" })).toBe(true);
  });
  it("routine trigger fires on a scheduled tick", () => {
    expect(triggerMatchesEvent({ kind: "routine" }, { type: "routine.tick" })).toBe(true);
  });
  it("outbox trigger is unaffected by thread events", () => {
    expect(triggerMatchesEvent({ kind: "outbox" }, { type: "thread.mention", targetType: "agent" })).toBe(false);
  });
});
