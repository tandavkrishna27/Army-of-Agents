import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MemorySettingsSection } from "../MemorySettingsSection";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../LLMProvidersSectionWrapper", () => ({
  LLMProvidersSectionWrapper: () => <div>Embeddings config</div>,
}));

const update = vi.fn().mockResolvedValue({});
const deleteOverride = vi.fn().mockResolvedValue(undefined);
vi.mock("@/api/memorySettings", () => ({
  memorySettingsApi: {
    list: vi.fn().mockResolvedValue([
      {
        id: "row-1",
        companyId: "company-1",
        departmentId: null,
        autonomyLevel: "supervised",
        activeContextTier: "durable",
      },
    ]),
    update: (...a: unknown[]) => update(...a),
    deleteOverride: (...a: unknown[]) => deleteOverride(...a),
  },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: {
    list: vi
      .fn()
      .mockResolvedValue([{ id: "dept-eng", name: "Engineering", type: "department" }]),
  },
}));

function renderSection() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/C1/settings?tab=memory"]}>
        <TooltipProvider>
          <MemorySettingsSection />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MemorySettingsSection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the autonomy dial and the embedded embeddings config", async () => {
    renderSection();
    expect(await screen.findByLabelText(/autonomy/i)).toBeInTheDocument();
    expect(screen.getByText("Embeddings config")).toBeInTheDocument();
  });

  it("saves when the autonomy dial changes", async () => {
    renderSection();
    const dial = await screen.findByLabelText(/autonomy/i);
    fireEvent.change(dial, { target: { value: "trusted" } });
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ autonomyLevel: "trusted" }),
      ),
    );
  });

  it("saves a department override carrying the departmentId", async () => {
    renderSection();
    const deptDial = await screen.findByLabelText("Engineering");
    fireEvent.change(deptDial, { target: { value: "manual" } });
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ departmentId: "dept-eng", autonomyLevel: "manual" }),
      ),
    );
  });
});
