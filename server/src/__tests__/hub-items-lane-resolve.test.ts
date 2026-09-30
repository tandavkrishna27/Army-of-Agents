import { describe, expect, it } from "vitest";
import { normalizeStoredSemanticType, resolveLaneForStoredType } from "../services/hub-items.js";

// P3-1 (Task 10): the read-side lane resolver must never return `undefined` for
// a stray/pruned semanticType. The QA instance carries [SEED] rows of the pruned
// human_input_needed / scope_proposal types; lane-LESS reads (Home fetch, `q`
// search) must degrade them cleanly, not surface `lane: undefined`.
describe("resolveLaneForStoredType (P3-1 unknown-type strip)", () => {
  it("resolves a known semantic type to its real lane", () => {
    expect(resolveLaneForStoredType("approval_request")).toBe("waiting_on_you");
    expect(resolveLaneForStoredType("run_failed")).toBe("notifications");
    expect(resolveLaneForStoredType("suggestion")).toBe("suggestions");
  });

  it("returns null for a null semantic type", () => {
    expect(resolveLaneForStoredType(null)).toBeNull();
  });

  it("degrades a pruned type (human_input_needed) to the notifications lane, never undefined", () => {
    const lane = resolveLaneForStoredType("human_input_needed");
    expect(lane).toBe("notifications");
    expect(lane).not.toBeUndefined();
  });

  it("degrades a pruned type (scope_proposal) to the notifications lane, never undefined", () => {
    expect(resolveLaneForStoredType("scope_proposal")).toBe("notifications");
  });

  it("degrades an arbitrary unknown/legacy string to the notifications lane", () => {
    expect(resolveLaneForStoredType("old.plugin.type")).toBe("notifications");
  });

  it("normalizes pruned and unknown stored semantic types to legacy_other for UI registry safety", () => {
    expect(normalizeStoredSemanticType("human_input_needed")).toBe("legacy_other");
    expect(normalizeStoredSemanticType("scope_proposal")).toBe("legacy_other");
    expect(normalizeStoredSemanticType("old.plugin.type")).toBe("legacy_other");
    expect(normalizeStoredSemanticType("run_failed")).toBe("run_failed");
    expect(normalizeStoredSemanticType(null)).toBeNull();
  });
});
