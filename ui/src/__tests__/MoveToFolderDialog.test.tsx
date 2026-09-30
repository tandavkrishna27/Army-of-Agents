import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  moveMock: vi.fn(async () => ({ id: "i-1", folderPath: "engineering/Decisions" })),
}));

vi.mock("../api/memoryFolders", () => ({
  memoryFoldersApi: {
    list: vi.fn(async () => [
      { id: "f1", path: "engineering/Decisions", displayName: "Decisions" },
      { id: "f2", path: "engineering/Files", displayName: "Files" },
    ]),
  },
}));

vi.mock("../api/memory", () => ({
  memoryApi: {
    moveItem: mocks.moveMock,
  },
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

import { MoveToFolderDialog } from "../components/memory/MoveToFolderDialog";

function renderDialog(props?: Partial<React.ComponentProps<typeof MoveToFolderDialog>>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MoveToFolderDialog
        open
        onOpenChange={vi.fn()}
        companyId="co-1"
        itemId="i-1"
        currentFolderPath="engineering/Files"
        currentDepartmentId="dept-eng"
        onMoved={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("MoveToFolderDialog (Phase 6.1b)", () => {
  beforeEach(() => mocks.moveMock.mockClear());

  it("lists available folders", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText("Decisions")).toBeInTheDocument());
    expect(screen.getByText("Files")).toBeInTheDocument();
  });

  it("Move button is disabled while target equals current folder", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText("Decisions")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^move$/i })).toBeDisabled();
  });

  it("clicking a different folder enables Move and dispatches the mutation", async () => {
    const user = userEvent.setup();
    const onMoved = vi.fn();
    renderDialog({ onMoved });
    await waitFor(() => expect(screen.getByText("Decisions")).toBeInTheDocument());
    await user.click(screen.getByText("Decisions"));
    const moveBtn = screen.getByRole("button", { name: /^move$/i });
    expect(moveBtn).not.toBeDisabled();
    await user.click(moveBtn);
    await waitFor(() => expect(mocks.moveMock).toHaveBeenCalledWith("co-1", "i-1", "engineering/Decisions"));
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
  });
});
