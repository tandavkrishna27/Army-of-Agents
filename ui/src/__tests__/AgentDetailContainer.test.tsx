import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders, makeAgent, mockCompanyContext } from "./test-utils";

// --- Mocks ---

// useParams must NEVER be read by the container (it is prop-driven). Spy on it so
// the "does not read useParams" contract is directly assertable.
const useParamsSpy = vi.fn(() => ({}));

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useParams: () => useParamsSpy(),
    useNavigate: () => vi.fn(),
    Link: actual.Link,
    NavLink: actual.NavLink,
    useBeforeUnload: vi.fn(),
  };
});

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => mockCompanyContext,
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

// Stub the whole AgentDetail page module: the container imports the shared hook
// + the exported tab-body helpers from it. Stubbing keeps this a focused unit
// test of the container's orchestration (no charts/forms/adapters pulled in).
const mockUseAgentDetailData = vi.fn();
vi.mock("../pages/AgentDetail", () => ({
  useAgentDetailData: (...args: any[]) => mockUseAgentDetailData(...args),
  AgentOverview: () => <div data-testid="agent-overview">Overview</div>,
  AgentConfigurePage: () => <div data-testid="agent-configure">Configure</div>,
  RunsTab: (props: any) => <div data-testid="runs-tab">Runs:{props.runs?.length ?? 0}</div>,
}));

vi.mock("../components/agent-detail/AgentDetailCore", () => ({
  AgentDetailCore: ({ agent, tabs, activeView, renderTab, heroKpis, heroBadges }: any) => (
    <div data-testid="agent-detail-core">
      <h1 data-testid="agent-name">{agent?.name}</h1>
      <div data-testid="hero-adapter">{heroBadges?.adapter}</div>
      <div data-testid="hero-kpis">
        {heroKpis?.map((k: any) => (
          <span key={k.key} data-testid={`kpi-${k.key}`}>{k.label}:{String(k.value)}</span>
        ))}
      </div>
      <div data-testid="tabs">
        {tabs?.map((t: any) => <span key={t.value} data-testid={`tab-${t.value}`}>{t.label}</span>)}
      </div>
      <div data-testid="tab-content">{renderTab(activeView)}</div>
    </div>
  ),
}));

vi.mock("../components/AgentInstructionsTab", () => ({
  AgentInstructionsTab: () => <div data-testid="instructions-tab">Instructions</div>,
}));

vi.mock("../components/agent-detail/AgentSkillsTab", () => ({
  AgentSkillsTab: () => <div data-testid="skills-tab">Skills</div>,
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div data-testid="page-skeleton">Loading...</div>,
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    update: vi.fn().mockResolvedValue({}),
    updatePermissions: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    agents: {
      detail: (id: string) => ["agents", "detail", id],
      list: (id: string) => ["agents", id],
    },
  },
}));

// --- Import after mocks ---
import { AgentDetailContainer } from "../components/agent-detail/AgentDetailContainer";

const agent = makeAgent({ id: "agent-9", name: "Worker Bee", adapterType: "claude_local" });

function baseData(overrides: Record<string, any> = {}) {
  return {
    agent,
    isLoading: false,
    error: null,
    resolvedCompanyId: "comp-1",
    canonicalAgentRef: "worker-bee",
    agentLookupRef: "agent-9",
    runtimeState: undefined,
    heartbeats: [],
    assignedIssues: [],
    reportsToAgent: null,
    directReports: [],
    trustScore: null,
    mobileLiveRun: null,
    ...overrides,
  };
}

describe("AgentDetailContainer (D4a)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useParamsSpy.mockReturnValue({});
    mockCompanyContext.selectedCompanyId = "comp-1";
    mockUseAgentDetailData.mockReturnValue(baseData());
  });

  it("renders AgentDetailCore with the agent resolved from the agentId PROP", async () => {
    renderWithProviders(<AgentDetailContainer agentId="agent-9" companyId="comp-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("agent-detail-core")).toBeInTheDocument();
    });
    expect(screen.getByTestId("agent-name")).toHaveTextContent("Worker Bee");
    expect(screen.getByTestId("hero-adapter")).toHaveTextContent("claude_local");

    // The hook is keyed on the PROP agentId, not any route param.
    expect(mockUseAgentDetailData).toHaveBeenCalledWith(
      expect.objectContaining({ agentRef: "agent-9", lookupCompanyId: "comp-1" }),
    );
  });

  it("does NOT read useParams (prop-driven, not route-driven)", async () => {
    renderWithProviders(<AgentDetailContainer agentId="agent-9" companyId="comp-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("agent-detail-core")).toBeInTheDocument();
    });
    expect(useParamsSpy).not.toHaveBeenCalled();
  });

  it("renders all five tabs and the overview tab body by default", async () => {
    renderWithProviders(<AgentDetailContainer agentId="agent-9" />);

    await waitFor(() => {
      expect(screen.getByTestId("tab-overview")).toBeInTheDocument();
    });
    expect(screen.getByTestId("tab-instructions")).toBeInTheDocument();
    expect(screen.getByTestId("tab-runs")).toBeInTheDocument();
    expect(screen.getByTestId("tab-skills")).toBeInTheDocument();
    expect(screen.getByTestId("tab-configure")).toBeInTheDocument();
    // Default active view is overview.
    expect(screen.getByTestId("agent-overview")).toBeInTheDocument();
  });

  it("computes hero KPIs (tasks/success/cost/trust/last-run/last-heartbeat)", async () => {
    renderWithProviders(<AgentDetailContainer agentId="agent-9" />);
    await waitFor(() => {
      expect(screen.getByTestId("kpi-tasks")).toBeInTheDocument();
    });
    expect(screen.getByTestId("kpi-success")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-cost")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-trust")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-last-run")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-last-heartbeat")).toBeInTheDocument();
  });

  it("shows the skeleton while loading", () => {
    mockUseAgentDetailData.mockReturnValue(baseData({ isLoading: true, agent: undefined }));
    renderWithProviders(<AgentDetailContainer agentId="agent-9" />);
    expect(screen.getByTestId("page-skeleton")).toBeInTheDocument();
  });

  it("shows the error message when the agent query errors", () => {
    mockUseAgentDetailData.mockReturnValue(
      baseData({ error: new Error("boom"), agent: undefined }),
    );
    renderWithProviders(<AgentDetailContainer agentId="agent-9" />);
    expect(screen.getByText("boom")).toBeInTheDocument();
  });
});
