import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const changeLayerMock = vi.hoisted(() => vi.fn());
vi.mock("../api/memory", () => ({
  memoryApi: { changeLayer: changeLayerMock },
}));
vi.mock("../api/projects", () => ({
  projectsApi: {
    list: vi.fn(async () => [
      { id: "d-eng", type: "department", name: "Engineering", archivedAt: null, urlKey: "engineering" },
      { id: "d-mkt", type: "department", name: "Marketing", archivedAt: null, urlKey: "marketing" },
    ]),
  },
}));
vi.mock("../api/goals", () => ({
  goalsApi: {
    list: vi.fn(async () => [
      { id: "g-1", title: "Ship in EU", status: "active" },
      { id: "g-2", title: "Q3 OKRs", status: "active" },
    ]),
  },
}));
vi.mock("../api/issues", () => ({
  issuesApi: {
    list: vi.fn(async () => [
      { id: "t-1", title: "Fix login", identifier: "ENG-1", status: "in_progress" },
    ]),
  },
}));

// Mock shadcn Select to bypass Radix UI portal/pointer issues in jsdom.
// The items render directly and clicking them calls onValueChange.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange }: { children: React.ReactNode; value?: string; onValueChange?: (v: string) => void }) => (
    <div data-testid="select-root" data-value={value} data-onvaluechange={String(onValueChange)}>
      {/* Render children with a context hack via a wrapper div that exposes the handler */}
      <div
        data-testid="select-wrapper"
        onClick={(e) => {
          const target = e.target as HTMLElement;
          const itemValue = target.getAttribute("data-select-item-value");
          if (itemValue && onValueChange) onValueChange(itemValue);
        }}
      >
        {children}
      </div>
    </div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children, id, "aria-label": ariaLabel }: { children: React.ReactNode; id?: string; "aria-label"?: string }) => (
    <button type="button" id={id} aria-label={ariaLabel ?? "Layer"} role="combobox">{children}</button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder ?? ""}</span>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <div data-select-item-value={value} role="option" aria-selected={false}>
      {children}
    </div>
  ),
}));

import { ChangeLayerDialog } from "../components/memory/ChangeLayerDialog";
import type { MemoryItem } from "@armyofagents/shared";

function renderDialog(item: Partial<MemoryItem> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  const fullItem: MemoryItem = {
    id: "i-1",
    companyId: "co-1",
    title: "Test item",
    content: "Test content",
    category: "decision",
    source: "founder",
    status: "approved",
    tags: null,
    departmentId: "d-eng",
    projectId: null,
    createdBy: "u-1",
    layer: "domain",
    priority: 1,
    visibility: "public",
    expiresAt: null,
    goalId: null,
    taskId: null,
    sourceArtifactId: null,
    sourceContext: null,
    accessedAt: null,
    currentVersionId: null,
    embeddingRetries: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...item,
  };
  const utils = render(
    <QueryClientProvider client={qc}>
      <ChangeLayerDialog
        companyId="co-1"
        open={true}
        onOpenChange={onOpenChange}
        item={fullItem}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onOpenChange };
}

describe("ChangeLayerDialog", () => {
  beforeEach(() => {
    changeLayerMock.mockClear();
    changeLayerMock.mockResolvedValue({ id: "i-1", layer: "identity" });
  });

  it("renders the layer dropdown with 4 options", async () => {
    renderDialog();
    expect(screen.getByText(/Change layer/i)).toBeInTheDocument();
    // With mocked Select the items render inline
    await waitFor(() => {
      expect(screen.getByText(/Identity/i)).toBeInTheDocument();
      expect(screen.getByText(/Active Context/i)).toBeInTheDocument();
      expect(screen.getByText(/Working/i)).toBeInTheDocument();
    });
  });

  it("identity selection shows the permanent-layer warning", async () => {
    const user = userEvent.setup();
    renderDialog();
    // Click the Identity item directly (mocked Select renders items inline)
    await waitFor(() => expect(screen.getByText(/^Identity$/i)).toBeInTheDocument());
    await user.click(screen.getByText(/^Identity$/i));
    await waitFor(() =>
      expect(screen.getByText(/Permanent layer/i)).toBeInTheDocument(),
    );
  });

  it("calls changeLayer API with the selected fields", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog({ layer: "domain" });
    // Click Identity item to switch layer
    await waitFor(() => expect(screen.getByText(/^Identity$/i)).toBeInTheDocument());
    await user.click(screen.getByText(/^Identity$/i));
    // Submit
    const save = screen.getByRole("button", { name: /save/i });
    await user.click(save);
    await waitFor(() => expect(changeLayerMock).toHaveBeenCalled());
    expect(changeLayerMock).toHaveBeenCalledWith(
      "co-1",
      "i-1",
      expect.objectContaining({ newLayer: "identity" }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("active_context requires a goal — Save disabled until selected", async () => {
    const user = userEvent.setup();
    renderDialog({ layer: "domain" });
    // Click Active Context item
    await waitFor(() => expect(screen.getByText(/^Active Context$/i)).toBeInTheDocument());
    await user.click(screen.getByText(/^Active Context$/i));
    const save = screen.getByRole("button", { name: /save/i });
    expect(save).toBeDisabled();
  });
});
