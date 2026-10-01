import { describe, expect, it, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { SidebarProvider, useSidebar } from "@/context/SidebarContext";

describe("SidebarProvider display modes", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1280 });
  });

  it("supports expanded, compact, and hidden modes with persistence", () => {
    const { result } = renderHook(() => useSidebar(), {
      wrapper: SidebarProvider,
    });

    expect(result.current.mode).toBe("expanded");
    act(() => result.current.setMode("compact"));
    expect(result.current.mode).toBe("compact");
    expect(result.current.collapsed).toBe(true);

    act(() => result.current.setMode("hidden"));
    expect(result.current.mode).toBe("hidden");
    expect(result.current.hidden).toBe(true);
    expect(localStorage.getItem("aoa:sidebar-mode")).toBe("hidden");

    act(() => result.current.setMode("expanded"));
    expect(result.current.mode).toBe("expanded");
    expect(result.current.hidden).toBe(false);
  });

  it("cycles the header control through expanded, compact, hidden, and back", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper: SidebarProvider });

    act(() => result.current.toggleCollapse());
    expect(result.current.mode).toBe("compact");
    act(() => result.current.toggleCollapse());
    expect(result.current.mode).toBe("hidden");
    act(() => result.current.toggleCollapse());
    expect(result.current.mode).toBe("expanded");
  });

  it("keeps temporary route modes separate from the saved preference", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper: SidebarProvider });
    act(() => result.current.setMode("expanded"));
    act(() => result.current.setTransientMode("hidden"));
    expect(result.current.mode).toBe("hidden");
    act(() => result.current.setTransientMode(null));
    expect(result.current.mode).toBe("expanded");
  });
});
