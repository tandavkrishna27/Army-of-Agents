import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArrangeToolbar } from "../../components/home/ArrangeToolbar";
import type { UseBoardEditResult } from "../../components/home/useBoardEdit";

/**
 * Focused unit tests for ArrangeToolbar in isolation — a hand-built
 * UseBoardEditResult fixture (mirrors HomeBoardControls.test.tsx's own
 * pattern), rather than the full HomeBoard harness. HomeBoard.test.tsx covers
 * the toolbar mounted/gated for real inside the grid.
 */
function makeBoardEdit(overrides: Partial<UseBoardEditResult> = {}): UseBoardEditResult {
  return {
    lg: [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }],
    editing: true,
    dirty: false,
    isSaving: false,
    isResetting: false,
    saveError: null,
    resetError: null,
    activeBreakpoint: "lg",
    announcement: "",
    startEdit: vi.fn(),
    exitEdit: vi.fn(),
    retrySave: vi.fn(),
    removeWidget: vi.fn(),
    addWidget: vi.fn(),
    addWidgetAndEdit: vi.fn(),
    resetBoard: vi.fn(),
    onLayoutChange: vi.fn(),
    onBreakpointChange: vi.fn(),
    onResizeStop: vi.fn(),
    moveWidget: vi.fn(),
    cycleWidgetSize: vi.fn(),
    ...overrides,
  };
}

describe("ArrangeToolbar (Plan 7 Task 3: floating arrange-mode toolbar)", () => {
  it("is a labeled toolbar with Add widget, Reset, and Done", () => {
    render(<ArrangeToolbar boardEdit={makeBoardEdit()} role="founder" />);

    expect(screen.getByRole("toolbar", { name: "Arrange board" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add widget" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("clicking Done calls exitEdit", async () => {
    const user = userEvent.setup();
    const boardEdit = makeBoardEdit();
    render(<ArrangeToolbar boardEdit={boardEdit} role="founder" />);

    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(boardEdit.exitEdit).toHaveBeenCalledTimes(1);
  });

  it("disables Done while a save is in flight", () => {
    render(<ArrangeToolbar boardEdit={makeBoardEdit({ isSaving: true })} role="founder" />);

    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
  });

  it("clicking Reset calls resetBoard directly — no confirm here (unlike the view-mode dropdown's Reset to default)", async () => {
    const user = userEvent.setup();
    const boardEdit = makeBoardEdit();
    render(<ArrangeToolbar boardEdit={boardEdit} role="founder" />);

    await user.click(screen.getByRole("button", { name: "Reset" }));

    expect(boardEdit.resetBoard).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("disables Reset while a reset is already in flight", () => {
    render(<ArrangeToolbar boardEdit={makeBoardEdit({ isResetting: true })} role="founder" />);

    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
  });

  // Coordinator follow-up fix: an earlier version gated the toolbar's own
  // MOUNT on editableNow, which took Done away entirely below lg / mid-save
  // — stranding the founder with no way to exit edit mode. Done is now
  // reachable at any breakpoint/save-state (disabled only while isSaving, to
  // avoid a double-click); only Add widget/Reset mirror the tiles' own
  // editableNow gate (disabled, not unmounted).
  describe("editableNow gating (below lg / mid-save): Add widget and Reset disable, Done does not", () => {
    it("disables Add widget and Reset below the lg breakpoint, while Done stays present and enabled", () => {
      render(<ArrangeToolbar boardEdit={makeBoardEdit({ activeBreakpoint: "md" })} role="founder" />);

      expect(screen.getByRole("button", { name: "Add widget" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
    });

    it("disables Add widget and Reset while a save is in flight, while Done stays present (just disabled to avoid a double-click)", () => {
      render(<ArrangeToolbar boardEdit={makeBoardEdit({ isSaving: true })} role="founder" />);

      expect(screen.getByRole("button", { name: "Add widget" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
      // Still present — disabled for a different reason (see the "disables
      // Done while a save is in flight" test above) than Add widget/Reset.
      expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
    });

    it("enables Add widget and Reset again once back at lg and not saving", () => {
      render(<ArrangeToolbar boardEdit={makeBoardEdit({ activeBreakpoint: "lg", isSaving: false })} role="founder" />);

      expect(screen.getByRole("button", { name: "Add widget" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
    });
  });

  describe("status states", () => {
    it("renders nothing extra when not dirty and not saving", () => {
      render(<ArrangeToolbar boardEdit={makeBoardEdit()} role="founder" />);

      expect(screen.queryByText("Saving…")).not.toBeInTheDocument();
      expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    });

    it("renders 'Unsaved changes' when dirty and not saving", () => {
      render(<ArrangeToolbar boardEdit={makeBoardEdit({ dirty: true })} role="founder" />);

      expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    });

    it("renders 'Saving…' while a save is in flight", () => {
      render(<ArrangeToolbar boardEdit={makeBoardEdit({ dirty: true, isSaving: true })} role="founder" />);

      expect(screen.getByText("Saving…")).toBeInTheDocument();
      expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    });

    it("renders a save error with Retry, taking priority over the reset error", async () => {
      const user = userEvent.setup();
      const boardEdit = makeBoardEdit({
        dirty: true,
        saveError: new Error("network down"),
        resetError: new Error("delete failed"),
      });
      render(<ArrangeToolbar boardEdit={boardEdit} role="founder" />);

      expect(screen.getByText(/Couldn't save/)).toBeInTheDocument();
      expect(screen.queryByText(/Couldn't reset/)).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Retry" }));
      expect(boardEdit.retrySave).toHaveBeenCalledTimes(1);
    });

    it("renders a reset error with its own Retry when there is no save error", async () => {
      const user = userEvent.setup();
      const boardEdit = makeBoardEdit({ resetError: new Error("delete failed") });
      render(<ArrangeToolbar boardEdit={boardEdit} role="founder" />);

      expect(screen.getByText(/Couldn't reset/)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Retry" }));
      expect(boardEdit.resetBoard).toHaveBeenCalledTimes(1);
    });
  });

  describe("add-widget entry", () => {
    it("opens the Add widget menu and clicking a row calls addWidget (not addWidgetAndEdit — already editing)", async () => {
      const user = userEvent.setup();
      const boardEdit = makeBoardEdit({ lg: [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }] });
      render(<ArrangeToolbar boardEdit={boardEdit} role="founder" />);

      await user.click(screen.getByRole("button", { name: "Add widget" }));
      const menu = await screen.findByRole("menu", { name: "Add widget" });
      await user.click(within(menu).getByRole("button", { name: "Objectives" }));

      expect(boardEdit.addWidget).toHaveBeenCalledWith("objectives");
      expect(boardEdit.addWidgetAndEdit).not.toHaveBeenCalled();
    });

    it("excludes on-board widgets and hides requiresFounder widgets for a team_member", async () => {
      const user = userEvent.setup();
      const boardEdit = makeBoardEdit({ lg: [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }] });
      render(<ArrangeToolbar boardEdit={boardEdit} role="team_member" />);

      await user.click(screen.getByRole("button", { name: "Add widget" }));
      const menu = await screen.findByRole("menu", { name: "Add widget" });

      expect(within(menu).queryByRole("button", { name: "Budget" })).not.toBeInTheDocument();
      expect(within(menu).queryByRole("button", { name: "Memory review" })).not.toBeInTheDocument();
      expect(within(menu).getByRole("button", { name: "Objectives" })).toBeInTheDocument();
    });
  });
});
