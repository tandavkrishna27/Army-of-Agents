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
    list: vi.fn().mockResolvedValue([
      {
        id: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        name: "OpenAI API key",
        key: "OPENAI_API_KEY",
        status: "active",
        managedMode: "aoa_managed",
        provider: "local_encrypted",
        providerConfigId: null,
        providerMetadata: null,
        externalRef: null,
        latestVersion: 1,
        description: null,
        lastResolvedAt: null,
        lastRotatedAt: null,
        deletedAt: null,
        createdByAgentId: null,
        createdByUserId: "local-board",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]),
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

const baseAgent = {
  id: "agent-1",
  companyId: "company-1",
  name: "Software Agent",
  title: "Engineer",
  role: "general",
  capabilities: ["software"],
  status: "active",
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
  defaultEnvironmentId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function renderForm(agentPatch: Record<string, unknown>, onSave = vi.fn()) {
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
          agent={{ ...baseAgent, ...agentPatch } as any}
          onSave={onSave}
          adapterModels={[]}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );

  return { onSave };
}

describe("AgentConfigForm model API key binding", () => {
  it("binds an OpenAI secret into codex_local env without manual env-row editing", async () => {
    const { onSave } = renderForm({
      adapterType: "codex_local",
      adapterConfig: {},
    });

    await userEvent.click(await screen.findByRole("button", { name: /bind secret/i }));
    const labels = await screen.findAllByText("OPENAI_API_KEY");
    const secretLabel = labels.find((label) => label.closest("button"));
    expect(secretLabel).toBeTruthy();
    await userEvent.click(secretLabel!.closest("button") as HTMLButtonElement);
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          adapterConfig: expect.objectContaining({
            env: expect.objectContaining({
              OPENAI_API_KEY: {
                type: "secret_ref",
                secretId: "11111111-1111-4111-8111-111111111111",
                version: "latest",
              },
            }),
          }),
        }),
      );
    });
  });

  it("shows Claude's required ANTHROPIC_API_KEY binding separately from generic env vars", async () => {
    renderForm({
      adapterType: "claude_local",
      adapterConfig: {},
    });

    const field = await screen.findByText("Model API key");
    const container = field.closest("div")?.parentElement;
    expect(container).toBeTruthy();
    expect(within(container as HTMLElement).getByText("ANTHROPIC_API_KEY")).toBeInTheDocument();
  });
});
