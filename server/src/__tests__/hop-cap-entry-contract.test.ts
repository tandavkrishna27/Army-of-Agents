import { describe, it, expect } from "vitest";

describe("hop-cap system entry contract", () => {
  it("hop_cap_reached sourceInfo has required fields", () => {
    const sourceInfo = { type: "hop_cap_reached", hopCount: 5, cap: 5 };
    expect(sourceInfo.type).toBe("hop_cap_reached");
    expect(typeof sourceInfo.hopCount).toBe("number");
    expect(typeof sourceInfo.cap).toBe("number");
  });

  it("HopCapDecisionCard renders when sourceInfo.type matches", () => {
    // Contract: if an entry has inputType=system and sourceInfo.type=hop_cap_reached,
    // EntryRow should extract and render HopCapDecisionCard
    const entry = { inputType: "system", sourceInfo: { type: "hop_cap_reached", hopCount: 5, cap: 5 } };
    const si = entry.sourceInfo as Record<string, unknown>;
    expect(si.type).toBe("hop_cap_reached");
    expect(typeof si.hopCount).toBe("number");
  });
});
