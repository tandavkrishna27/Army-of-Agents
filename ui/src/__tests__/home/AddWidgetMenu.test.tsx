import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddWidgetMenu } from "../../components/home/AddWidgetMenu";

// Plan 7 Task 3 (P2-1): tested STANDALONE with plain props — never driven
// through the real Radix submenu that embeds it in HomeBoardControls/
// ArrangeToolbar, since DropdownMenuSubContent opens on pointer-hover with an
// internal timer jsdom/userEvent fire unreliably (the InputAddMenu precedent
// is a FLAT menu, not a submenu — it does not prove submenu opening).
describe("AddWidgetMenu", () => {
  it("lists every registered widget (incl. founder-only ones) when the board is empty and the viewer is a founder", () => {
    render(<AddWidgetMenu boardKeys={[]} role="founder" onAdd={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Action queue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Suggestions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Objectives" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Today's activity" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agents working now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Budget" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Waiting on you" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "My tasks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discussions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Memory review" })).toBeInTheDocument();
  });

  it("excludes widgets already on the board (boardKeys)", () => {
    render(<AddWidgetMenu boardKeys={["budget", "agents-now"]} role="founder" onAdd={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Budget" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Agents working now" })).not.toBeInTheDocument();
    // The others are still offered.
    expect(screen.getByRole("button", { name: "Objectives" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "My tasks" })).toBeInTheDocument();
  });

  // Plan 7 Task 3: "real fix for the dead flag" — requiresFounder is now
  // actually enforced here (it was previously read nowhere).
  describe("requiresFounder filtering (memory-review)", () => {
    it("hides a requiresFounder widget when the viewer is a team_member", () => {
      render(<AddWidgetMenu boardKeys={[]} role="team_member" onAdd={vi.fn()} />);

      expect(screen.queryByRole("button", { name: "Memory review" })).not.toBeInTheDocument();
      // Non-founder-only widgets are unaffected.
      expect(screen.getByRole("button", { name: "Budget" })).toBeInTheDocument();
    });

    it("shows a requiresFounder widget when the viewer is a founder", () => {
      render(<AddWidgetMenu boardKeys={[]} role="founder" onAdd={vi.fn()} />);

      expect(screen.getByRole("button", { name: "Memory review" })).toBeInTheDocument();
    });

    // P3-2: match getDefaultLayout's own predicate — founder/team_lead/null
    // all get the founder board, so all may add its founder-tier widgets;
    // only team_member is restricted.
    it("shows a requiresFounder widget when role is team_lead or null (only team_member is restricted)", () => {
      const { rerender } = render(<AddWidgetMenu boardKeys={[]} role="team_lead" onAdd={vi.fn()} />);
      expect(screen.getByRole("button", { name: "Memory review" })).toBeInTheDocument();

      rerender(<AddWidgetMenu boardKeys={[]} role={null} onAdd={vi.fn()} />);
      expect(screen.getByRole("button", { name: "Memory review" })).toBeInTheDocument();
    });
  });

  it("clicking a row calls onAdd with that widget's key", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<AddWidgetMenu boardKeys={[]} role="founder" onAdd={onAdd} />);

    await user.click(screen.getByRole("button", { name: "Objectives" }));

    expect(onAdd).toHaveBeenCalledWith("objectives");
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("shows an empty message when every widget is already on the board", () => {
    const allKeys = [
      "action-queue",
      "suggestions",
      "objectives",
      "activity-feed",
      "agents-now",
      "budget",
      "approvals",
      "my-tasks",
      "discussions",
      "memory-review",
    ] as const;
    render(<AddWidgetMenu boardKeys={allKeys} role="founder" onAdd={vi.fn()} />);

    expect(screen.getByText(/already on your board/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Budget" })).not.toBeInTheDocument();
  });

  it("shows the empty message (not a founder-only widget) when every non-founder widget is on the board and the viewer is a team_member", () => {
    const nonFounderKeys = [
      "action-queue",
      "suggestions",
      "objectives",
      "activity-feed",
      "agents-now",
      "budget",
      "approvals",
      "my-tasks",
      "discussions",
    ] as const;
    render(<AddWidgetMenu boardKeys={nonFounderKeys} role="team_member" onAdd={vi.fn()} />);

    // memory-review is the only widget left off the board, but it's
    // requiresFounder and this viewer is a team_member — nothing is offered.
    expect(screen.getByText(/already on your board/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Memory review" })).not.toBeInTheDocument();
  });
});
