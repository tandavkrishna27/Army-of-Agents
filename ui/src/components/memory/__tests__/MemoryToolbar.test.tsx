import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const { navigateMock, listMock, listPendingMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  listMock: vi.fn(),
  listPendingMock: vi.fn(),
}));

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/router");
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "ACME" } }),
}));

vi.mock("../../../api/memory", () => ({
  memoryApi: {
    list: (...a: unknown[]) => listMock(...a),
    listPending: (...a: unknown[]) => listPendingMock(...a),
  },
}));

// Stub the upload button to avoid pulling its full dependency tree.
vi.mock("../MemoryUploadButton", () => ({
  MemoryUploadButton: (props: { folderPath: string; departmentId: string | null }) => (
    <button data-testid="upload-stub" data-folder={props.folderPath} data-dept={props.departmentId ?? ""}>upload</button>
  ),
}));

import { MemoryToolbar } from "../MemoryToolbar";

function renderWithProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MemoryToolbar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue({ items: [{ id: "1" }, { id: "2" }, { id: "3" }], semanticAvailable: true });
    listPendingMock.mockResolvedValue({ totalCount: 0, items: [] });
  });

  it("renders title and total count", async () => {
    const { findByText } = renderWithProviders(
      <MemoryToolbar companyId="co-1" searchValue="" onSearchChange={() => {}} onNewItem={() => {}} />,
    );
    expect(await findByText("Memory")).toBeInTheDocument();
    expect(await findByText(/3 items/)).toBeInTheDocument();
  });

  it("calls onSearchChange when typing", async () => {
    const onSearchChange = vi.fn();
    const { findByLabelText } = renderWithProviders(
      <MemoryToolbar companyId="co-1" searchValue="" onSearchChange={onSearchChange} onNewItem={() => {}} />,
    );
    const input = (await findByLabelText("Search this folder")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "foo" } });
    expect(onSearchChange).toHaveBeenCalledWith("foo");
  });

  it("calls onNewItem when New item is clicked", async () => {
    const onNewItem = vi.fn();
    const { findByText } = renderWithProviders(
      <MemoryToolbar companyId="co-1" searchValue="" onSearchChange={() => {}} onNewItem={onNewItem} />,
    );
    fireEvent.click(await findByText("New item"));
    expect(onNewItem).toHaveBeenCalledTimes(1);
  });

  it("renders the upload stub when uploadContext is provided", async () => {
    const { findByTestId } = renderWithProviders(
      <MemoryToolbar
        companyId="co-1"
        searchValue=""
        onSearchChange={() => {}}
        onNewItem={() => {}}
        uploadContext={{ departmentId: null, folderPath: "Engineering/specs" }}
      />,
    );
    const upload = await findByTestId("upload-stub");
    expect(upload.dataset.folder).toBe("Engineering/specs");
  });

  it("hides the upload stub when uploadContext is undefined", async () => {
    const { container, findByText } = renderWithProviders(
      <MemoryToolbar companyId="co-1" searchValue="" onSearchChange={() => {}} onNewItem={() => {}} />,
    );
    await findByText("Memory");
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="upload-stub"]')).toBeNull();
  });
});
