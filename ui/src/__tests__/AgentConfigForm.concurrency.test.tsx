import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { AgentConfigForm } from "../components/AgentConfigForm";
import { TooltipProvider } from "../components/ui/tooltip";

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    adapterModels: vi.fn().mockResolvedValue([]),
    org: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../api/secrets", () => ({
  secretsApi: { list: vi.fn().mockResolvedValue([]), create: vi.fn() },
}));

vi.mock("../api/environments", () => ({ useEnvironments: () => ({ data: [] }) }));

vi.mock("../api/assets", () => ({ assetsApi: { uploadImage: vi.fn() } }));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Prompt template" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

const baseAgent = {
  id: "agent-1",
  companyId: "company-1",
  name: "Concurrency Agent",
  title: "Engineer",
  role: "general",
  capabilities: ["software"],
  status: "active",
  adapterType: "process",
  adapterConfig: {},
  runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300, wakeOnDemand: true } },
  reportsToAgentId: null,
  reportsToUserId: null,
  parentType: null,
  parentId: null,
  departmentId: null,
  defaultEnvironmentId: null,
  createdAt: "2026-06-25T11:00:00.000Z",
  updatedAt: "2026-06-25T12:00:00.000Z",
};

describe("AgentConfigForm — optimistic concurrency token (Decision #104)", () => {
  it("includes expectedUpdatedAt (agent.updatedAt) in the save patch", async () => {
    const onSave = vi.fn();
    let save: (() => void) | null = null;
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AgentConfigForm
            mode="edit"
            agent={baseAgent as any}
            onSave={onSave}
            adapterModels={[]}
            onSaveActionChange={(fn) => {
              save = fn;
            }}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    // Make the form dirty by switching the adapter type (proven dirty trigger).
    await userEvent.click(await screen.findByRole("button", { name: /^process$/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /^http/i }));

    // Trigger the registered save action; the patch must carry the token.
    await waitFor(() => expect(typeof save).toBe("function"));
    save!();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ expectedUpdatedAt: "2026-06-25T12:00:00.000Z" }),
    );
  });
});
