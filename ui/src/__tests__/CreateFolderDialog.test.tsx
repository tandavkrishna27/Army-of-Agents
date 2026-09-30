import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const createMock = vi.hoisted(() => vi.fn());
vi.mock("../api/memoryFolders", () => ({
  memoryFoldersApi: {
    create: createMock,
  },
}));

import { CreateFolderDialog } from "../components/memory/CreateFolderDialog";

function renderDialog(props: {
  open: boolean;
  parentPath: string;
  parentDisplayPath?: string;
  parentDepartmentId: string | null;
  onOpenChange?: (open: boolean) => void;
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CreateFolderDialog
        companyId="co-1"
        open={props.open}
        onOpenChange={props.onOpenChange ?? vi.fn()}
        parentPath={props.parentPath}
        parentDisplayPath={props.parentDisplayPath ?? props.parentPath}
        parentDepartmentId={props.parentDepartmentId}
      />
    </QueryClientProvider>,
  );
}

describe("CreateFolderDialog", () => {
  beforeEach(() => {
    createMock.mockClear();
    createMock.mockResolvedValue({
      id: "f-new",
      path: "engineering/Q3 Planning",
      displayName: "Q3 Planning",
    });
  });

  it("renders parent path in the dialog", () => {
    renderDialog({
      open: true,
      parentPath: "engineering",
      parentDisplayPath: "Domain / Engineering",
      parentDepartmentId: "d-eng",
    });
    expect(screen.getByText(/Domain \/ Engineering/i)).toBeInTheDocument();
  });

  it("disables Create button when name is empty", () => {
    renderDialog({
      open: true,
      parentPath: "engineering",
      parentDepartmentId: "d-eng",
    });
    const create = screen.getByRole("button", { name: /create folder/i });
    expect(create).toBeDisabled();
  });

  it("calls memoryFoldersApi.create with derived slug + path", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog({
      open: true,
      parentPath: "engineering",
      parentDepartmentId: "d-eng",
      onOpenChange,
    });
    const input = screen.getByPlaceholderText(/folder name/i);
    await user.type(input, "Q3 Planning");
    const create = screen.getByRole("button", { name: /create folder/i });
    await user.click(create);
    await waitFor(() => expect(createMock).toHaveBeenCalled());
    expect(createMock).toHaveBeenCalledWith("co-1", expect.objectContaining({
      path: "engineering/q3-planning",
      displayName: "Q3 Planning",
      departmentId: "d-eng",
    }));
    // Dialog closes on success
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("shows the conflict error when API rejects with 409", async () => {
    createMock.mockRejectedValueOnce({
      status: 409,
      message: "A folder with this name already exists at this level",
    });
    const user = userEvent.setup();
    renderDialog({
      open: true,
      parentPath: "engineering",
      parentDepartmentId: "d-eng",
    });
    await user.type(screen.getByPlaceholderText(/folder name/i), "Decisions");
    await user.click(screen.getByRole("button", { name: /create folder/i }));
    await waitFor(() =>
      expect(screen.getByText(/already exists/i)).toBeInTheDocument(),
    );
  });
});
