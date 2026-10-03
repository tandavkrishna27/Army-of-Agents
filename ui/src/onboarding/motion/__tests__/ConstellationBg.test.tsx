import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { ConstellationBg } from "../ConstellationBg";

function mock2dContext() {
  return {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

describe("ConstellationBg", () => {
  let getContextSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(() => mock2dContext());
  });

  afterEach(() => {
    getContextSpy.mockRestore();
    // Restores any window.ResizeObserver / window.matchMedia overwritten via
    // vi.stubGlobal below, even if a test body throws before reaching its
    // own cleanup line.
    vi.unstubAllGlobals();
  });

  it("renders a canvas", () => {
    const { container } = render(<ConstellationBg />);
    expect(container.querySelector("canvas")).toBeTruthy();
  });

  it("does not throw when the 2d context is unavailable (jsdom has no real canvas)", () => {
    getContextSpy.mockImplementation(() => null);
    expect(() => render(<ConstellationBg />)).not.toThrow();
  });

  it("cleans up its rAF, timers, and listeners on unmount", () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const removeListenerSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = render(<ConstellationBg />);
    unmount();

    expect(cancelSpy).toHaveBeenCalledWith(42);
    expect(removeListenerSpy).toHaveBeenCalledWith("resize", expect.any(Function));

    rafSpy.mockRestore();
    cancelSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  it("observes and disconnects a ResizeObserver on the canvas", () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    const unobserve = vi.fn();
    class RO {
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
    }
    vi.stubGlobal("ResizeObserver", RO);

    const { unmount } = render(<ConstellationBg />);
    expect(observe).toHaveBeenCalled();
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it("repaints after a resize under reduced motion instead of staying blank", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );

    const ctx = mock2dContext();
    getContextSpy.mockImplementation(() => ctx);

    render(<ConstellationBg />);

    // Clear the draw calls recorded during the initial mount's static frame
    // so the assertions below only see resize-triggered activity.
    const clearRect = ctx.clearRect as ReturnType<typeof vi.fn>;
    const arc = ctx.arc as ReturnType<typeof vi.fn>;
    const fill = ctx.fill as ReturnType<typeof vi.fn>;
    clearRect.mockClear();
    arc.mockClear();
    fill.mockClear();

    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(clearRect).toHaveBeenCalled();
    expect(arc).toHaveBeenCalled();
    expect(fill).toHaveBeenCalled();
  });

  it("pins its CSS size to the container so the bitmap size cannot feed back into layout", () => {
    const { container } = render(<ConstellationBg />);
    const canvas = container.querySelector("canvas")!;
    expect(canvas.style.width).toBe("100%");
    expect(canvas.style.height).toBe("100%");
  });

  it("does not grow its bitmap on repeated resizes at devicePixelRatio 2", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true, // reduced motion: static frames, no rAF loop
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );

    // Emulate real layout: an absolutely-positioned canvas stretches to its
    // container only if it has an explicit CSS size; otherwise it renders at
    // its intrinsic (bitmap) size, exactly like a browser does.
    const container = { width: 1024, height: 768 };
    const rectSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLCanvasElement) {
        const pinned = this.style.width === "100%" && this.style.height === "100%";
        const width = pinned ? container.width : this.width;
        const height = pinned ? container.height : this.height;
        return {
          width,
          height,
          top: 0,
          left: 0,
          right: width,
          bottom: height,
          x: 0,
          y: 0,
          toJSON() {},
        } as DOMRect;
      });

    const { container: dom } = render(<ConstellationBg />);
    const canvas = dom.querySelector("canvas")!;

    for (let i = 0; i < 5; i++) {
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
    }

    expect(canvas.width).toBe(2048);
    expect(canvas.height).toBe(1536);
    rectSpy.mockRestore();
  });
});
