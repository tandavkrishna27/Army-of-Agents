import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StatusDot } from "../status-dot";

describe("StatusDot", () => {
  it("renders with default active variant", () => {
    const { container } = render(<StatusDot />);
    const el = container.querySelector("span");
    expect(el).toBeInTheDocument();
    expect(el?.getAttribute("data-variant")).toBe("active");
    expect(el?.className).toContain("size-2");
    expect(el?.className).toContain("rounded-full");
  });

  it("applies live variant pulse animation class", () => {
    const { container } = render(<StatusDot variant="live" />);
    expect(container.querySelector("span")?.className).toContain("animate-pulse-glow");
  });

  it("applies idle variant", () => {
    const { container } = render(<StatusDot variant="idle" />);
    expect(container.querySelector("span")?.className).toContain("bg-data-slate");
  });

  it("applies pending / error / draft variants distinctly", () => {
    const pending = render(<StatusDot variant="pending" />).container.querySelector("span");
    const error = render(<StatusDot variant="error" />).container.querySelector("span");
    const draft = render(<StatusDot variant="draft" />).container.querySelector("span");
    expect(pending?.className).toContain("bg-warning");
    expect(error?.className).toContain("bg-error");
    expect(draft?.className).toContain("bg-info");
  });

  it("custom className merges through", () => {
    const { container } = render(<StatusDot className="custom-dot" />);
    expect(container.querySelector("span")).toHaveClass("custom-dot");
  });

  it("aria-hidden by default", () => {
    const { container } = render(<StatusDot />);
    expect(container.querySelector("span")?.getAttribute("aria-hidden")).toBe("true");
  });
});
