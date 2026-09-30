import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const removeMock = vi.hoisted(() => vi.fn());
vi.mock("../api/memoryFolders", () => ({
  memoryFoldersApi: { remove: removeMock },
}));

import { DeleteFolderDialog } from "../components/memory/DeleteFolderDialog";

function renderDialog(folderProps: {
  childItemCount: number;
  childFolderCount: number;
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  const folder = {
    id: "f-q3",
    companyId: "co-1",
    departmentId: "d-eng",
    path: "engineering/Q3",
    displayName: "Q3 Planning",
    icon: "📂",
    seedKey: null,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const utils = render(
    <QueryClientProvider client={qc}>
      <DeleteFolderDialog
        companyId="co-1"
        open={true}
        onOpenChange={onOpenChange}
        folder={folder}
        parentDisplayPath="📁 Engineering"
        childItemCount={folderProps.childItemCount}
        childFolderCount={folderProps.childFolderCount}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onOpenChange };
}

describe("DeleteFolderDialog", () => {
  beforeEach(() => {
    removeMock.mockClear();
    removeMock.mockResolvedValue(undefined);
  });

  it("renders folder name in the title", () => {
    renderDialog({ childItemCount: 0, childFolderCount: 0 });
    expect(screen.getByText(/Q3 Planning/i)).toBeInTheDocument();
  });

  it("shows reparenting message when folder has items", () => {
    renderDialog({ childItemCount: 5, childFolderCount: 0 });
    expect(screen.getByText(/5 memory items/i)).toBeInTheDocument();
    expect(screen.getByText(/will be moved/i)).toBeInTheDocument();
  });

  it("shows simple confirm message when folder is empty", () => {
    renderDialog({ childItemCount: 0, childFolderCount: 0 });
    expect(screen.queryByText(/will be moved/i)).not.toBeInTheDocument();
  });

  it("calls remove API and closes dialog on confirm", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog({ childItemCount: 5, childFolderCount: 0 });
    const confirmBtn = screen.getByRole("button", { name: /^delete/i });
    await user.click(confirmBtn);
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("co-1", "f-q3"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
