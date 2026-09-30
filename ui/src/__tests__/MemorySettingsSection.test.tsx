import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LLMProvidersSection } from "@/components/LLMProvidersSection";

const CID = "co-1";

// ─── Mutable test state ───────────────────────────────────────────────
let mockRole: "founder" | "team_lead" | "team_member" = "founder";
let mockSemanticAvailable = true;

// ─── Mocks ────────────────────────────────────────────────────────────
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: CID }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../hooks/useTeamAccess", () => ({
  useTeamAccess: () => ({ role: mockRole }),
}));

vi.mock("../api/secrets", () => ({
  secretsApi: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
    rotate: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

vi.mock("../api/memory", () => ({
  memoryApi: {
    list: vi.fn().mockImplementation(() =>
      Promise.resolve({ items: [{ id: "m1" }], semanticAvailable: mockSemanticAvailable }),
    ),
    reindexAll: vi.fn().mockResolvedValue({ reindexed: 3 }),
  },
}));

import { memoryApi } from "../api/memory";

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <LLMProvidersSection />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("Memory settings section (embeddings)", () => {
  beforeEach(() => {
    mockRole = "founder";
    mockSemanticAvailable = true;
    vi.mocked(memoryApi.reindexAll).mockClear();
    vi.mocked(memoryApi.reindexAll).mockResolvedValue({ reindexed: 3 });
  });

  it("shows only the OpenAI embeddings key (no Anthropic/Google)", async () => {
    renderSection();
    expect(await screen.findByText(/OpenAI/i)).toBeInTheDocument();
    expect(screen.queryByText(/Anthropic/i)).toBeNull();
    expect(screen.queryByText(/Gemini|Google/i)).toBeNull();
  });

  it("shows semantic status 'off' from semanticAvailable=false", async () => {
    mockSemanticAvailable = false;
    renderSection();
    const status = await screen.findByTestId("semantic-search-status");
    await waitFor(() => expect(status).toHaveTextContent(/semantic search.*off/i));
  });

  it("shows semantic status 'on' from semanticAvailable=true", async () => {
    mockSemanticAvailable = true;
    renderSection();
    const status = await screen.findByTestId("semantic-search-status");
    await waitFor(() => expect(status).toHaveTextContent(/semantic search.*on/i));
  });

  it("Re-index all is founder-only (hidden for team_lead)", async () => {
    mockRole = "team_lead";
    renderSection();
    // Wait for the section to render
    await screen.findByTestId("semantic-search-status");
    expect(screen.queryByRole("button", { name: /re-index all/i })).toBeNull();
  });

  it("Re-index all calls reindexAll after confirm (founder)", async () => {
    const user = userEvent.setup();
    renderSection();
    const trigger = await screen.findByRole("button", { name: /re-index all/i });
    await user.click(trigger);
    // ConfirmDialog confirm button also matches /re-index all/i — pick the last one.
    const confirmButtons = await screen.findAllByRole("button", { name: /re-index all/i });
    await user.click(confirmButtons[confirmButtons.length - 1]!);
    await waitFor(() => expect(memoryApi.reindexAll).toHaveBeenCalledWith(CID));
  });
});
