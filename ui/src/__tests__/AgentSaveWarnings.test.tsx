import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentSaveWarnings } from "../components/AgentSaveWarnings";

describe("AgentSaveWarnings", () => {
  it("renders null for empty warnings", () => {
    const { container } = render(<AgentSaveWarnings warnings={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders warnings with role=alert", () => {
    render(<AgentSaveWarnings warnings={["Model corrected to claude-3-5-sonnet", "Check your config"]} />);
    const alert = screen.getByRole("alert");
    expect(alert).toBeTruthy();
    expect(screen.getByText("Heads up: Model corrected to claude-3-5-sonnet")).toBeTruthy();
    expect(screen.getByText("Heads up: Check your config")).toBeTruthy();
  });

  it("renders a single warning with role=alert", () => {
    render(<AgentSaveWarnings warnings={["Only one issue"]} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Heads up: Only one issue")).toBeTruthy();
  });
});
