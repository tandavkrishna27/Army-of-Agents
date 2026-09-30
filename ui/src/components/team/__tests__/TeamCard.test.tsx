import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TeamCard } from "../TeamCard";

const SAMPLE_TEAM = {
  id: "t1",
  name: "Frontend Team",
  slug: "frontend-team",
  parentProjectName: "Engineering",
  status: "active" as const,
  memberCount: 3,
  leadName: "alice",
};

describe("TeamCard", () => {
  it("renders team name", () => {
    render(<TeamCard team={SAMPLE_TEAM} onClick={() => {}} />);
    expect(screen.getByText("Frontend Team")).toBeInTheDocument();
  });

  it("renders parent dept tag", () => {
    render(<TeamCard team={SAMPLE_TEAM} onClick={() => {}} />);
    // CSS uppercase handles visual transform; DOM text remains case-preserving
    // for screen readers (which read all-caps as initialisms letter-by-letter).
    expect(screen.getByText(/engineering/i)).toBeInTheDocument();
  });

  it("exposes role=button on the card root for a11y", () => {
    render(<TeamCard team={SAMPLE_TEAM} onClick={() => {}} />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("renders lead with star marker", () => {
    render(<TeamCard team={SAMPLE_TEAM} onClick={() => {}} />);
    // Lead name appears alongside a star icon
    expect(screen.getByText("alice")).toBeInTheDocument();
  });

  it("renders member count", () => {
    // Avatar stack + overflow badge: 2 visible initials, memberCount=3 → "+1" overflow shown
    render(<TeamCard team={{ ...SAMPLE_TEAM, memberInitials: ["A", "B"] }} onClick={() => {}} />);
    expect(screen.getByText("+1")).toBeInTheDocument();
  });

  it("does NOT render any human-style avatar", () => {
    render(<TeamCard team={SAMPLE_TEAM} onClick={() => {}} />);
    // No img elements
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("calls onClick when card is clicked", () => {
    const handleClick = vi.fn();
    render(<TeamCard team={SAMPLE_TEAM} onClick={handleClick} />);
    screen.getByText("Frontend Team").click();
    // Click should propagate to the card
    expect(handleClick).toHaveBeenCalled();
  });
});
