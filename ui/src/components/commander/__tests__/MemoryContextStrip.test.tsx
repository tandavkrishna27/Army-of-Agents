import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryContextStrip } from "../MemoryContextStrip";

describe("MemoryContextStrip", () => {
  it("renders Commander recall strictness and included layers", () => {
    render(
      <MemoryContextStrip
        strictness="balanced"
        layers={["identity", "domain", "active_context", "working"]}
        surface="task"
      />,
    );

    expect(screen.getByText(/balanced/i)).toBeInTheDocument();
    expect(screen.getByText(/task/i)).toBeInTheDocument();
    expect(screen.getAllByText(/working/i).length).toBeGreaterThan(0);
  });
});
