import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePrefersReducedMotion } from "../usePrefersReducedMotion";

function mockMatchMedia(matches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
    dispatchEvent: vi.fn(),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation(() => mql),
  );
  return { fire: (next: boolean) => {
    mql.matches = next;
    listeners.forEach((cb) => cb({ matches: next } as MediaQueryListEvent));
  } };
}

describe("usePrefersReducedMotion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false when the media query does not match", () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });

  it("returns true when the media query matches", () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
  });
});
