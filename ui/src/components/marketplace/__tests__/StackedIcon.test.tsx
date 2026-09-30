import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Bot, Sparkles } from "lucide-react";
import { StackedIcon } from "../StackedIcon";

describe("StackedIcon", () => {
  it("renders 3 layers", () => {
    const { container } = render(<StackedIcon icon={Bot} tone="teal" />);
    const layers = container.querySelectorAll('[data-stacked-layer]');
    expect(layers).toHaveLength(3);
  });

  it("marks layers as back / mid / front", () => {
    const { container } = render(<StackedIcon icon={Bot} tone="teal" />);
    expect(container.querySelector('[data-stacked-layer="back"]')).toBeTruthy();
    expect(container.querySelector('[data-stacked-layer="mid"]')).toBeTruthy();
    expect(container.querySelector('[data-stacked-layer="front"]')).toBeTruthy();
  });

  it("renders the lucide icon in each layer", () => {
    const { container } = render(<StackedIcon icon={Sparkles} tone="amber" />);
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBe(3);
  });

  it("uses tone='teal' classes for teams", () => {
    const { container } = render(<StackedIcon icon={Bot} tone="teal" />);
    const front = container.querySelector('[data-stacked-layer="front"]') as HTMLElement;
    expect(front.className).toContain("border-teal");
  });

  it("uses tone='amber' classes for packages", () => {
    const { container } = render(<StackedIcon icon={Sparkles} tone="amber" />);
    const front = container.querySelector('[data-stacked-layer="front"]') as HTMLElement;
    expect(front.className).toContain("border-amber");
  });

  it("merges a className override on the wrapper", () => {
    const { container } = render(<StackedIcon icon={Bot} tone="teal" className="size-20" />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("size-20");
  });
});
