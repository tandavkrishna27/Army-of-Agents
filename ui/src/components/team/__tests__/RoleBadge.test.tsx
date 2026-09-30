import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoleBadge } from "../RoleBadge";

describe("RoleBadge", () => {
  it("renders the human-readable label for each role", () => {
    render(
      <>
        <RoleBadge role="founder" />
        <RoleBadge role="team_lead" />
        <RoleBadge role="team_member" />
      </>,
    );
    expect(screen.getByText("Founder")).toBeInTheDocument();
    expect(screen.getByText("Team Lead")).toBeInTheDocument();
    expect(screen.getByText("Team Member")).toBeInTheDocument();
  });

  it("uses role-specific styling classes", () => {
    const { rerender, container } = render(<RoleBadge role="founder" />);
    expect(container.firstChild?.className).toMatch(/emerald/);
    rerender(<RoleBadge role="team_lead" />);
    expect(container.firstChild?.className).toMatch(/amber/);
    rerender(<RoleBadge role="team_member" />);
    expect(container.firstChild?.className).toMatch(/slate/);
  });

  it("forwards a className override", () => {
    const { container } = render(<RoleBadge role="founder" className="custom-x" />);
    expect(container.firstChild?.className).toMatch(/custom-x/);
  });
});
