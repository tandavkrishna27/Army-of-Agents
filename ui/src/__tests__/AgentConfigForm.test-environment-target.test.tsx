import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { AgentConfigForm } from "../components/AgentConfigForm";
import { TooltipProvider } from "../components/ui/tooltip";

const testEnvironmentMock = vi.fn().mockResolvedValue({
  adapterType: "process",
  status: "pass",
  checks: [],
  testedAt: "2026-06-01T00:00:00.000Z",
});

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    adapterModels: vi.fn().mockResolvedValue([]),
    org: vi.fn().mockResolvedValue([]),
    testEnvironment: (...args: unknown[]) => testEnvironmentMock(...args),
  },
}));

vi.mock("../api/secrets", () => ({
  secretsApi: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
  },
}));

vi.mock("../api/environments", () => ({
  useEnvironments: () => ({
    data: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "E2B Cloud QA",
      },
    ],
  }),
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

const baseAgent = {
  id: "agent-1",
  companyId: "company-1",
  name: "Process Agent",
  title: "Operator",
  role: "general",
  capabilities: ["automation"],
  status: "active",
  adapterType: "process",
  adapterConfig: {
    command: "pwd",
  },
  runtimeConfig: {
    heartbeat: {
      enabled: true,
      intervalSec: 300,
      wakeOnDemand: true,
    },
  },
  reportsToAgentId: null,
  reportsToUserId: null,
  parentType: null,
  parentId: null,
  departmentId: null,
  defaultEnvironmentId: "22222222-2222-4222-8222-222222222222",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function renderForm() {
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
          onSave={vi.fn()}
          adapterModels={[]}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("AgentConfigForm adapter environment test", () => {
  it("sends the selected default environment id when testing the adapter", async () => {
    renderForm();

    await userEvent.click(await screen.findByRole("button", { name: /test environment/i }));

    await waitFor(() => {
      expect(testEnvironmentMock).toHaveBeenCalledWith(
        "company-1",
        "process",
        expect.objectContaining({
          environmentId: "22222222-2222-4222-8222-222222222222",
          adapterConfig: expect.objectContaining({ command: "pwd" }),
        }),
      );
    });
  });
});
