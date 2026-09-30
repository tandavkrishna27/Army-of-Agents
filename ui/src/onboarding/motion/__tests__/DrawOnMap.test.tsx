import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { DrawOnMap } from "../DrawOnMap";

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

const EDGES = [
  { id: "a", d: "M0,0 L10,10" },
  { id: "b", d: "M0,0 L20,20", depth: 1 },
  { id: "c", d: "M0,0 L30,30", depth: 2 },
];

function renderInSvg(children: React.ReactNode) {
  return render(<svg>{children}</svg>);
}

describe("DrawOnMap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders one <path> edge per entry, depth-staggered", () => {
    mockMatchMedia(false);
    const { container } = renderInSvg(<DrawOnMap edges={EDGES} />);
    const paths = container.querySelectorAll("path");
    expect(paths.length).toBe(3);
    expect(container.querySelector('[data-testid="map-edge-b"]')).toHaveAttribute("data-depth", "1");
  });

  it("animates via stroke-dashoffset by default (no reduced motion)", () => {
    mockMatchMedia(false);
    const { container } = renderInSvg(<DrawOnMap edges={EDGES} />);
    const first = container.querySelector('[data-testid="map-edge-a"]') as SVGPathElement;
    expect(first.style.strokeDashoffset).toBe("1");
    expect(first.style.animation).toContain("obd-draw-edge");
  });

  it("under reduced motion, edges draw instantly — no stuck dashoffset/hidden state", () => {
    mockMatchMedia(true);
    const { container } = renderInSvg(<DrawOnMap edges={EDGES} />);
    const paths = container.querySelectorAll("path");
    paths.forEach((path) => {
      const el = path as SVGPathElement;
      expect(el.style.animation).toBe("");
      expect(el.style.strokeDashoffset === "" || el.style.strokeDashoffset === "0").toBe(true);
    });
  });
});
