import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { uploadMock, projectsListMock } = vi.hoisted(() => ({
  uploadMock: vi.fn(async () => ({ asset: { id: "a-1", fileName: "x.pdf" }, jobId: "j-1" })),
  projectsListMock: vi.fn(async () => [
    { id: "dept-1", urlKey: "engineering", name: "Engineering", type: "department" },
  ]),
}));

vi.mock("../api/memoryAssets", () => ({
  memoryAssetsApi: {
    upload: uploadMock,
    list: vi.fn(async () => []),
    contentUrl: () => "/test",
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    list: projectsListMock,
  },
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

import { MemoryUploadButton } from "../components/memory/MemoryUploadButton";

function renderButton(props?: Partial<React.ComponentProps<typeof MemoryUploadButton>>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryUploadButton
        companyId="co-1"
        departmentId="dept-1"
        folderPath="Engineering/Files"
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("MemoryUploadButton (Phase 6.1c)", () => {
  beforeEach(() => {
    uploadMock.mockClear();
    projectsListMock.mockClear();
  });

  it("renders an Upload button", () => {
    renderButton();
    expect(screen.getByRole("button", { name: /upload/i })).toBeInTheDocument();
  });

  it("calls upload on file selection (sub-folder mode passes folderPath verbatim)", async () => {
    const user = userEvent.setup();
    renderButton();
    const file = new File(["hi"], "x.pdf", { type: "application/pdf" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    await user.upload(input, file);
    await waitFor(() =>
      expect(uploadMock).toHaveBeenCalledWith("co-1", file, {
        departmentId: "dept-1",
        folderPath: "Engineering/Files",
      }),
    );
  });

  // Codex P1 regression: in dept-only mode (folderPath="", departmentId set),
  // the upload must land at <deptSlug>, not "". Otherwise the strict-path
  // listing filter in MemoryFileList (assetsFolderPath === deptSlug) hides
  // the freshly uploaded file.
  it("dept-root mode: sends deptSlug as folderPath (not empty)", async () => {
    const user = userEvent.setup();
    renderButton({ folderPath: "", departmentId: "dept-1" });
    // Wait for projects query to resolve so the slug is available.
    await waitFor(() => expect(projectsListMock).toHaveBeenCalled());
    const file = new File(["hi"], "x.pdf", { type: "application/pdf" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);
    await waitFor(() =>
      expect(uploadMock).toHaveBeenCalledWith("co-1", file, {
        departmentId: "dept-1",
        folderPath: "engineering",
      }),
    );
  });

  it("top-level mode (no dept, no folder): sends folderPath=undefined", async () => {
    const user = userEvent.setup();
    renderButton({ folderPath: "", departmentId: null });
    const file = new File(["hi"], "x.pdf", { type: "application/pdf" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);
    await waitFor(() =>
      expect(uploadMock).toHaveBeenCalledWith("co-1", file, {
        departmentId: undefined,
        folderPath: undefined,
      }),
    );
    // Projects query should not have fired in this mode.
    expect(projectsListMock).not.toHaveBeenCalled();
  });
});
