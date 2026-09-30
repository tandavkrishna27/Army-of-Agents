import { describe, expect, it } from "vitest";
import { acceptHint, acceptSnapshot, type ReconciliationState } from "./reconciliation-state";

const current = (): ReconciliationState => ({generation: 1, lastSeq: 12, status: "current", dirtyRefs: []});

describe("Universe reconciliation state", () => {
  it("does not advance the durable cursor for a local hint", () => {
    expect(acceptHint(current(), {referenceKey: "task:a"}).lastSeq).toBe(12);
  });

  it("ignores duplicate durable hints and deduplicates dirty references", () => {
    const state = current();
    expect(acceptHint(state, {seq: 11, referenceKey: "task:a"})).toBe(state);
    const once = acceptHint(state, {seq: 13, referenceKey: "task:a"});
    expect(acceptHint(once, {seq: 14, referenceKey: "task:a"}).dirtyRefs).toEqual(["task:a"]);
  });

  it("marks a canonical snapshot current and preserves the higher observed cursor", () => {
    const stale = acceptHint(current(), {seq: 14, referenceKey: "task:a"});
    expect(acceptSnapshot(stale, 13)).toEqual({...stale, status: "current", dirtyRefs: []});
  });
});
