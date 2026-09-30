import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserRole } from "@armyofagents/shared";
import { HomeBoardControls } from "../../components/home/HomeBoardControls";
import type { UseBoardEditResult } from "../../components/home/useBoardEdit";

/**
 * Focused unit tests for HomeBoardControls in isolation — a hand-built
 * UseBoardEditResult fixture, rather than the full HomeBoard harness (see
 * HomeBoard.test.tsx), since these assertions are only about the controls'
 * own rendering/gating, not the grid underneath.
 */
function makeBoardEdit(overrides: Partial<UseBoardEditResult> = {}): UseBoardEditResult {
  return {
    lg: [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }],
    editing: false,
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

async function openDropdown(overrides: Partial<UseBoardEditResult> = {}, role: UserRole | null = "founder") {
  const user = userEvent.setup();
  const boardEdit = makeBoardEdit(overrides);
  render(<HomeBoardControls boardEdit={boardEdit} role={role} />);
  await user.click(screen.getByRole("button", { name: "Customize board" }));
  return { user, boardEdit };
}

describe("HomeBoardControls (Plan 7 Task 3: customize dropdown, no header morph)", () => {
  it("renders an icon button labeled 'Customize board' when not editing", () => {
    render(<HomeBoardControls boardEdit={makeBoardEdit()} role="founder" />);

    expect(screen.getByRole("button", { name: "Customize board" })).toBeInTheDocument();
  });

  it("stays disabled below the lg breakpoint, with the same tooltip as before", () => {
    render(<HomeBoardControls boardEdit={makeBoardEdit({ activeBreakpoint: "md" })} role="founder" />);

    const button = screen.getByRole("button", { name: "Customize board" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Edit on a larger screen (1024px+)");
  });

  it("is enabled at the lg breakpoint and has no tooltip", () => {
    render(<HomeBoardControls boardEdit={makeBoardEdit({ activeBreakpoint: "lg" })} role="founder" />);

    const button = screen.getByRole("button", { name: "Customize board" });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("title");
  });

  it("stays disabled while a save is in flight, even at the lg breakpoint", () => {
    render(<HomeBoardControls boardEdit={makeBoardEdit({ isSaving: true })} role="founder" />);

    expect(screen.getByRole("button", { name: "Customize board" })).toBeDisabled();
  });

  // Plan 7 Task 3: the icon no longer morphs into a "Done" text button — Done
  // (and every other arrange-mode affordance) moved to the floating
  // ArrangeToolbar. The header icon just goes inert so it never reflows.
  describe("editing (arrange mode): the header icon is inert, not a 'Done' button", () => {
    it("renders the same disabled icon (no dropdown, no menu) — never a 'Done' text button", () => {
      render(<HomeBoardControls boardEdit={makeBoardEdit({ editing: true })} role="founder" />);

      const button = screen.getByRole("button", { name: "Customize board" });
      expect(button).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
      expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
    });

    it("clicking the inert icon does nothing (no startEdit/exitEdit call)", async () => {
      const user = userEvent.setup();
      const boardEdit = makeBoardEdit({ editing: true });
      render(<HomeBoardControls boardEdit={boardEdit} role="founder" />);

      // A disabled button still accepts a synthetic click in some browsers'
      // event models, but user-event respects `disabled` and won't dispatch
      // to it — assert the guarantee this component actually needs either way.
      await user.click(screen.getByRole("button", { name: "Customize board" }));

      expect(boardEdit.startEdit).not.toHaveBeenCalled();
      expect(boardEdit.exitEdit).not.toHaveBeenCalled();
    });

    it("renders identical markup whether or not a save is in flight — no header shift between arrange-mode states", () => {
      const { rerender } = render(
        <HomeBoardControls boardEdit={makeBoardEdit({ editing: true, isSaving: false })} role="founder" />,
      );
      const idleMarkup = screen.getByRole("button", { name: "Customize board" }).outerHTML;

      rerender(<HomeBoardControls boardEdit={makeBoardEdit({ editing: true, isSaving: true })} role="founder" />);
      const savingMarkup = screen.getByRole("button", { name: "Customize board" }).outerHTML;

      expect(savingMarkup).toBe(idleMarkup);
    });
  });

  describe("the customize dropdown (not editing)", () => {
    it("opens on click and shows all three items, including the Add widget sub-trigger (not that its sub-content opens — P2-1)", async () => {
      await openDropdown();

      expect(await screen.findByRole("menuitem", { name: "Rearrange tiles" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Add widget" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Reset to default" })).toBeInTheDocument();
    });

    it("selecting Rearrange tiles calls startEdit", async () => {
      const { user, boardEdit } = await openDropdown();

      await user.click(await screen.findByRole("menuitem", { name: "Rearrange tiles" }));

      expect(boardEdit.startEdit).toHaveBeenCalledTimes(1);
    });

    it("selecting Reset to default shows a confirm dialog rather than resetting immediately", async () => {
      const { user, boardEdit } = await openDropdown();

      await user.click(await screen.findByRole("menuitem", { name: "Reset to default" }));

      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
      expect(boardEdit.resetBoard).not.toHaveBeenCalled();
    });

    it("confirming the Reset dialog calls resetBoard and closes the dialog", async () => {
      const { user, boardEdit } = await openDropdown();
      await user.click(await screen.findByRole("menuitem", { name: "Reset to default" }));
      await screen.findByRole("alertdialog");

      await user.click(screen.getByRole("button", { name: "Reset" }));

      expect(boardEdit.resetBoard).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("cancelling the Reset dialog never calls resetBoard", async () => {
      const { user, boardEdit } = await openDropdown();
      await user.click(await screen.findByRole("menuitem", { name: "Reset to default" }));
      await screen.findByRole("alertdialog");

      await user.click(screen.getByRole("button", { name: "Cancel" }));

      expect(boardEdit.resetBoard).not.toHaveBeenCalled();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("surfaces a failed view-mode reset inline with a Retry that re-fires resetBoard (Codex P2)", async () => {
      const user = userEvent.setup();
      const boardEdit = makeBoardEdit({ resetError: new Error("network down") });
      render(<HomeBoardControls boardEdit={boardEdit} role="founder" />);

      expect(screen.getByText(/Couldn't reset your board/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Retry" }));
      expect(boardEdit.resetBoard).toHaveBeenCalledTimes(1);
    });

    it("does not show the reset error inline while editing (ArrangeToolbar owns it there)", () => {
      render(
        <HomeBoardControls boardEdit={makeBoardEdit({ editing: true, resetError: new Error("x") })} role="founder" />,
      );
      expect(screen.queryByText(/Couldn't reset your board/)).not.toBeInTheDocument();
    });
  });
});
