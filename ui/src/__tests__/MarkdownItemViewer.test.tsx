// ui/src/__tests__/MarkdownItemViewer.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Stub @uiw/react-md-editor for jsdom — the real editor uses ESM-only code that
// won't run in jsdom; a simple textarea stub is sufficient for interaction tests.
vi.mock("@uiw/react-md-editor", () => ({
  default: ({ value, onChange }: any) => (
    <textarea
      data-testid="md-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

// Use vi.hoisted so updateMock is defined before the factory is executed
const mocks = vi.hoisted(() => ({
  updateMock: vi.fn(async () => ({})),
  getMock: vi.fn(async () => ({
    id: "i-1",
    title: "Auth strategy",
    content: "# Hi\n\nReal content here.",
    status: "approved",
    category: "decision",
    layer: "domain",
    pinnedToSkill: false,
  })),
  neighborsMock: vi.fn(async () => ({
    center: {
      type: "memory_item",
      id: "i-1",
      companyId: "co-1",
      label: "Auth strategy",
    },
    nodes: [
      {
        type: "memory_item",
        id: "i-1",
        companyId: "co-1",
        label: "Auth strategy",
      },
      {
        type: "memory_item",
        id: "i-2",
        companyId: "co-1",
        label: "Pricing policy",
        subtitle: "decision",
      },
    ],
    edges: [
      {
        id: "rel-1",
        companyId: "co-1",
        from: { type: "memory_item", id: "i-2" },
        to: { type: "memory_item", id: "i-1" },
        kind: "related_to",
        sourceClass: "semantic",
        editability: "editable",
      },
    ],
  })),
}));

vi.mock("../api/memory", () => ({
  memoryApi: {
    get: mocks.getMock,
    neighbors: mocks.neighborsMock,
    update: mocks.updateMock,
    approve: vi.fn(),
    reject: vi.fn(),
  },
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

import { MarkdownItemViewer } from "../components/memory/viewers/MarkdownItemViewer";

function renderViewer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MarkdownItemViewer companyId="co-1" itemId="i-1" />
    </QueryClientProvider>,
  );
}

describe("MarkdownItemViewer (Phase 6.1b)", () => {
  beforeEach(() => {
    mocks.updateMock.mockClear();
    mocks.neighborsMock.mockClear();
  });

  it("approved items default to preview mode", async () => {
    renderViewer();
    await waitFor(() => expect(screen.getByText("Auth strategy")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /preview/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
  });

  it("clicking Edit toggles to editor mode", async () => {
    const user = userEvent.setup();
    renderViewer();
    await waitFor(() => expect(screen.getByText("Auth strategy")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /edit/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^save$/i })).toBeInTheDocument(),
    );
  });

  it("pending items show Approve and Reject buttons", async () => {
    const memory = await import("../api/memory");
    vi.mocked(memory.memoryApi.get).mockResolvedValueOnce({
      id: "i-1",
      title: "Pending item",
      content: "Pending content",
      status: "pending",
      category: "decision",
      layer: "domain",
      pinnedToSkill: false,
    } as never);
    renderViewer();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /reject/i })).toBeInTheDocument();
  });

  it("renders a backlinks wedge from graph neighbors", async () => {
    renderViewer();
    await waitFor(() => expect(screen.getByText("Auth strategy")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Backlinks")).toBeInTheDocument());
    expect(screen.getByText("Pricing policy")).toBeInTheDocument();
    expect(mocks.neighborsMock).toHaveBeenCalledWith("co-1", "i-1", {
      depth: 1,
      kinds: ["applies_to", "related_to", "supports", "conflicts_with", "supersedes", "duplicate_of"],
    });
  });
});
