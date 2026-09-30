import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { createMock, projectsListMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  projectsListMock: vi.fn(),
}));

vi.mock("../../../api/memory", () => ({
  memoryApi: { create: (...a: unknown[]) => createMock(...a) },
}));

vi.mock("../../../api/projects", () => ({
  projectsApi: { list: (...a: unknown[]) => projectsListMock(...a) },
}));

import { NewMemoryItemDialog } from "../NewMemoryItemDialog";

function renderWithProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("NewMemoryItemDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectsListMock.mockResolvedValue([
      { id: "dept-1", name: "Engineering", type: "department" },
      { id: "dept-2", name: "Marketing", type: "department" },
    ]);
    createMock.mockResolvedValue({ id: "new-mem-1" });
  });

  it("does not render when open is false", () => {
    const { queryByText } = renderWithProviders(
      <NewMemoryItemDialog open={false} onOpenChange={() => {}} companyId="co-1" />,
    );
    expect(queryByText("Add to Memory")).toBeNull();
  });

  it("renders title and form fields when open", () => {
    const { getByText, getByLabelText } = renderWithProviders(
      <NewMemoryItemDialog open={true} onOpenChange={() => {}} companyId="co-1" />,
    );
    expect(getByText("Add to Memory")).toBeInTheDocument();
    expect(getByLabelText(/^Title/i)).toBeInTheDocument();
    expect(getByLabelText(/^Content/i)).toBeInTheDocument();
  });

  it("disables Create when title or content is empty", () => {
    const { getByRole } = renderWithProviders(
      <NewMemoryItemDialog open={true} onOpenChange={() => {}} companyId="co-1" />,
    );
    const create = getByRole("button", { name: /^create/i });
    expect(create).toBeDisabled();
  });

  it("submits with title, content, layer, category and closes the dialog on success", async () => {
    const onOpenChange = vi.fn();
    const { getByLabelText, getByRole } = renderWithProviders(
      <NewMemoryItemDialog open={true} onOpenChange={onOpenChange} companyId="co-1" />,
    );
    fireEvent.change(getByLabelText(/^Title/i), { target: { value: "Brand voice" } });
    fireEvent.change(getByLabelText(/^Content/i), { target: { value: "Direct, terse, evidence-driven." } });
    fireEvent.click(getByRole("button", { name: /^create/i }));
    await waitFor(() => expect(createMock).toHaveBeenCalled());
    const arg = (createMock.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(arg.title).toBe("Brand voice");
    expect(arg.content).toBe("Direct, terse, evidence-driven.");
    expect(typeof arg.layer).toBe("string");
    expect(typeof arg.category).toBe("string");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
