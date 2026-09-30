import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TypeChip } from "../TypeChip";

describe("TypeChip", () => {
  it("renders SKILL for type='skill'", () => {
    render(<TypeChip type="skill" />);
    expect(screen.getByText("SKILL")).toBeInTheDocument();
  });

  it("renders PLUGIN for type='plugin'", () => {
    render(<TypeChip type="plugin" />);
    expect(screen.getByText("PLUGIN")).toBeInTheDocument();
  });

  it("renders plugin as a blue badge", () => {
    const { container } = render(<TypeChip type="plugin" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("rounded-full");
    expect(el.className).toContain("bg-blue-500/10");
    expect(el.className).toContain("border-blue-500/25");
    expect(el.className).toContain("text-blue-400");
  });

  it("renders AGENT for type='agent'", () => {
    render(<TypeChip type="agent" />);
    expect(screen.getByText("AGENT")).toBeInTheDocument();
  });

  it("renders TEAM for type='team'", () => {
    render(<TypeChip type="team" />);
    expect(screen.getByText("TEAM")).toBeInTheDocument();
  });

  it("applies the type-chip styles (uppercase / 10px / very-dim)", () => {
    const { container } = render(<TypeChip type="skill" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("uppercase");
    expect(el.className).toContain("text-[10px]");
    expect(el.className).toContain("text-very-dim");
  });

  it("merges a className override", () => {
    const { container } = render(<TypeChip type="skill" className="absolute right-3 top-3" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("absolute");
    expect(el.className).toContain("right-3");
  });
});
