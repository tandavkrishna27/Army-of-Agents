import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MiniMap } from "../MiniMap";

describe("MiniMap (WS9/WS10 — read-only diagram, no door band)", () => {
  it("renders the flow diagram without any door band", () => {
    render(<MiniMap />);

    expect(screen.getByText(/Commander/)).toBeInTheDocument();
    expect(screen.getByText(/TASK/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /In-flight/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Explorer/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Greenfield/ })).toBeNull();
  });

  it("shows the default invited caption, or a custom one", () => {
    const { rerender } = render(<MiniMap />);
    expect(screen.getByText("The machine you're joining")).toBeInTheDocument();

    rerender(<MiniMap caption="Custom caption" />);
    expect(screen.getByText("Custom caption")).toBeInTheDocument();
  });
});
