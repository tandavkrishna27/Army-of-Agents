import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { ToastProvider, useToast } from "../ToastContext";

function wrapper({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ToastContext engine", () => {
  it("loading toast is sticky and never auto-dismisses", () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    let id: string | null = null;
    act(() => { id = result.current.pushToast({ title: "Installing", tone: "loading" }); });
    expect(id).toEqual(expect.any(String));
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].tone).toBe("loading");
  });

  it("loading skips dedupe and always returns a fresh id", () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    let a: string | null = null;
    let b: string | null = null;
    act(() => { a = result.current.pushToast({ title: "Installing X", tone: "loading" }); });
    act(() => { b = result.current.pushToast({ title: "Installing X", tone: "loading" }); });
    expect(a).toEqual(expect.any(String));
    expect(b).toEqual(expect.any(String));
    expect(a).not.toBe(b);
    expect(result.current.toasts).toHaveLength(2);
  });

  it("updateToast flips loading→success and arms the TTL so it auto-dismisses", () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    let id = "";
    act(() => { id = result.current.pushToast({ title: "Installing", tone: "loading" })!; });
    act(() => { result.current.updateToast(id, { tone: "success", title: "Installed" }); });
    expect(result.current.toasts[0].tone).toBe("success");
    expect(result.current.toasts[0].title).toBe("Installed");
    act(() => { vi.advanceTimersByTime(3500); }); // success default TTL
    expect(result.current.toasts).toHaveLength(0);
  });

  it("updateToast works in the SAME tick as pushToast (no effect-lag race)", () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    act(() => {
      const id = result.current.pushToast({ title: "Installing", tone: "loading" })!;
      result.current.updateToast(id, { tone: "success", title: "Installed" });
    });
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].tone).toBe("success");
    expect(result.current.toasts[0].title).toBe("Installed");
  });

  it("updateToast on an unknown id is a no-op", () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    act(() => { result.current.updateToast("missing", { title: "x" }); });
    expect(result.current.toasts).toHaveLength(0);
  });

  it("carries optional meta.ref through to the toast item", () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    act(() => { result.current.pushToast({ title: "Atlas run succeeded", tone: "success", meta: { ref: "TASK-128" } }); });
    expect(result.current.toasts[0].meta?.ref).toBe("TASK-128");
  });
});
