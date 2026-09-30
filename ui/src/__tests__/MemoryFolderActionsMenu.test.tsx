import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryFolderActionsMenu } from "../components/memory/MemoryFolderActionsMenu";

describe("MemoryFolderActionsMenu", () => {
  it("user folder shows New / Rename / Change icon / Delete", async () => {
    const user = userEvent.setup();
    render(
      <MemoryFolderActionsMenu
        nodeKind="userFolder"
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onChangeIcon={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /folder actions/i }));
    expect(screen.getByText(/new subfolder/i)).toBeInTheDocument();
    expect(screen.getByText(/rename/i)).toBeInTheDocument();
    expect(screen.getByText(/change icon/i)).toBeInTheDocument();
    expect(screen.getByText(/delete/i)).toBeInTheDocument();
  });

  it("seeded folder shows only New subfolder", async () => {
    const user = userEvent.setup();
    render(
      <MemoryFolderActionsMenu
        nodeKind="seededFolder"
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onChangeIcon={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /folder actions/i }));
    expect(screen.getByText(/new subfolder/i)).toBeInTheDocument();
    expect(screen.queryByText(/^rename$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^delete$/i)).not.toBeInTheDocument();
  });

  it("scope (dept) shows only New subfolder", async () => {
    const user = userEvent.setup();
    render(
      <MemoryFolderActionsMenu
        nodeKind="scope"
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onChangeIcon={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /folder actions/i }));
    expect(screen.getByText(/new subfolder/i)).toBeInTheDocument();
    expect(screen.queryByText(/^delete$/i)).not.toBeInTheDocument();
  });

  it("calls onCreate when 'New subfolder' clicked", async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryFolderActionsMenu
        nodeKind="userFolder"
        onCreate={onCreate}
        onRename={vi.fn()}
        onChangeIcon={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /folder actions/i }));
    await user.click(screen.getByText(/new subfolder/i));
    expect(onCreate).toHaveBeenCalled();
  });

  it("calls onDelete when 'Delete' clicked on user folder", async () => {
    const onDelete = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryFolderActionsMenu
        nodeKind="userFolder"
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onChangeIcon={vi.fn()}
        onDelete={onDelete}
      />,
    );
    await user.click(screen.getByRole("button", { name: /folder actions/i }));
    await user.click(screen.getByText(/^delete$/i));
    expect(onDelete).toHaveBeenCalled();
  });
});
