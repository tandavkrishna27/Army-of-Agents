import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  sidebarCollapsedKey,
  useSidebarCollapsed,
} from "../components/workspace/useSidebarCollapsed";

describe("sidebarCollapsedKey", () => {
  it("includes workspaceId and side", () => {
    expect(sidebarCollapsedKey("ws-1", "left")).toBe("aoa:workspace:ws-1:sidebar-left-collapsed");
    expect(sidebarCollapsedKey("ws-2", "right")).toBe("aoa:workspace:ws-2:sidebar-right-collapsed");
  });
});

describe("useSidebarCollapsed", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to false when nothing stored", () => {
    const { result } = renderHook(() => useSidebarCollapsed("ws-1", "left"));
    expect(result.current[0]).toBe(false);
  });

  it("reads 'true' from localStorage as true", () => {
    localStorage.setItem("aoa:workspace:ws-1:sidebar-left-collapsed", "true");
    const { result } = renderHook(() => useSidebarCollapsed("ws-1", "left"));
    expect(result.current[0]).toBe(true);
  });

  it("reads 'false' from localStorage as false", () => {
    localStorage.setItem("aoa:workspace:ws-1:sidebar-left-collapsed", "false");
    const { result } = renderHook(() => useSidebarCollapsed("ws-1", "left"));
    expect(result.current[0]).toBe(false);
  });

  it("treats malformed values as false", () => {
    localStorage.setItem("aoa:workspace:ws-1:sidebar-left-collapsed", "garbage");
    const { result } = renderHook(() => useSidebarCollapsed("ws-1", "left"));
    expect(result.current[0]).toBe(false);
  });

  it("writes to the correct key when setCollapsed is called", () => {
    const { result } = renderHook(() => useSidebarCollapsed("ws-1", "left"));
    act(() => {
      result.current[1](true);
    });
    expect(localStorage.getItem("aoa:workspace:ws-1:sidebar-left-collapsed")).toBe("true");
    expect(result.current[0]).toBe(true);
  });

  it("side parameter changes the storage key", () => {
    const { result } = renderHook(() => useSidebarCollapsed("ws-1", "right"));
    act(() => {
      result.current[1](true);
    });
    expect(localStorage.getItem("aoa:workspace:ws-1:sidebar-right-collapsed")).toBe("true");
    expect(localStorage.getItem("aoa:workspace:ws-1:sidebar-left-collapsed")).toBeNull();
  });

  it("different workspaceIds have independent state", () => {
    localStorage.setItem("aoa:workspace:ws-1:sidebar-left-collapsed", "true");
    localStorage.setItem("aoa:workspace:ws-2:sidebar-left-collapsed", "false");
    const { result: r1 } = renderHook(() => useSidebarCollapsed("ws-1", "left"));
    const { result: r2 } = renderHook(() => useSidebarCollapsed("ws-2", "left"));
    expect(r1.current[0]).toBe(true);
    expect(r2.current[0]).toBe(false);
  });

  it("re-syncs when workspaceId changes", () => {
    localStorage.setItem("aoa:workspace:ws-1:sidebar-left-collapsed", "true");
    localStorage.setItem("aoa:workspace:ws-2:sidebar-left-collapsed", "false");
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useSidebarCollapsed(id, "left"),
      { initialProps: { id: "ws-1" } },
    );
    expect(result.current[0]).toBe(true);
    rerender({ id: "ws-2" });
    expect(result.current[0]).toBe(false);
  });
});
