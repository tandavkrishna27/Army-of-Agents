import { describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach } from "vitest";

import { ConfirmDialog } from "../components/ui/confirm-dialog";

afterEach(() => {
  cleanup();
});

describe("ConfirmDialog", () => {
  it("renders title and description when open", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete item?"
        description="This action cannot be undone."
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("Delete item?")).toBeInTheDocument();
    expect(screen.getByText("This action cannot be undone.")).toBeInTheDocument();
  });

  it("does not render content when closed", () => {
    render(
      <ConfirmDialog
        open={false}
        onOpenChange={vi.fn()}
        title="Delete item?"
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.queryByText("Delete item?")).not.toBeInTheDocument();
  });

  it("clicking Cancel calls onOpenChange(false)", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Confirm?"
        onConfirm={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("clicking Confirm invokes onConfirm", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Confirm?"
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("applies destructive styling when destructive=true (default)", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Destructive?"
        confirmLabel="Delete"
        onConfirm={vi.fn()}
      />,
    );
    const btn = screen.getByRole("button", { name: "Delete" });
    expect(btn.className).toMatch(/bg-error/);
  });

  it("omits destructive styling when destructive=false", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Non-destructive?"
        confirmLabel="OK"
        destructive={false}
        onConfirm={vi.fn()}
      />,
    );
    const btn = screen.getByRole("button", { name: "OK" });
    expect(btn.className).not.toMatch(/bg-error/);
  });

  it("disables buttons when disabled=true", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Working?"
        confirmLabel="Go"
        disabled
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Go" })).toBeDisabled();
  });
});
