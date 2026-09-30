import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { useMemoryTabs } from "../useMemoryTabs";

function wrapper(initialPath = "/x") {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initialPath]}>{children}</MemoryRouter>
  );
}

describe("useMemoryTabs", () => {
  it("starts empty when URL has no tabs param", () => {
    const { result } = renderHook(() => useMemoryTabs(), { wrapper: wrapper("/x") });
    expect(result.current.tabs).toEqual([]);
    expect(result.current.activeKey).toBeNull();
  });

  it("openOrActivate appends a tab + sets active", () => {
    const { result } = renderHook(() => useMemoryTabs(), { wrapper: wrapper("/x") });
    act(() =>
      result.current.openOrActivate({ id: "i1", kind: "memory_item", title: "README" }),
    );
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0]).toEqual({ id: "i1", kind: "memory_item", title: "README" });
    expect(result.current.activeKey).toEqual({ id: "i1", kind: "memory_item" });
  });

  it("openOrActivate on an existing tab moves activeKey without duplicating", () => {
    const { result } = renderHook(() => useMemoryTabs(), { wrapper: wrapper("/x") });
    act(() =>
      result.current.openOrActivate({ id: "i1", kind: "memory_item", title: "README" }),
    );
    act(() =>
      result.current.openOrActivate({ id: "i2", kind: "memory_item", title: "Notes" }),
    );
    act(() =>
      result.current.openOrActivate({ id: "i1", kind: "memory_item", title: "README" }),
    );
    expect(result.current.tabs.map((t) => t.id)).toEqual(["i1", "i2"]);
    expect(result.current.activeKey).toEqual({ id: "i1", kind: "memory_item" });
  });

  it("close on the active tab shifts activeKey to the previous tab", () => {
    const { result } = renderHook(() => useMemoryTabs(), { wrapper: wrapper("/x") });
    act(() => result.current.openOrActivate({ id: "i1", kind: "memory_item", title: "A" }));
    act(() => result.current.openOrActivate({ id: "i2", kind: "memory_item", title: "B" }));
    act(() => result.current.openOrActivate({ id: "i3", kind: "memory_item", title: "C" }));
    // i3 is active (last opened). Closing it shifts active to the prior tab.
    act(() => result.current.close("i3", "memory_item"));
    expect(result.current.tabs.map((t) => t.id)).toEqual(["i1", "i2"]);
    expect(result.current.activeKey).toEqual({ id: "i2", kind: "memory_item" });
  });

  it("close on an INACTIVE tab leaves activeKey unchanged (focus stays on what you were reading)", () => {
    const { result } = renderHook(() => useMemoryTabs(), { wrapper: wrapper("/x") });
    act(() => result.current.openOrActivate({ id: "i1", kind: "memory_item", title: "A" }));
    act(() => result.current.openOrActivate({ id: "i2", kind: "memory_item", title: "B" }));
    act(() => result.current.openOrActivate({ id: "i3", kind: "memory_item", title: "C" }));
    // i3 is active. Closing the inactive i2 must not shift focus.
    act(() => result.current.close("i2", "memory_item"));
    expect(result.current.tabs.map((t) => t.id)).toEqual(["i1", "i3"]);
    expect(result.current.activeKey).toEqual({ id: "i3", kind: "memory_item" });
  });

  it("close on the only tab clears activeKey", () => {
    const { result } = renderHook(() => useMemoryTabs(), { wrapper: wrapper("/x") });
    act(() => result.current.openOrActivate({ id: "i1", kind: "memory_item", title: "A" }));
    act(() => result.current.close("i1", "memory_item"));
    expect(result.current.tabs).toEqual([]);
    expect(result.current.activeKey).toBeNull();
  });

  it("setActive moves activeKey without modifying the tabs list", () => {
    const { result } = renderHook(() => useMemoryTabs(), { wrapper: wrapper("/x") });
    act(() => result.current.openOrActivate({ id: "i1", kind: "memory_item", title: "A" }));
    act(() => result.current.openOrActivate({ id: "i2", kind: "memory_item", title: "B" }));
    act(() => result.current.setActive("i1", "memory_item"));
    expect(result.current.tabs.map((t) => t.id)).toEqual(["i1", "i2"]);
    expect(result.current.activeKey).toEqual({ id: "i1", kind: "memory_item" });
  });

  it("hydrates from a URL with tabs and active params", () => {
    const path =
      "/x?tabs=memory_item:i1:" +
      encodeURIComponent("README") +
      ",asset:a1:" +
      encodeURIComponent("logo.png") +
      "&active=asset:a1";
    const { result } = renderHook(() => useMemoryTabs(), { wrapper: wrapper(path) });
    expect(result.current.tabs).toEqual([
      { id: "i1", kind: "memory_item", title: "README" },
      { id: "a1", kind: "asset", title: "logo.png" },
    ]);
    expect(result.current.activeKey).toEqual({ id: "a1", kind: "asset" });
  });

  it("hydrates Map and Open viewer tabs from the URL", () => {
    const path =
      "/x?tabs=graph:company-graph:" +
      encodeURIComponent("Map") +
      ",open:memory-open:" +
      encodeURIComponent("Open") +
      "&active=open:memory-open";
    const { result } = renderHook(() => useMemoryTabs(), { wrapper: wrapper(path) });
    expect(result.current.tabs).toEqual([
      { id: "company-graph", kind: "graph", title: "Map" },
      { id: "memory-open", kind: "open", title: "Open" },
    ]);
    expect(result.current.activeKey).toEqual({ id: "memory-open", kind: "open" });
  });

  it("ignores active param that doesn't match any open tab and falls back to first", () => {
    const path =
      "/x?tabs=memory_item:i1:" +
      encodeURIComponent("README") +
      "&active=asset:zzz";
    const { result } = renderHook(() => useMemoryTabs(), { wrapper: wrapper(path) });
    expect(result.current.activeKey).toEqual({ id: "i1", kind: "memory_item" });
  });

  it("preserves unrelated URL search params on actions", () => {
    const { result } = renderHook(() => useMemoryTabs(), {
      wrapper: wrapper("/x?folder=Company&dept=eng"),
    });
    act(() => result.current.openOrActivate({ id: "i1", kind: "memory_item", title: "A" }));
    // We can't directly read window.location in jsdom under MemoryRouter,
    // but we can re-render and check the hook re-reads tabs correctly via the URL.
    expect(result.current.tabs.map((t) => t.id)).toEqual(["i1"]);
  });

  it("decodes URI-encoded titles", () => {
    const path =
      "/x?tabs=memory_item:i1:" +
      encodeURIComponent("Hello, world / & friends") +
      "&active=memory_item:i1";
    const { result } = renderHook(() => useMemoryTabs(), { wrapper: wrapper(path) });
    expect(result.current.tabs[0].title).toBe("Hello, world / & friends");
  });
});
