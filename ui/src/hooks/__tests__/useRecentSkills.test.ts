// ui/src/hooks/__tests__/useRecentSkills.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRecentSkills } from "../useRecentSkills";

describe("useRecentSkills", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns empty array initially", () => {
    const { result } = renderHook(() => useRecentSkills());
    expect(result.current.recent).toEqual([]);
  });

  it("records a skill open", () => {
    const { result } = renderHook(() => useRecentSkills());
    act(() => result.current.recordOpen("s1"));
    expect(result.current.recent.map((r) => r.skillId)).toEqual(["s1"]);
  });

  it("dedupes by skillId, moving the existing entry to the front", () => {
    const { result } = renderHook(() => useRecentSkills());
    act(() => result.current.recordOpen("s1"));
    act(() => result.current.recordOpen("s2"));
    act(() => result.current.recordOpen("s1"));
    expect(result.current.recent.map((r) => r.skillId)).toEqual(["s1", "s2"]);
  });

  it("caps the list at 5 entries", () => {
    const { result } = renderHook(() => useRecentSkills());
    act(() => {
      result.current.recordOpen("s1");
      result.current.recordOpen("s2");
      result.current.recordOpen("s3");
      result.current.recordOpen("s4");
      result.current.recordOpen("s5");
      result.current.recordOpen("s6");
    });
    expect(result.current.recent).toHaveLength(5);
    expect(result.current.recent.map((r) => r.skillId)).toEqual([
      "s6",
      "s5",
      "s4",
      "s3",
      "s2",
    ]);
  });

  it("persists across hook unmount/remount", () => {
    const { result, unmount } = renderHook(() => useRecentSkills());
    act(() => result.current.recordOpen("s-persist"));
    unmount();
    const { result: result2 } = renderHook(() => useRecentSkills());
    expect(result2.current.recent.map((r) => r.skillId)).toEqual(["s-persist"]);
  });

  it("ignores corrupt JSON in localStorage", () => {
    localStorage.setItem("aoa:skills:recent", "not-json{{");
    const { result } = renderHook(() => useRecentSkills());
    expect(result.current.recent).toEqual([]);
  });
});
