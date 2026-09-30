import { describe, expect, it } from "vitest";
import { isCheapRecoveryWake, withRecoveryModelProfileHint } from "../services/recovery/model-profile-hint.js";

describe("recovery model profile hints", () => {
  it("adds cheap profile markers to recovery payloads", () => {
    expect(withRecoveryModelProfileHint({ issueId: "i1" })).toMatchObject({
      issueId: "i1",
      modelProfileHint: "cheap",
      recoveryModelProfile: "cheap",
    });
  });

  it("detects either cheap recovery marker", () => {
    expect(isCheapRecoveryWake({ modelProfileHint: "cheap" })).toBe(true);
    expect(isCheapRecoveryWake({ recoveryModelProfile: "cheap" })).toBe(true);
    expect(isCheapRecoveryWake({})).toBe(false);
    expect(isCheapRecoveryWake(null)).toBe(false);
  });
});
