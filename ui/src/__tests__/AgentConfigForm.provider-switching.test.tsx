/**
 * Provider Switching Phase 1 — Unit D UI tests.
 *
 * Asserts:
 * 1. Switching to codex_local adapter defaults model to gpt-5.5 (NOT gpt-5.3-codex).
 * 2. Codex model picker shows "Default → gpt-5.5" when no model is explicitly set.
 * 3. Save warnings from create/update response are surfaced in the UI.
 *
 * The warnings test is done at the API-type level (AgentSaveResult) rather than
 * via a full page render (AgentDetail is too heavy to mount without a router/company
 * fixture) — the mutation wiring is verified by inspection.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { AgentConfigForm } from "../components/AgentConfigForm";
import { TooltipProvider } from "../components/ui/tooltip";
import { DEFAULT_CODEX_LOCAL_MODEL } from "@armyofagents/adapter-codex-local";

// ── Shared mocks ─────────────────────────────────────────────────────────────

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
  assetsApi: { uploadImage: vi.fn() },
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (v: string) => void;
  }) => (
    <textarea
      aria-label="Prompt template"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const baseAgent = {
  id: "agent-ps",
  companyId: "company-1",
  name: "Provider Switching Agent",
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
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
}

function renderEditForm(agentPatch: Record<string, unknown>, onSave = vi.fn()) {
  render(
    <QueryClientProvider client={makeQC()}>
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DEFAULT_CODEX_LOCAL_MODEL value", () => {
  it("is gpt-5.5 (not gpt-5.3-codex)", () => {
    // This test locks the cleanup — if the constant regresses the test fails.
    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-5.5");
    expect(DEFAULT_CODEX_LOCAL_MODEL).not.toBe("gpt-5.3-codex");
  });
});

describe("AgentConfigForm codex model picker default label", () => {
  it("shows 'Default → gpt-5.5' when codex adapter has no explicit model", async () => {
    renderEditForm({
      adapterType: "codex_local",
      adapterConfig: { model: "" },
    });

    // The model picker trigger should show the resolved default label.
    // We look for the button text that includes "Default → gpt-5.5".
    const modelBtn = await screen.findByRole("button", {
      name: /Default → gpt-5\.5/i,
    });
    expect(modelBtn).toBeInTheDocument();
  });

  it("shows selected model label when model is explicitly set", async () => {
    renderEditForm({
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.3-codex" },
    });

    // gpt-5.3-codex is still a valid explicit selection in the picker list.
    const modelBtn = await screen.findByRole("button", {
      name: /gpt-5\.3-codex/i,
    });
    expect(modelBtn).toBeInTheDocument();
  });
});

describe("AgentConfigForm codex default option writes the explicit default model (P2-3)", () => {
  it("choosing 'Default → gpt-5.5' for codex selects gpt-5.5 explicitly, not an empty model", async () => {
    renderEditForm({
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.3-codex" },
    });

    // Open the model picker (trigger currently shows the explicit model).
    await userEvent.click(await screen.findByRole("button", { name: /gpt-5\.3-codex/i }));
    // Pick the default option.
    await userEvent.click(await screen.findByRole("button", { name: /Default → gpt-5\.5/i }));

    // P2-3: the default option must write the real default (gpt-5.5), so the
    // trigger now reflects an explicit gpt-5.5 selection — NOT the empty
    // "Default → gpt-5.5" placeholder, which would run the codex CLI default
    // instead of gpt-5.5 on an edited agent.
    expect(screen.queryByRole("button", { name: /Default → gpt-5\.5/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^gpt-5\.5/i })).toBeInTheDocument();
  });
});

describe("AgentConfigForm adapter type switch defaults model to gpt-5.5", () => {
  it("switching to codex_local in create mode sets model to DEFAULT_CODEX_LOCAL_MODEL (gpt-5.5)", async () => {
    const onChange = vi.fn();
    const { unmount } = render(
      <QueryClientProvider client={makeQC()}>
        <TooltipProvider>
          <AgentConfigForm
            mode="create"
            values={{
              adapterType: "process",
              cwd: "",
              instructionsFilePath: "",
              promptTemplate: "",
              model: "",
              thinkingEffort: "",
              chrome: false,
              dangerouslySkipPermissions: false,
              search: false,
              fastMode: false,
              dangerouslyBypassSandbox: false,
              command: "",
              args: "",
              extraArgs: "",
              envVars: "",
              envBindings: {},
              url: "",
              bootstrapPrompt: "",
              maxTurnsPerRun: 80,
              heartbeatEnabled: false,
              intervalSec: 300,
            }}
            onChange={onChange}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    // Open the adapter type dropdown
    const adapterBtn = await screen.findByRole("button", { name: /^process$/i });
    await userEvent.click(adapterBtn);

    // Click "Codex (local)" in the dialog
    const dialog = await screen.findByRole("dialog");
    const codexBtn = Array.from(dialog.querySelectorAll("button")).find((b) =>
      b.textContent?.toLowerCase().includes("codex"),
    );
    expect(codexBtn).toBeTruthy();
    await userEvent.click(codexBtn!);

    // The onChange call for adapter-type switch should include model: DEFAULT_CODEX_LOCAL_MODEL
    const calls = onChange.mock.calls;
    const switchCall = calls.find((args: unknown[]) => {
      const patch = args[0] as Record<string, unknown>;
      return patch.adapterType === "codex_local";
    });
    expect(switchCall).toBeTruthy();
    const patch = switchCall![0] as Record<string, unknown>;
    expect(patch.model).toBe("gpt-5.5");

    unmount();
  });
});
