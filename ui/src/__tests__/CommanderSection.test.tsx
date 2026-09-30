import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  renderWithProviders,
  mockCompanyContext,
  makeCompany,
} from "./test-utils";
import { CommanderSection } from "@/components/settings/sections/CommanderSection";
import type { AgentConfig, AgentRunsResponse } from "../api/internal-agent";

// --- Factory ---
function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "ia-cfg-1",
    executionMode: "api",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    cliTool: null,
    // D18: the two dials are deliberately DIFFERENT in this fixture so a control
    // that read the wrong column would be visible in the assertions below.
    autonomyLevel: 0,
    crewAutonomyLevel: 2,
    enabledCapabilities: [
      "discussion_processing",
      "proactive_suggestions",
      "organizational_queries",
      "system_actions",
      "context_briefing",
      "memory_management",
      "conflict_detection",
      "budget_awareness",
      "workflow_coaching",
      "workflow_discovery",
      "cross_department_coordination",
      "department_personas",
    ],
    notificationPreference: "realtime",
    contextTokenBudget: 8000,
    budgetMonthlyCents: 5000,
    spentMonthlyCents: 1234,
    proactiveIntervalMinutes: 240,
    lastProactiveRunAt: null,
    cheapModel: null,
    runtimeApprovalsEnabled: true,
    runtimeAllowAlwaysEnabled: true,
    vendorCliBypassEnabled: true,
    ...overrides,
  };
}

function makeRunsResponse(
  overrides: Partial<AgentRunsResponse> = {},
): AgentRunsResponse {
  return {
    runs: [],
    total: 0,
    limit: 20,
    offset: 0,
    aggregates: {
      totalCostCents: 0,
      totalRuns: 0,
      avgDurationMs: 0,
      failureRate: 0,
    },
    ...overrides,
  };
}

// --- API mock ---
const apiMock = {
  getConfig: vi.fn().mockResolvedValue(makeAgentConfig()),
  updateConfig: vi.fn().mockResolvedValue(makeAgentConfig()),
  getRuns: vi.fn().mockResolvedValue(makeRunsResponse()),
  testConnection: vi.fn().mockResolvedValue({ success: true }),
};
const toolPermissionsMock = {
  get: vi.fn().mockResolvedValue({
    permissions: {},
    default: {
      enabled: true,
      requireConfirmation: false,
      minimumRole: "team_member",
    },
  }),
  update: vi.fn().mockResolvedValue({ success: true }),
};
const trustRulesMock = {
  list: vi.fn().mockResolvedValue({ rules: [] }),
  revoke: vi.fn().mockResolvedValue({ success: true }),
};
const runtimeTrustRulesMock = {
  listTrustRules: vi.fn().mockResolvedValue({ rules: [] }),
  revokeTrustRule: vi.fn().mockResolvedValue({ success: true }),
};

vi.mock("@/api/internal-agent", () => ({
  internalAgentApi: new Proxy(
    {},
    { get: (_t, prop) => (apiMock as any)[prop] },
  ),
  toolPermissionsApi: new Proxy(
    {},
    { get: (_t, prop) => (toolPermissionsMock as any)[prop] },
  ),
  commanderTrustRulesApi: new Proxy(
    {},
    { get: (_t, prop) => (trustRulesMock as any)[prop] },
  ),
}));

vi.mock("@/api/agent-runtime-decisions", () => ({
  agentRuntimeDecisionsApi: new Proxy(
    {},
    { get: (_t, prop) => (runtimeTrustRulesMock as any)[prop] },
  ),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => mockCompanyContext,
}));

// CommanderSubTabs is mocked to expose the legacy `data-testid="tab-<id>"`
// hooks so the existing test bodies can drive the component. Sub-tab state
// is owned here in the mock so user clicks switch the active tab.
vi.mock("@/components/settings/sections/CommanderSubTabs", async () => {
  const React = await import("react");
  const SUB_TABS = [
    { id: "execution", label: "Execution & Model" },
    { id: "capabilities", label: "Capabilities" },
    { id: "budget", label: "Budget & Spend" },
    { id: "history", label: "Run History" },
    { id: "permissions", label: "Permissions" },
    { id: "trusted-actions", label: "Trusted Actions" },
  ];

  function useCommanderSubTab() {
    const [active, setActive] = React.useState("execution");
    return { active, setActive };
  }

  function MockSubTabs({
    active,
    onSelect,
  }: {
    active: string;
    onSelect: (id: string) => void;
  }) {
    return (
      <div data-testid="page-tab-bar">
        {SUB_TABS.map((t) => (
          <button
            key={t.id}
            data-testid={`tab-${t.id}`}
            aria-selected={active === t.id}
            onClick={() => onSelect(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
    );
  }

  return {
    CommanderSubTabs: MockSubTabs,
    CommanderSubTabsMobile: () => null,
    useCommanderSubTab,
  };
});

// --- Tests ---
describe("CommanderSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.selectedCompanyId = "comp-1";
    mockCompanyContext.selectedCompany = makeCompany();
    mockCompanyContext.companies = [makeCompany()];
    apiMock.getConfig.mockResolvedValue(makeAgentConfig());
    apiMock.getRuns.mockResolvedValue(makeRunsResponse());
    trustRulesMock.list.mockResolvedValue({ rules: [] });
    trustRulesMock.revoke.mockResolvedValue({ success: true });
    runtimeTrustRulesMock.listTrustRules.mockResolvedValue({ rules: [] });
    runtimeTrustRulesMock.revokeTrustRule.mockResolvedValue({ success: true });
  });

  it("renders tab bar with all tabs", async () => {
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByTestId("page-tab-bar")).toBeInTheDocument();
    });
    expect(screen.getByTestId("tab-execution")).toBeInTheDocument();
    expect(screen.getByTestId("tab-capabilities")).toBeInTheDocument();
    expect(screen.getByTestId("tab-budget")).toBeInTheDocument();
    expect(screen.getByTestId("tab-history")).toBeInTheDocument();
    expect(screen.getByTestId("tab-permissions")).toBeInTheDocument();
    expect(screen.getByTestId("tab-trusted-actions")).toBeInTheDocument();
  });

  // Sprint 2A (Decision #91) — Commander is CLI-only. The page no longer
  // shows a mode toggle, provider picker, or model picker; just the CLI tool
  // picker.
  it("shows CLI tool dropdown (the only execution option)", async () => {
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByText("CLI Tool")).toBeInTheDocument();
    });
  });

  it("renders runtime approval toggles on execution tab", async () => {
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByLabelText("Require AoA runtime approvals")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Allow always for exact repeated actions")).toBeInTheDocument();
    expect(screen.getByLabelText("Bypass vendor CLI approval prompts")).toBeInTheDocument();
  });

  it("saves runtime approval toggles with execution settings", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByLabelText("Require AoA runtime approvals")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Require AoA runtime approvals"));
    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(apiMock.updateConfig).toHaveBeenCalledWith(
        "comp-1",
        expect.objectContaining({
          executionMode: "cli",
          runtimeApprovalsEnabled: false,
          runtimeAllowAlwaysEnabled: true,
          vendorCliBypassEnabled: true,
        }),
      );
    });
  });

  it("renders and revokes trusted Commander actions", async () => {
    trustRulesMock.list.mockResolvedValue({
      rules: [
        {
          id: "trust-1",
          toolName: "create_task",
          scope: "exact_params",
          paramsHashPrefix: "abcdef12",
          paramsHashVersion: "v1",
          lastUsedAt: null,
          expiresAt: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);

    await waitFor(() => {
      expect(screen.getByTestId("tab-trusted-actions")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("tab-trusted-actions"));

    await waitFor(() => {
      expect(screen.getByText("create_task")).toBeInTheDocument();
    });
    expect(screen.getByText("v1:abcdef12")).toBeInTheDocument();

    await user.click(screen.getByText("Revoke"));

    await waitFor(() => {
      expect(trustRulesMock.revoke).toHaveBeenCalledWith("comp-1", "trust-1");
    });
  });

  it("renders and revokes W5 runtime allow-always trust rules", async () => {
    runtimeTrustRulesMock.listTrustRules.mockResolvedValue({
      rules: [
        {
          id: "runtime-trust-1",
          agentId: "agent-1",
          adapterType: "openai_codex",
          toolName: "shell",
          commandHashPrefix: "1234abcd",
          pathScope: "C:/repo",
          networkScope: null,
          riskClass: "medium",
          enabled: true,
          lastUsedAt: null,
          expiresAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);

    await waitFor(() => {
      expect(screen.getByTestId("tab-trusted-actions")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("tab-trusted-actions"));

    await waitFor(() => {
      expect(screen.getByText("shell")).toBeInTheDocument();
    });
    expect(screen.getByText("Runtime decision")).toBeInTheDocument();
    expect(screen.getByText(/cmd:1234abcd/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Revoke runtime trust rule shell" }));

    await waitFor(() => {
      expect(runtimeTrustRulesMock.revokeTrustRule).toHaveBeenCalledWith("comp-1", "runtime-trust-1");
    });
  });

  it("does not show API-mode provider or model pickers", async () => {
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByText("CLI Tool")).toBeInTheDocument();
    });
    expect(screen.queryByText("Provider")).not.toBeInTheDocument();
    expect(screen.queryByText("Model")).not.toBeInTheDocument();
    expect(screen.queryByText("Execution Mode")).not.toBeInTheDocument();
  });

  it("shows Commander no autonomy level at all — not a hard-coded one", async () => {
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(
        screen.getByText(/Commander asks before every governed action/),
      ).toBeInTheDocument();
    });
    // The old control was a hard-coded `<Select value="0">` that ignored
    // `config.autonomyLevel`. That column defaults to 1 and round-trips through
    // portability bundles, so the label could contradict storage. There is no
    // level to show (Decision #109 addendum §12), so none is shown.
    expect(screen.queryByText(/Level 0/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Full Approval/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Commander autonomy")).not.toBeInTheDocument();
  });

  // D18 dial-split discriminator: the founder-settable agent dial must render the
  // CREW column (2 = Drive) — not Commander's `autonomyLevel` (0) — and must be
  // enabled. Before the split there was one disabled stub and no way to set this.
  it("agent autonomy renders the crew dial (not Commander's) and is editable", async () => {
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByText("Agent autonomy (crew + org agents)")).toBeInTheDocument();
    });
    const crewTrigger = screen.getByLabelText("Agent autonomy");
    expect(crewTrigger).not.toBeDisabled();
    expect(crewTrigger).toHaveTextContent("Drive — agents can complete and dispatch");
    // Commander's dial is 0 in the fixture; if the control had read it we would
    // see the Manual copy here instead.
    expect(crewTrigger).not.toHaveTextContent("Manual — I move every task");
  });

  it("renders all 12 capability checkboxes on capabilities tab", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByTestId("tab-capabilities")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("tab-capabilities"));
    await waitFor(() => {
      expect(screen.getByText("Discussion Processing")).toBeInTheDocument();
    });
    expect(screen.getByText("Proactive Suggestions")).toBeInTheDocument();
    expect(screen.getByText("Budget Awareness")).toBeInTheDocument();
    expect(screen.getByText("Department Personas")).toBeInTheDocument();
  });

  it("select all toggles all capabilities on", async () => {
    apiMock.getConfig.mockResolvedValue(
      makeAgentConfig({ enabledCapabilities: [] }),
    );
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByTestId("tab-capabilities")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("tab-capabilities"));
    await waitFor(() => {
      expect(screen.getByText("Select All")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Select All"));
    const checkboxes = screen.getAllByRole("checkbox");
    const capCheckboxes = checkboxes.filter(
      (cb) => cb.getAttribute("data-capability") !== null,
    );
    capCheckboxes.forEach((cb) => {
      expect(cb).toBeChecked();
    });
  });

  it("renders notification preference options on capabilities tab", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByTestId("tab-capabilities")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("tab-capabilities"));
    await waitFor(() => {
      expect(screen.getByText("Silent")).toBeInTheDocument();
    });
    expect(screen.getByText("Digest")).toBeInTheDocument();
    expect(screen.getByText("Real-time")).toBeInTheDocument();
  });

  it("budget progress bar is green when under 70%", async () => {
    apiMock.getConfig.mockResolvedValue(
      makeAgentConfig({ spentMonthlyCents: 1000, budgetMonthlyCents: 5000 }),
    );
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByTestId("tab-budget")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("tab-budget"));
    await waitFor(() => {
      expect(screen.getByTestId("budget-progress")).toBeInTheDocument();
    });
    const bar = screen.getByTestId("budget-progress-bar");
    expect(bar.className).toContain("bg-emerald");
  });

  it("budget progress bar is yellow when 70-89%", async () => {
    apiMock.getConfig.mockResolvedValue(
      makeAgentConfig({ spentMonthlyCents: 4000, budgetMonthlyCents: 5000 }),
    );
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByTestId("tab-budget")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("tab-budget"));
    await waitFor(() => {
      expect(screen.getByTestId("budget-progress")).toBeInTheDocument();
    });
    const bar = screen.getByTestId("budget-progress-bar");
    expect(bar.className).toContain("bg-amber");
  });

  it("budget progress bar is red when >= 90%", async () => {
    apiMock.getConfig.mockResolvedValue(
      makeAgentConfig({ spentMonthlyCents: 4800, budgetMonthlyCents: 5000 }),
    );
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByTestId("tab-budget")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("tab-budget"));
    await waitFor(() => {
      expect(screen.getByTestId("budget-progress")).toBeInTheDocument();
    });
    const bar = screen.getByTestId("budget-progress-bar");
    expect(bar.className).toContain("bg-red");
  });

  it("shows agent paused indicator at 100%", async () => {
    apiMock.getConfig.mockResolvedValue(
      makeAgentConfig({ spentMonthlyCents: 5000, budgetMonthlyCents: 5000 }),
    );
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByTestId("tab-budget")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("tab-budget"));
    await waitFor(() => {
      expect(screen.getByText("Agent paused")).toBeInTheDocument();
    });
  });

  it("execution tab save calls updateConfig with CLI and runtime approval fields", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByText("Save")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Save"));
    await waitFor(() => {
      expect(apiMock.updateConfig).toHaveBeenCalledWith(
        "comp-1",
        expect.objectContaining({
          executionMode: "cli",
          cliTool: "claude_cli",
          runtimeApprovalsEnabled: true,
          runtimeAllowAlwaysEnabled: true,
          vendorCliBypassEnabled: true,
        }),
      );
    });
  });

  it("test connection shows green badge on success", async () => {
    apiMock.testConnection.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByText("Test Connection")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Test Connection"));
    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });
  });

  it("test connection shows red badge on failure", async () => {
    apiMock.testConnection.mockResolvedValue({
      success: false,
      error: "Invalid API key",
    });
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByText("Test Connection")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Test Connection"));
    await waitFor(() => {
      expect(screen.getByText("Failed")).toBeInTheDocument();
    });
  });

  it("run history tab renders empty state when no runs", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByTestId("tab-history")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("tab-history"));
    await waitFor(() => {
      expect(screen.getByText("No runs yet")).toBeInTheDocument();
    });
  });

  it("toggling individual checkbox updates state", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByTestId("tab-capabilities")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("tab-capabilities"));
    await waitFor(() => {
      expect(screen.getByText("Discussion Processing")).toBeInTheDocument();
    });
    const checkbox = screen.getByRole("checkbox", {
      name: /Discussion Processing/i,
    });
    expect(checkbox).toBeChecked();
    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });

  it("notification preference radio selection changes value", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByTestId("tab-capabilities")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("tab-capabilities"));
    await waitFor(() => {
      expect(screen.getByText("Silent")).toBeInTheDocument();
    });
    const silentRadio = screen.getByRole("radio", { name: /Silent/i });
    await user.click(silentRadio);
    expect(silentRadio).toBeChecked();
  });

  it("context token budget dropdown renders current value", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByTestId("tab-capabilities")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("tab-capabilities"));
    await waitFor(() => {
      expect(screen.getByText("Context Token Budget")).toBeInTheDocument();
    });
    expect(screen.getByText("Standard (8,000)")).toBeInTheDocument();
  });

  it("deselect all toggles all capabilities off", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByTestId("tab-capabilities")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("tab-capabilities"));
    await waitFor(() => {
      expect(screen.getByText("Deselect All")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Deselect All"));
    const checkboxes = screen.getAllByRole("checkbox");
    const capCheckboxes = checkboxes.filter(
      (cb) => cb.getAttribute("data-capability") !== null,
    );
    capCheckboxes.forEach((cb) => {
      expect(cb).not.toBeChecked();
    });
  });

  it("run history tab renders table with run data", async () => {
    apiMock.getRuns.mockResolvedValue(
      makeRunsResponse({
        runs: [
          {
            id: "run-1",
            triggerType: "conversation",
            triggerSource: "user_message",
            status: "completed",
            toolsCalled: [],
            tokenUsage: { inputTokens: 100, outputTokens: 50 },
            costCents: 2,
            durationMs: 1500,
            summary: "Answered question",
            departmentContext: null,
            userId: "user-1",
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
        ],
        total: 1,
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByTestId("tab-history")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("tab-history"));
    await waitFor(() => {
      expect(screen.getByText("conversation")).toBeInTheDocument();
    });
    expect(screen.getByText("completed")).toBeInTheDocument();
  });

  it("load more button visible when more pages exist", async () => {
    apiMock.getRuns.mockResolvedValue(
      makeRunsResponse({
        runs: [
          {
            id: "run-1",
            triggerType: "conversation",
            triggerSource: "user_message",
            status: "completed",
            toolsCalled: [],
            tokenUsage: { inputTokens: 100, outputTokens: 50 },
            costCents: 2,
            durationMs: 1500,
            summary: null,
            departmentContext: null,
            userId: "user-1",
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
        ],
        total: 25,
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByTestId("tab-history")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("tab-history"));
    await waitFor(() => {
      expect(screen.getByText("Load More")).toBeInTheDocument();
    });
  });

  it("load more button hidden when all runs loaded", async () => {
    apiMock.getRuns.mockResolvedValue(
      makeRunsResponse({
        runs: [
          {
            id: "run-1",
            triggerType: "conversation",
            triggerSource: "user_message",
            status: "completed",
            toolsCalled: [],
            tokenUsage: { inputTokens: 100, outputTokens: 50 },
            costCents: 2,
            durationMs: 1500,
            summary: null,
            departmentContext: null,
            userId: "user-1",
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
        ],
        total: 1,
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByTestId("tab-history")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("tab-history"));
    await waitFor(() => {
      expect(screen.getByText("conversation")).toBeInTheDocument();
    });
    expect(screen.queryByText("Load More")).not.toBeInTheDocument();
  });

  it("capabilities tab save calls updateConfig with capabilities fields", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByTestId("tab-capabilities")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("tab-capabilities"));
    await waitFor(() => {
      expect(screen.getByText("Save")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Save"));
    await waitFor(() => {
      expect(apiMock.updateConfig).toHaveBeenCalledWith("comp-1", {
        enabledCapabilities: expect.any(Array),
        notificationPreference: "realtime",
        contextTokenBudget: 8000,
        proactiveIntervalMinutes: 240,
      });
    });
  });

  it("budget tab save calls updateConfig with budget fields", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommanderSection />);
    await waitFor(() => {
      expect(screen.getByTestId("tab-budget")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("tab-budget"));
    await waitFor(() => {
      expect(screen.getByText("Save")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Save"));
    await waitFor(() => {
      expect(apiMock.updateConfig).toHaveBeenCalledWith("comp-1", {
        budgetMonthlyCents: 5000,
        cheapModel: null,
      });
    });
  });

  describe("cost-saver cheap model field", () => {
    it("renders the cheap model input in the budget tab", async () => {
      apiMock.getConfig.mockResolvedValue(
        makeAgentConfig({ cheapModel: "claude-haiku-4-5" }),
      );
      const user = userEvent.setup();
      renderWithProviders(<CommanderSection />);
      await waitFor(() => {
        expect(screen.getByTestId("tab-budget")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("tab-budget"));
      const input = await screen.findByTestId("cheap-model-input");
      expect(input).toBeInTheDocument();
      expect((input as HTMLInputElement).value).toBe("claude-haiku-4-5");
    });

    it("renders empty cheap model input when cheapModel is null", async () => {
      apiMock.getConfig.mockResolvedValue(
        makeAgentConfig({ cheapModel: null }),
      );
      const user = userEvent.setup();
      renderWithProviders(<CommanderSection />);
      await waitFor(() => {
        expect(screen.getByTestId("tab-budget")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("tab-budget"));
      const input = await screen.findByTestId("cheap-model-input");
      expect((input as HTMLInputElement).value).toBe("");
    });
  });
});
