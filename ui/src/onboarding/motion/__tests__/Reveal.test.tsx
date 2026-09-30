import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { Reveal } from "../Reveal";

function mockMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
}

describe("Reveal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders children and applies a delay style by default (no reduced motion)", () => {
    mockMatchMedia(false);
    const { getByText, container } = render(<Reveal delay={0.18}>hello</Reveal>);
    expect(getByText("hello")).toBeTruthy();
    expect((container.firstChild as HTMLElement).style.animationDelay).toBe("0.18s");
    expect((container.firstChild as HTMLElement).style.opacity).toBe("0");
  });

  it("under reduced motion, renders the bare tag with no inline opacity:0", () => {
    mockMatchMedia(true);
    const { getByText, container } = render(<Reveal delay={0.18}>hello</Reveal>);
    expect(getByText("hello")).toBeTruthy();
    const el = container.firstChild as HTMLElement;
    expect(el.style.opacity).toBe("");
    expect(el.style.animation).toBe("");
  });

  it("supports the `as` polymorphic tag", () => {
    mockMatchMedia(false);
    const { container } = render(<Reveal as="section">hi</Reveal>);
    expect(container.querySelector("section")).toBeTruthy();
  });

  it("`inView` defers the animation until the (mocked) IntersectionObserver fires", () => {
    mockMatchMedia(false);
    let capturedCallback: IntersectionObserverCallback | undefined;
    class MockIO {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      constructor(cb: IntersectionObserverCallback) {
        capturedCallback = cb;
      }
    }
    vi.stubGlobal("IntersectionObserver", MockIO);

    const { container } = render(<Reveal inView>hi</Reveal>);
    const el = container.firstChild as HTMLElement;
    // Before intersecting: still hidden (no animation running yet).
    expect(el.style.opacity).toBe("0");
    expect(el.style.animation).toBe("");

    act(() => {
      capturedCallback!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    expect(el.style.animation).toContain("obd-fadeUp");
    // Restored by the top-level afterEach's vi.unstubAllGlobals().
  });
});
