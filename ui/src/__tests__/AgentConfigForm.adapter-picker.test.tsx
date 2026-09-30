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

const baseAgent = {
  id: "agent-1",
  companyId: "company-1",
  name: "Adapter Picker Agent",
  title: "Engineer",
  role: "general",
  capabilities: ["software"],
  status: "active",
  adapterType: "process",
  adapterConfig: {},
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

function renderForm(extraProps: Record<string, unknown> = {}) {
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
          {...extraProps}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("AgentConfigForm adapter picker", () => {
  it("offers process and HTTP as advanced selectable adapters", async () => {
    renderForm();

    await screen.findByText("Adapter type");
    await userEvent.click(await screen.findByRole("button", { name: /^process$/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /^process/i })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: /^http/i })).toBeEnabled();

    await userEvent.click(within(dialog).getByRole("button", { name: /^http/i }));
    expect(await screen.findByText("Method")).toBeInTheDocument();
    expect(screen.getByText("Headers JSON")).toBeInTheDocument();
    expect(screen.getByText("Payload template JSON")).toBeInTheDocument();
  });

  // Codex P2: the Config section nav derived isLocal from the persisted adapter type,
  // so switching a non-local agent to a local adapter before saving hid the local-only
  // "Permissions & config" section. The form must report the draft adapter type up.
  it("reports the draft adapter type so the parent nav can react before save", async () => {
    const onAdapterTypeChange = vi.fn();
    renderForm({ onAdapterTypeChange });

    // Fires on mount with the persisted (non-local) type.
    await waitFor(() => expect(onAdapterTypeChange).toHaveBeenCalledWith("process"));

    // Switch to a local adapter without saving.
    await userEvent.click(await screen.findByRole("button", { name: /^process$/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /claude.*\(local\)/i }));

    // Parent is now told the draft is local → it would surface "Permissions & config".
    await waitFor(() => expect(onAdapterTypeChange).toHaveBeenCalledWith("claude_local"));
  });
});
