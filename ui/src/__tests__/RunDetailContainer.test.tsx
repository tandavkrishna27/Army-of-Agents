import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders, makeAgent, mockCompanyContext } from "./test-utils";

// --- Mocks ---

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useParams: () => ({}),
    Link: actual.Link,
    NavLink: actual.NavLink,
    useBeforeUnload: vi.fn(),
  };
});

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => mockCompanyContext,
}));

const mockAgentsGet = vi.fn();
vi.mock("../api/agents", () => ({
  agentsApi: {
    get: (...args: any[]) => mockAgentsGet(...args),
  },
}));

const mockHeartbeatsList = vi.fn();
vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: {
    list: (...args: any[]) => mockHeartbeatsList(...args),
  },
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    agents: { detail: (id: string) => ["agents", "detail", id] },
    heartbeats: (companyId: string, agentId?: string) => ["heartbeats", companyId, agentId],
  },
}));

vi.mock("../lib/utils", () => ({
  agentRouteRef: (a: any) => a?.urlKey ?? a?.id ?? "",
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div data-testid="page-skeleton">Loading...</div>,
}));

// Stub RunDetail (exported in-place from AgentDetail) — capture the props it
// receives so we can assert the container found + forwarded the right run.
const runDetailProps = vi.fn();
vi.mock("../pages/AgentDetail", () => ({
  RunDetail: (props: any) => {
    runDetailProps(props);
    return <div data-testid="run-detail">run:{props.run?.id} adapter:{props.adapterType} route:{props.agentRouteId}</div>;
  },
}));

// --- Import after mocks ---
import { RunDetailContainer } from "../components/agent-detail/RunDetailContainer";

const agent = makeAgent({ id: "agent-9", urlKey: "worker-bee", adapterType: "codex_local", companyId: "comp-1" });

const runRow = (id: string) => ({
  id,
  companyId: "comp-1",
  agentId: "agent-9",
  status: "succeeded",
  createdAt: new Date().toISOString(),
});

describe("RunDetailContainer (D4b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.selectedCompanyId = "comp-1";
    mockAgentsGet.mockResolvedValue(agent);
    mockHeartbeatsList.mockResolvedValue([runRow("run-A"), runRow("run-B")]);
  });

  it("finds the run in the agent's run list and renders RunDetail with it", async () => {
    const onOpenIssue = vi.fn();
    renderWithProviders(
      <RunDetailContainer
        runId="run-B"
        agentId="agent-9"
        companyId="comp-1"
        onOpenIssue={onOpenIssue}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("run-detail")).toBeInTheDocument();
    });
    // The run list is fetched by (companyId, agentId).
    expect(mockHeartbeatsList).toHaveBeenCalledWith("comp-1", "agent-9");

    // The found run + derived adapterType/route are forwarded to RunDetail.
    await waitFor(() => {
      expect(runDetailProps).toHaveBeenCalledWith(
        expect.objectContaining({
          run: expect.objectContaining({ id: "run-B" }),
          adapterType: "codex_local",
          agentRouteId: "worker-bee",
          onOpenIssue,
        }),
      );
    });
  });

  it("renders the run-not-found fallback when the run id is not in the list", async () => {
    renderWithProviders(
      <RunDetailContainer runId="run-MISSING" agentId="agent-9" companyId="comp-1" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("hub-run-not-found")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("run-detail")).not.toBeInTheDocument();
    expect(screen.getByText(/run not found/i)).toBeInTheDocument();
  });

  it("renders the fallback (never crashes) when the run list comes back empty", async () => {
    mockHeartbeatsList.mockResolvedValue([]);
    renderWithProviders(
      <RunDetailContainer runId="run-A" agentId="agent-9" companyId="comp-1" />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("hub-run-not-found")).toBeInTheDocument();
    });
  });
});
