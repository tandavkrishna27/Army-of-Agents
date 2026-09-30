import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBreakpoint } from "../lib/useBreakpoint";

/**
 * Drives useBreakpoint by mocking window.matchMedia + window.innerWidth.
 *
 * The hook recomputes its tier from window.innerWidth whenever ANY of its
 * boundary media queries fires a "change" event, so the harness keeps a list of
 * registered listeners and replays them whenever we resize.
 */
type ChangeListener = (e: MediaQueryListEvent) => void;

let listeners: ChangeListener[] = [];

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: width,
  });
}

function fireResize() {
  act(() => {
    for (const l of listeners) {
      l({ matches: true } as MediaQueryListEvent);
    }
  });
}

beforeEach(() => {
  listeners = [];
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (_event: string, cb: ChangeListener) => {
        listeners.push(cb);
      },
      removeEventListener: (_event: string, cb: ChangeListener) => {
        listeners = listeners.filter((l) => l !== cb);
      },
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useBreakpoint", () => {
  it("reports mobile below 640px", () => {
    setWidth(500);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current.tier).toBe("mobile");
    expect(result.current.isMobile).toBe(true);
    expect(result.current.useDrawerSessions).toBe(true);
    expect(result.current.isDesktopUp).toBe(false);
    expect(result.current.isWide).toBe(false);
  });

  it("reports tablet between 640px and 1023px", () => {
    setWidth(800);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current.tier).toBe("tablet");
    expect(result.current.isTablet).toBe(true);
    expect(result.current.useDrawerSessions).toBe(true);
    expect(result.current.isDesktopUp).toBe(false);
  });

  it("reports desktop between 1024px and 1535px (drawer off)", () => {
    setWidth(1280);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current.tier).toBe("desktop");
    expect(result.current.isDesktopUp).toBe(true);
    expect(result.current.useDrawerSessions).toBe(false);
    expect(result.current.isWide).toBe(false);
  });

  it("reports wide at 1536px and above", () => {
    setWidth(1600);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current.tier).toBe("wide");
    expect(result.current.isWide).toBe(true);
    expect(result.current.isDesktopUp).toBe(true);
    expect(result.current.useDrawerSessions).toBe(false);
  });

  it("transitions across tiers on resize", () => {
    setWidth(500);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current.tier).toBe("mobile");

    setWidth(900);
    fireResize();
    expect(result.current.tier).toBe("tablet");

    setWidth(1300);
    fireResize();
    expect(result.current.tier).toBe("desktop");
    expect(result.current.useDrawerSessions).toBe(false);

    setWidth(1700);
    fireResize();
    expect(result.current.tier).toBe("wide");

    setWidth(400);
    fireResize();
    expect(result.current.tier).toBe("mobile");
    expect(result.current.useDrawerSessions).toBe(true);
  });

  it("respects exact tier boundaries", () => {
    setWidth(640);
    const tablet = renderHook(() => useBreakpoint());
    expect(tablet.result.current.tier).toBe("tablet");

    setWidth(1024);
    const desktop = renderHook(() => useBreakpoint());
    expect(desktop.result.current.tier).toBe("desktop");

    setWidth(1536);
    const wide = renderHook(() => useBreakpoint());
    expect(wide.result.current.tier).toBe("wide");
  });
});
