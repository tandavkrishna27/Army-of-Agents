import { render, screen, waitFor, within } from "@testing-library/react";
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
  secretsApi: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
  },
}));

vi.mock("../api/environments", () => ({
  useEnvironments: () => ({ data: [] }),
}));

vi.mock("../api/assets", () => ({
  assetsApi: {
    uploadImage: vi.fn(),
  },
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Prompt template" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

const mockAgent = {
  id: "agent-1",
  companyId: "company-1",
  name: "Software Agent",
  title: "Engineer",
  role: "engineer",
  capabilities: ["software"],
  status: "active",
  adapterType: "process",
  adapterConfig: { command: "node" },
  runtimeConfig: {
    aoaAppPreviews: true,
    autoRunSummary: true,
    injectCompanyContext: true,
    contextMode: "standard",
    heartbeat: {
      enabled: true,
      intervalSec: 300,
      wakeOnDemand: true,
    },
  },
  reportsToAgentId: null,
  reportsToUserId: null,
  departmentId: null,
  defaultEnvironmentId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function renderForm(onSave: (patch: Record<string, unknown>) => void) {
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
          agent={mockAgent as any}
          onSave={onSave}
          adapterModels={[]}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function clickToggle(label: string) {
  const labelNode = await screen.findByText(label);
  const row = labelNode.parentElement?.parentElement;
  if (!row) throw new Error(`Missing toggle row for ${label}`);
  const buttons = within(row).getAllByRole("button");
  const button = buttons[buttons.length - 1];
  await userEvent.click(button);
}

describe("AgentConfigForm AoA app previews", () => {
  it("persists AoA app previews as top-level runtimeConfig while preserving existing runtime settings", async () => {
    const onSave = vi.fn();
    renderForm(onSave);

    await clickToggle("AoA app previews");
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeConfig: expect.objectContaining({
            aoaAppPreviews: false,
            autoRunSummary: true,
            injectCompanyContext: true,
            contextMode: "standard",
            heartbeat: expect.objectContaining({
              enabled: true,
              intervalSec: 300,
              wakeOnDemand: true,
            }),
          }),
        }),
      );
    });
  });
});
