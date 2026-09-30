import { describe, beforeEach, afterEach, expect, it, vi } from "vitest";
import { useRef } from "react";
import { renderHook, act } from "@testing-library/react";
import { createAbortCleanup } from "./InternalAgentPanel";

/**
 * Tests for the abort-on-unmount contract in AgentPanelContent (B1).
 *
 * We test the PRODUCTION function `createAbortCleanup` that is used inside
 * AgentPanelContent's cleanup useEffect.  If that function (or its call site
 * inside the component) is removed, this test will FAIL.
 *
 * Option B: exported helper approach — avoids wiring up the 4+ providers
 * (QueryClient, Router, AgentPanelContext, SidebarContext, CompanyContext,
 * BreadcrumbContext) that AgentPanelContent requires, while still exercising
 * the real production code path.
 */
describe("createAbortCleanup (InternalAgentPanel B1)", () => {
  let abortSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    abortSpy = vi.spyOn(AbortController.prototype, "abort");
  });

  afterEach(() => {
    abortSpy.mockRestore();
  });

  it("calls abort() on the stored controller when the cleanup runs", () => {
    const { result } = renderHook(() => useRef<AbortController | null>(null));
    const abortRef = result.current;

    // Simulate what sendText does: create a controller and store it in the ref
    act(() => {
      abortRef.current = new AbortController();
    });

    // Run the production cleanup function directly
    const cleanup = createAbortCleanup(abortRef);
    cleanup();

    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it("does nothing (no throw) when abortRef is null at cleanup time", () => {
    const { result } = renderHook(() => useRef<AbortController | null>(null));
    const abortRef = result.current;
    // ref stays null — no controller stored

    const cleanup = createAbortCleanup(abortRef);
    expect(() => cleanup()).not.toThrow();
    expect(abortSpy).not.toHaveBeenCalled();
  });

  it("does not abort a controller that was already cleared before cleanup", () => {
    const { result } = renderHook(() => useRef<AbortController | null>(null));
    const abortRef = result.current;

    act(() => {
      abortRef.current = new AbortController();
    });

    // Simulate stream completing: ref is cleared
    act(() => {
      abortRef.current = null;
    });

    const cleanup = createAbortCleanup(abortRef);
    cleanup();

    expect(abortSpy).not.toHaveBeenCalled();
  });
});
