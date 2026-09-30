import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { SplashScreen } from "../SplashScreen";

function mockMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

const SPLASH_TEXT = "Assembling your workforce…";

describe("SplashScreen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders the AoA wordmark", () => {
    mockMatchMedia(false);
    render(<SplashScreen onDone={vi.fn()} />);
    expect(screen.getByRole("img", { name: "Army of Agents" })).toBeTruthy();
  });

  it("types the status line at 55ms/char and calls onDone only after typing finishes plus a short delay", () => {
    mockMatchMedia(false);
    const onDone = vi.fn();
    render(<SplashScreen onDone={onDone} />);

    // Nothing typed yet.
    expect(screen.queryByText(SPLASH_TEXT)).toBeNull();
    expect(onDone).not.toHaveBeenCalled();

    // Advance through the full typewriter sequence.
    act(() => {
      vi.advanceTimersByTime(SPLASH_TEXT.length * 55);
    });
    expect(screen.getByText(SPLASH_TEXT)).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();

    // Typing finished; onDone should still be pending the short post-type delay.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onDone).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("does not call onDone more than once", () => {
    mockMatchMedia(false);
    const onDone = vi.fn();
    render(<SplashScreen onDone={onDone} />);

    act(() => {
      vi.advanceTimersByTime(SPLASH_TEXT.length * 55);
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onDone).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("under reduced motion, skips the typed animation and calls onDone almost immediately", () => {
    mockMatchMedia(true);
    const onDone = vi.fn();
    render(<SplashScreen onDone={onDone} />);

    // Full text is present immediately — no incremental reveal.
    expect(screen.getByText(SPLASH_TEXT)).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("cleans up its pending timer on unmount without calling onDone afterward", () => {
    mockMatchMedia(false);
    const onDone = vi.fn();
    const { unmount } = render(<SplashScreen onDone={onDone} />);

    act(() => {
      vi.advanceTimersByTime(SPLASH_TEXT.length * 55);
    });
    unmount();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onDone).not.toHaveBeenCalled();
  });
});
