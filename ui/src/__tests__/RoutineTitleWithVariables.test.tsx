import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoutineTitleWithVariables } from "../components/routines/RoutineTitleWithVariables";

describe("RoutineTitleWithVariables", () => {
  it("renders plain title text without chips when no variables", () => {
    const { container } = render(<RoutineTitleWithVariables template="Daily standup notes" />);
    expect(screen.getByText("Daily standup notes")).toBeInTheDocument();
    // No chip elements — chip class contains "rounded-md bg-primary"
    const chips = container.querySelectorAll(".rounded-md.bg-primary\\/10");
    expect(chips.length).toBe(0);
  });

  it("renders {{var}} as an inline chip with the bare variable name", () => {
    render(<RoutineTitleWithVariables template="Deploy {{environment}}" />);
    expect(screen.getByText("Deploy")).toBeInTheDocument();
    expect(screen.getByText("environment")).toBeInTheDocument();
  });

  it("interleaves plain text and chips for multiple variables", () => {
    const { container } = render(
      <RoutineTitleWithVariables template="Run {{job}} for {{department}} on {{date}}" />
    );
    expect(container.textContent).toMatch(/Run/);
    expect(screen.getByText("job")).toBeInTheDocument();
    expect(screen.getByText("department")).toBeInTheDocument();
    expect(screen.getByText("date")).toBeInTheDocument();
  });

  it("returns null for empty template", () => {
    const { container } = render(<RoutineTitleWithVariables template="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("treats malformed braces as plain text", () => {
    render(<RoutineTitleWithVariables template="Hello {{bad name}} world" />);
    // {{bad name}} fails the variable regex (space inside name), so renders as plain text
    expect(screen.getByText(/\{\{bad name\}\}/)).toBeInTheDocument();
  });
});
