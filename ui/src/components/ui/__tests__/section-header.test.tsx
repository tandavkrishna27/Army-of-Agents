import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { SectionHeader } from "../section-header";

describe("SectionHeader", () => {
  it("renders title text", () => {
    const { container } = render(<SectionHeader>Identity</SectionHeader>);
    expect(container.textContent).toContain("Identity");
  });

  it("renders number badge when number prop provided", () => {
    const { container } = render(<SectionHeader number={1}>Identity</SectionHeader>);
    expect(container.textContent).toContain("1");
    expect(container.textContent).toContain("Identity");
  });

  it("does not render number badge when number is undefined", () => {
    const { container } = render(<SectionHeader>Identity</SectionHeader>);
    // Only one span (the title) should be present
    const spans = container.querySelectorAll("span");
    expect(spans).toHaveLength(1);
  });

  it("renders icon slot when icon prop provided", () => {
    const { container } = render(
      <SectionHeader icon={<svg data-testid="icon" />}>Identity</SectionHeader>
    );
    expect(container.querySelector("[data-testid='icon']")).toBeInTheDocument();
  });

  it("renders both number + icon when both provided", () => {
    const { container } = render(
      <SectionHeader number={2} icon={<svg data-testid="icon" />}>Adapter</SectionHeader>
    );
    expect(container.textContent).toContain("2");
    expect(container.querySelector("[data-testid='icon']")).toBeInTheDocument();
    expect(container.textContent).toContain("Adapter");
  });

  it("applies small-caps + tracking styles", () => {
    const { container } = render(<SectionHeader>X</SectionHeader>);
    const root = container.querySelector("div");
    expect(root?.className).toContain("uppercase");
    expect(root?.className).toContain("tracking-[0.1em]");
  });

  it("custom className merges through", () => {
    const { container } = render(<SectionHeader className="custom-section">X</SectionHeader>);
    expect(container.querySelector("div")).toHaveClass("custom-section");
  });
});
