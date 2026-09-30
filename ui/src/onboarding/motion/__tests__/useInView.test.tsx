import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useInView } from "../useInView";

let capturedCallback: IntersectionObserverCallback | undefined;
let capturedOptions: IntersectionObserverInit | undefined;
let lastInstance: MockIntersectionObserver | undefined;

class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    capturedCallback = cb;
    capturedOptions = options;
    lastInstance = this;
  }
}

function TestComponent({ once }: { once?: boolean }) {
  const [ref, inView] = useInView({ once, margin: "-100px" });
  return (
    <div ref={ref as (node: HTMLDivElement | null) => void} data-testid="target">
      {inView ? "in" : "out"}
    </div>
  );
}

describe("useInView", () => {
  afterEach(() => {
    // Restores window.IntersectionObserver even if a test body throws
    // before reaching its own cleanup line, so a mid-test failure can't
    // leak the mock into other tests.
    vi.unstubAllGlobals();
  });

  it("starts out of view and flips to in-view when the observer reports an intersection", () => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

    const { getByTestId } = render(<TestComponent />);
    expect(getByTestId("target").textContent).toBe("out");

    act(() => {
      capturedCallback!(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });

    expect(getByTestId("target").textContent).toBe("in");
    expect(capturedOptions?.rootMargin).toBe("-100px");
  });

  it("`once` disconnects the observer after the first intersection", () => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

    render(<TestComponent once />);
    act(() => {
      capturedCallback!(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });

    expect(lastInstance?.disconnect).toHaveBeenCalled();
  });
});
