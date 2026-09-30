import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThreadRoster, type ParticipantRow } from "../ThreadRoster";

function row(overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    principalType: "user",
    principalId: "u-1",
    name: "Maria",
    role: "owner",
    addedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("ThreadRoster", () => {
  it("returns null when participants list is empty", () => {
    const { container } = render(<ThreadRoster participants={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the roster wrapper with data-testid when participants are present", () => {
    render(<ThreadRoster participants={[row()]} />);
    expect(screen.getByTestId("thread-roster")).toBeInTheDocument();
  });

  it("renders participant count in the header", () => {
    render(
      <ThreadRoster
        participants={[
          row({ principalId: "u-1", name: "Maria", role: "owner" }),
          row({ principalId: "u-2", name: "Jose", role: "collaborator" }),
        ]}
      />,
    );
    expect(screen.getByText(/participants \(2\)/i)).toBeInTheDocument();
  });

  it("renders each participant's name, role, and principalType", () => {
    render(
      <ThreadRoster
        participants={[
          row({ principalId: "u-1", name: "Maria", role: "owner", principalType: "user" }),
          row({
            principalId: "agent-1",
            name: "Adjutant",
            role: "worker",
            principalType: "agent",
          }),
        ]}
      />,
    );
    expect(screen.getByText("Maria")).toBeInTheDocument();
    expect(screen.getByText("Adjutant")).toBeInTheDocument();
    expect(screen.getByText("(owner)")).toBeInTheDocument();
    expect(screen.getByText("(worker)")).toBeInTheDocument();
    // principalType pill renders both 'user' and 'agent'
    const rows = screen.getAllByTestId("thread-roster-row");
    expect(rows).toHaveLength(2);
  });

  it("uses a stable composite key per row (no React key warnings)", () => {
    // Two participants share the same id across different principal types —
    // the composite key (principalType + principalId) must keep them unique.
    render(
      <ThreadRoster
        participants={[
          row({ principalType: "user", principalId: "same", name: "Human" }),
          row({ principalType: "agent", principalId: "same", name: "Agent" }),
        ]}
      />,
    );
    const rows = screen.getAllByTestId("thread-roster-row");
    expect(rows).toHaveLength(2);
  });
});
