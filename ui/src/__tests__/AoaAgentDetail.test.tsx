import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, makeAgent, mockCompanyContext, mockBreadcrumbContext } from "./test-utils";

// --- Mocks ---

const mockNavigate = vi.fn();

const mockParams: { agentId: string; companyPrefix?: string; tab?: string } = {
  agentId: "agent-aoa-1",
  companyPrefix: undefined,
  tab: undefined,
};

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => mockParams,
    Link: actual.Link,
    NavLink: actual.NavLink,
    useBeforeUnload: vi.fn(),
  };
});

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => mockCompanyContext,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => mockBreadcrumbContext,
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

// The page now calls useUnsavedChanges (global guard); this test mounts it
// without the provider, so stub the hook to a no-op.
vi.mock("@/hooks/useUnsavedChanges", () => ({ useUnsavedChanges: vi.fn() }));

// Founder gate source — mirrors TeamPage's useTeamAccess(...).role === "founder".
const mockTeamAccess: { role: string | null } = { role: "founder" };
vi.mock("../hooks/useTeamAccess", () => ({
  useTeamAccess: () => mockTeamAccess,
}));

const mockListTriggers = vi.fn();
const mockPatchTrigger = vi.fn();
const mockGetAoaRuns = vi.fn();
const mockAgentsGet = vi.fn();
const mockAgentsPause = vi.fn();
const mockAgentsResume = vi.fn();
const mockAgentsTerminate = vi.fn();

vi.mock("../api/agents", () => ({
  agentsApi: {
    get: (...args: any[]) => mockAgentsGet(...args),
    listTriggers: (...args: any[]) => mockListTriggers(...args),
    patchTrigger: (...args: any[]) => mockPatchTrigger(...args),
    getAoaRuns: (...args: any[]) => mockGetAoaRuns(...args),
    pause: (...args: any[]) => mockAgentsPause(...args),
    resume: (...args: any[]) => mockAgentsResume(...args),
    terminate: (...args: any[]) => mockAgentsTerminate(...args),
    createTrigger: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    listKeys: vi.fn().mockResolvedValue([]),
    listConfigRevisions: vi.fn().mockResolvedValue([]),
    adapterModels: vi.fn().mockResolvedValue([]),
    runtimeState: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    agents: {
      detail: (id: string) => ["agents", id],
      list: (id: string) => ["agents", "list", id],
      runtimeState: (id: string) => ["agents", "runtimeState", id],
      configRevisions: (id: string) => ["agents", "configRevisions", id],
      keys: (id: string) => ["agents", "keys", id],
      adapterModels: (cid: string, at: string) => ["agents", "adapterModels", cid, at],
    },
    aoaRuns: (agentId: string) => ["aoa-runs", agentId],
    triggers: (agentId: string) => ["triggers", agentId],
  },
}));

vi.mock("../components/agent-detail/AgentDetailCore", () => ({
  AgentDetailCore: ({ agent, tabs, activeView, renderTab, headerActions, heroKpis }: any) => (
    <div data-testid="agent-detail-core">
      <h1 data-testid="agent-name">{agent?.name}</h1>
      <div data-testid="header-actions">{headerActions}</div>
      <div data-testid="hero-kpis">
        {heroKpis?.map((k: any) => (
          <span key={k.key} data-testid={`kpi-${k.key}`}>{k.label}: {String(k.value)}</span>
        ))}
      </div>
      <div data-testid="tab-content">{renderTab(activeView)}</div>
      <div data-testid="tabs">
        {tabs?.map((t: any) => (
          <span key={t.value} data-testid={`tab-${t.value}`}>{t.label}</span>
        ))}
      </div>
    </div>
  ),
}));

vi.mock("../components/AgentInstructionsTab", () => ({
  AgentInstructionsTab: () => <div data-testid="instructions-tab">Instructions</div>,
}));

vi.mock("../components/AgentConfigForm", () => ({
  AgentConfigForm: () => <div data-testid="config-form">Config Form</div>,
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div data-testid="page-skeleton">Loading...</div>,
}));

vi.mock("../components/StatusBadge", () => ({
  StatusBadge: ({ status }: any) => <span data-testid="status-badge">{status}</span>,
}));

// Radix Popover portals content to document.body, escaping the header-actions
// region. Mock it to render trigger + content inline (consistent with this
// file's harness style of stubbing UI primitives).
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: any) => <div data-testid="popover">{children}</div>,
  PopoverTrigger: ({ children }: any) => <>{children}</>,
  PopoverContent: ({ children }: any) => <div data-testid="popover-content">{children}</div>,
}));

vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: ({ icon }: any) => <span data-testid="agent-icon">{icon ?? "icon"}</span>,
  AgentIconPicker: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("../components/agent-config-primitives", () => ({
  roleLabels: { engineer: "Engineer", lead: "Lead", cxo: "Director" } as Record<string, string>,
  adapterLabels: { claude_local: "Claude (local)" } as Record<string, string>,
}));

vi.mock("../lib/utils", () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(" "),
  relativeTime: () => "just now",
  formatDate: () => "2026-01-01",
  agentRouteRef: (agent: any) => agent?.urlKey ?? agent?.id ?? "",
  isUuidLike: (v: string) => /^[0-9a-f-]{36}$/.test(v),
}));

vi.mock("@armyofagents/shared", async () => {
  const actual = await vi.importActual<typeof import("@armyofagents/shared")>("@armyofagents/shared");
  return {
    ...actual,
    isUuidLike: (v: string) => /^[0-9a-f-]{36}$/.test(v),
  };
});

// --- Import AoaAgentDetail after mocks ---
import { AoaAgentDetail } from "../pages/AoaAgentDetail";
import { AoaTriggersTab } from "../components/agent-detail/AoaTriggersTab";

describe("AoaAgentDetail", () => {
  const aoaAgent = makeAgent({
    id: "agent-aoa-1",
    name: "Commander Bot",
    role: "lead",
    status: "active",
    adapterType: "claude_local",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockParams.agentId = "agent-aoa-1";
    mockParams.companyPrefix = undefined;
    mockParams.tab = undefined;
    mockCompanyContext.selectedCompanyId = "comp-1";
    mockAgentsGet.mockResolvedValue(aoaAgent);
    mockListTriggers.mockResolvedValue([]);
    mockGetAoaRuns.mockResolvedValue({ runs: [], total: 0, limit: 50 });
  });

  it("renders agent name in header", async () => {
    renderWithProviders(<AoaAgentDetail />);

    await waitFor(() => {
      expect(screen.getByTestId("agent-name")).toHaveTextContent("Commander Bot");
    });
  });

  it("renders all expected tabs", async () => {
    renderWithProviders(<AoaAgentDetail />);

    await waitFor(() => {
      expect(screen.getByTestId("tab-overview")).toBeInTheDocument();
      expect(screen.getByTestId("tab-instructions")).toBeInTheDocument();
      expect(screen.getByTestId("tab-runs")).toBeInTheDocument();
      expect(screen.getByTestId("tab-skills")).toBeInTheDocument();
      expect(screen.getByTestId("tab-configure")).toBeInTheDocument();
      expect(screen.getByTestId("tab-triggers")).toBeInTheDocument();
    });
  });

  // Follow-up #4: /aoa-runs returns { runs, total } — `total` is count(*) over
  // ALL runs, so the hero KPI shows the true total-ever (no "50+" cap), labelled
  // "Total runs". NOTE: the testid here is `kpi-total-runs` because the
  // AgentDetailCore MOCK in this file renders `data-testid={`kpi-${k.key}`}`
  // (see the vi.mock for AgentDetailCore ~line 89). The REAL AgentHeroCard uses
  // `hero-kpi-${key}` — that surface is exercised by the e2e spec (Task 6), not
  // by this mocked unit test.
  it("labels the run KPI 'Total runs' and shows the true total beyond the page cap", async () => {
    mockGetAoaRuns.mockResolvedValue({
      runs: Array.from({ length: 50 }, (_, i) => ({ id: `r${i}` })),
      total: 137,
      limit: 50,
    });
    renderWithProviders(<AoaAgentDetail />);
    await waitFor(() => {
      expect(screen.getByTestId("kpi-total-runs")).toHaveTextContent("Total runs: 137");
    });
  });

  // total within the page (no cap hit): the KPI shows the real number, not "50+".
  it("shows the exact run total when it is below the page cap", async () => {
    mockGetAoaRuns.mockResolvedValue({
      runs: Array.from({ length: 7 }, (_, i) => ({ id: `r${i}` })),
      total: 7,
      limit: 50,
    });
    renderWithProviders(<AoaAgentDetail />);
    await waitFor(() => {
      expect(screen.getByTestId("kpi-total-runs")).toHaveTextContent("Total runs: 7");
    });
  });

  // Empty agent (never run): the KPI reads "Total runs: 0", not a blank/NaN/"50+".
  it("shows 'Total runs: 0' when the agent has no runs", async () => {
    mockGetAoaRuns.mockResolvedValue({ runs: [], total: 0, limit: 50 });
    renderWithProviders(<AoaAgentDetail />);
    await waitFor(() => {
      expect(screen.getByTestId("kpi-total-runs")).toHaveTextContent("Total runs: 0");
    });
    // Belt-and-suspenders: the old capped label must be gone everywhere.
    expect(screen.queryByTestId("kpi-recent-runs")).not.toBeInTheDocument();
    expect(screen.queryByText(/50\+/)).not.toBeInTheDocument();
  });

  // Follow-up #4: the Overview "Total runs" stat reads `total` (count(*) over
  // ALL runs), not the capped page length. Mock a page shorter than `total` to
  // prove the stat is NOT derived from runs.length.
  it("Overview 'Total runs' stat shows the true total, not the page length", async () => {
    mockGetAoaRuns.mockResolvedValue({
      runs: Array.from({ length: 50 }, (_, i) => ({ id: `r${i}` })),
      total: 212,
      limit: 50,
    });
    renderWithProviders(<AoaAgentDetail />);
    // The Overview tab is the default view. Assert the dedicated stat testid
    // renders the true total (212), not the page length (50).
    await waitFor(() => {
      expect(screen.getByTestId("aoa-overview-total-runs")).toHaveTextContent("212");
    });
    expect(screen.getByTestId("aoa-overview-total-runs")).not.toHaveTextContent("50");
  });
});

describe("AoaAgentDetail — UUID routing (kind='aoa' excluded from urlKey resolver)", () => {
  const AOA_UUID = "e9d5f695-6b38-49cf-afb3-7c986e5203ea";
  const AOA_SLUG = "discussion-extraction";

  // kind='aoa' member agent whose slug ("discussion-extraction") != its uuid.
  const aoaMember = makeAgent({
    id: AOA_UUID,
    name: "Discussion Extraction",
    role: "engineer",
    status: "active",
    kind: "aoa",
    urlKey: AOA_SLUG,
    runtimeConfig: { aoa: { role: "member" } },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockParams.agentId = AOA_UUID;
    mockParams.companyPrefix = undefined;
    mockParams.tab = undefined;
    mockCompanyContext.selectedCompanyId = "comp-1";
    mockListTriggers.mockResolvedValue([]);
    mockGetAoaRuns.mockResolvedValue({ runs: [], total: 0, limit: 50 });
    // Models the real server: by-id resolves any kind; by-slug 404s for kind='aoa'
    // (server resolveByReference is hardcoded eq(agents.kind,"org") — M1 / Decision #99).
    mockAgentsGet.mockImplementation(async (ref: string) => {
      if (ref === AOA_UUID) return aoaMember;
      throw new Error("Agent not found");
    });
  });

  it("loads a kind='aoa' agent by uuid without slug-canonicalizing the URL", async () => {
    renderWithProviders(<AoaAgentDetail />);

    // Agent loads by uuid — name renders, tabs render, no "Agent not found".
    await waitFor(() => {
      expect(screen.getByTestId("agent-name")).toHaveTextContent("Discussion Extraction");
    });
    expect(screen.getByTestId("tab-overview")).toBeInTheDocument();
    expect(screen.queryByText(/agent not found/i)).not.toBeInTheDocument();

    // The bug: a replace-navigate rewrote /team/aoa/<uuid> -> /team/aoa/discussion-extraction,
    // then the refetch-by-slug 404'd. Assert the URL is NEVER rewritten to the slug.
    expect(mockNavigate).not.toHaveBeenCalledWith(
      expect.stringContaining(AOA_SLUG),
      expect.anything(),
    );
    expect(mockNavigate).not.toHaveBeenCalledWith(`/team/aoa/${AOA_SLUG}`, { replace: true });

    // agentsApi.get must only ever be called with the uuid, never the slug.
    expect(mockAgentsGet).not.toHaveBeenCalledWith(AOA_SLUG, expect.anything());
  });
});

describe("AoaAgentDetail — founder lifecycle control (FX7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParams.agentId = "agent-aoa-1";
    mockParams.companyPrefix = undefined;
    mockParams.tab = undefined;
    mockCompanyContext.selectedCompanyId = "comp-1";
    mockTeamAccess.role = "founder";
    mockListTriggers.mockResolvedValue([]);
    mockGetAoaRuns.mockResolvedValue({ runs: [], total: 0, limit: 50 });
    mockAgentsPause.mockResolvedValue({});
    mockAgentsResume.mockResolvedValue({});
    mockAgentsTerminate.mockResolvedValue({});
  });

  it("founder + idle agent → Pause control rendered; click calls agentsApi.pause with agent id + company id", async () => {
    const user = userEvent.setup();
    mockAgentsGet.mockResolvedValue(
      makeAgent({ id: "agent-aoa-1", name: "Commander Bot", kind: "aoa", status: "idle" }),
    );

    renderWithProviders(<AoaAgentDetail />);

    const region = await screen.findByTestId("header-actions");
    const pauseBtn = await within(region).findByRole("button", { name: /pause/i });
    expect(pauseBtn).toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: /^resume$/i })).not.toBeInTheDocument();

    await user.click(pauseBtn);

    await waitFor(() => {
      expect(mockAgentsPause).toHaveBeenCalledWith("agent-aoa-1", "comp-1");
    });
    expect(mockAgentsResume).not.toHaveBeenCalled();
  });

  it("founder + paused agent → Resume control rendered; click calls agentsApi.resume", async () => {
    const user = userEvent.setup();
    mockAgentsGet.mockResolvedValue(
      makeAgent({ id: "agent-aoa-1", name: "Commander Bot", kind: "aoa", status: "paused" }),
    );

    renderWithProviders(<AoaAgentDetail />);

    const region = await screen.findByTestId("header-actions");
    const resumeBtn = await within(region).findByRole("button", { name: /resume/i });
    expect(resumeBtn).toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: /^pause$/i })).not.toBeInTheDocument();

    await user.click(resumeBtn);

    await waitFor(() => {
      expect(mockAgentsResume).toHaveBeenCalledWith("agent-aoa-1", "comp-1");
    });
    expect(mockAgentsPause).not.toHaveBeenCalled();
  });

  // FX-del: AoA agents are reserved framework agents and must NOT be
  // terminable/deletable by anyone. This supersedes the FX7
  // "Terminate action exists in overflow" test — the FX7 overflow Terminate
  // is removed (Pause/Resume kept; no Invoke). The real FX7 contracts
  // (Pause/Resume present + callable, no Invoke) stay green below/above.
  it("founder → NO Terminate affordance anywhere; agentsApi.terminate is never called (FX-del)", async () => {
    mockAgentsGet.mockResolvedValue(
      makeAgent({ id: "agent-aoa-1", name: "Commander Bot", kind: "aoa", status: "idle" }),
    );

    renderWithProviders(<AoaAgentDetail />);

    // Page rendered (founder + Pause control present establishes the control bar).
    const region = await screen.findByTestId("header-actions");
    expect(
      await within(region).findByRole("button", { name: /pause/i }),
    ).toBeInTheDocument();

    // No Terminate control / text anywhere, and the mutation is never invoked.
    expect(within(region).queryByRole("button", { name: /terminate/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /terminate/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/terminate/i)).not.toBeInTheDocument();
    expect(mockAgentsTerminate).not.toHaveBeenCalled();
  });

  it("non-founder → lifecycle control is NOT rendered", async () => {
    mockTeamAccess.role = "team_member";
    mockAgentsGet.mockResolvedValue(
      makeAgent({ id: "agent-aoa-1", name: "Commander Bot", kind: "aoa", status: "idle" }),
    );

    renderWithProviders(<AoaAgentDetail />);

    await waitFor(() => {
      expect(screen.getByTestId("agent-name")).toHaveTextContent("Commander Bot");
    });

    const region = screen.getByTestId("header-actions");
    expect(within(region).queryByRole("button", { name: /pause/i })).not.toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: /resume/i })).not.toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: /terminate/i })).not.toBeInTheDocument();
  });

  it("no Invoke affordance anywhere on the AoA detail page (FX3 runtime-boundary guard)", async () => {
    mockAgentsGet.mockResolvedValue(
      makeAgent({ id: "agent-aoa-1", name: "Commander Bot", kind: "aoa", status: "idle" }),
    );

    renderWithProviders(<AoaAgentDetail />);

    await waitFor(() => {
      expect(screen.getByTestId("agent-name")).toHaveTextContent("Commander Bot");
    });

    expect(screen.queryByRole("button", { name: /invoke/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/invoke/i)).not.toBeInTheDocument();
  });
});

describe("AoaTriggersTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.selectedCompanyId = "comp-1";
    mockListTriggers.mockResolvedValue([
      { id: "t1", kind: "outbox", enabled: true, config: { source: "discussion_entry_pending" } },
    ]);
    mockPatchTrigger.mockResolvedValue({ id: "t1", kind: "outbox", enabled: false, config: { source: "discussion_entry_pending" } });
  });

  it("Triggers tab lists triggers and toggles enabled", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <AoaTriggersTab agentId="agent-aoa-1" companyId="comp-1" />,
    );

    // Should show the trigger kind
    await waitFor(() => {
      expect(screen.getByText(/outbox/i)).toBeInTheDocument();
    });

    // Click the toggle
    const toggle = screen.getByRole("checkbox");
    await user.click(toggle);

    // patchTrigger should have been called with enabled: false
    await waitFor(() => {
      expect(mockPatchTrigger).toHaveBeenCalledWith(
        "agent-aoa-1",
        "t1",
        "comp-1",
        expect.objectContaining({ enabled: false }),
      );
    });
  });

  it("shows empty state when no triggers", async () => {
    mockListTriggers.mockResolvedValue([]);

    renderWithProviders(
      <AoaTriggersTab agentId="agent-aoa-1" companyId="comp-1" />,
    );

    await waitFor(() => {
      expect(screen.getByText(/no triggers/i)).toBeInTheDocument();
    });
  });
});
