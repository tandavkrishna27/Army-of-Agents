import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { CreateAgents } from "../CreateAgents";
import { getAdapterLabel } from "@/adapters";
import { ENGINEER_AGENT } from "@/__tests__/__fixtures__/marketplace-catalog";
import type { CatalogItem } from "@armyofagents/shared";

const projectsList = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const assignAgent = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })));
vi.mock("../../../api/projects", () => ({
  projectsApi: { list: projectsList, assignAgent },
}));

const agentsList = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const agentsPause = vi.hoisted(() => vi.fn(async () => ({ status: "paused" })));
const agentsCreate = vi.hoisted(() =>
  vi.fn(async (_companyId: string, data: Record<string, unknown>) => ({
    id: `agent-${(data.name as string).toLowerCase().replace(/\s+/g, "-")}`,
    kind: "org",
    name: data.name,
  })),
);
vi.mock("../../../api/agents", () => ({
  agentsApi: { list: agentsList, create: agentsCreate, pause: agentsPause },
}));

const getCatalog = vi.hoisted(() =>
  vi.fn(async () => ({ schemaVersion: "1", generatedAt: "now", itemCount: 0, items: [] })),
);
vi.mock("../../../api/marketplace", async () => {
  const actual = await vi.importActual<typeof import("../../../api/marketplace")>("../../../api/marketplace");
  return {
    ...actual,
    marketplaceApi: { ...actual.marketplaceApi, getCatalog },
  };
});

// This surface is domain-only — like DefineDepartments/IntegrationsStep — and
// must never call advanceOnboarding. Mocked as a regression guard.
const advanceOnboarding = vi.hoisted(() => vi.fn());
vi.mock("../../../api/onboarding", () => ({ advanceOnboarding }));

type ModalProps = {
  item: CatalogItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lockedCompanyId?: string;
  lockedDeptId?: string;
  onInstalled?: () => void;
};
vi.mock("@/components/marketplace/install/SnapshotInstallModal", () => ({
  SnapshotInstallModal: (props: ModalProps) => {
    if (!props.open) return null;
    return (
      <div data-testid="mock-install-modal">
        <span data-testid="modal-item-name">{props.item.name}</span>
        <span data-testid="modal-locked-company">{props.lockedCompanyId}</span>
        <span data-testid="modal-locked-dept">{props.lockedDeptId}</span>
        <button type="button" onClick={() => props.onOpenChange(false)}>
          cancel-install
        </button>
        <button
          type="button"
          onClick={() => {
            props.onInstalled?.();
            props.onOpenChange(false);
          }}
        >
          confirm-install
        </button>
      </div>
    );
  },
}));

function makeDept(overrides: Record<string, unknown> = {}) {
  return { id: "dept-1", name: "Software", type: "department", ...overrides };
}

describe("CreateAgents (WS7 — In-flight standalone surface)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectsList.mockResolvedValue([makeDept()]);
    agentsList.mockResolvedValue([]);
    getCatalog.mockResolvedValue({ schemaVersion: "1", generatedAt: "now", itemCount: 0, items: [] });
  });

  it("renders a per-department create form defaulting to a dept-derived agent name and an adapter picker", async () => {
    render(<CreateAgents companyId="c1" onDone={vi.fn()} />);
    expect(await screen.findByDisplayValue("Software Lead")).toBeTruthy();
    expect(screen.getByRole("button", { name: getAdapterLabel("claude_local") })).toBeTruthy();
    expect(screen.getByRole("button", { name: getAdapterLabel("codex_local") })).toBeTruthy();
  });

  it("creates the agent with the chosen adapter and assigns it to the department, with no onboarding-state advance", async () => {
    const onDone = vi.fn();
    render(<CreateAgents companyId="c1" onDone={onDone} />);
    await screen.findByDisplayValue("Software Lead");

    fireEvent.click(screen.getByRole("button", { name: getAdapterLabel("codex_local") }));
    fireEvent.click(screen.getByRole("button", { name: "Create & assign" }));

    await waitFor(() => expect(assignAgent).toHaveBeenCalled());
    expect(agentsCreate).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ name: "Software Lead", role: "lead", adapterType: "codex_local" }),
    );
    expect(assignAgent).toHaveBeenCalledWith("dept-1", "agent-software-lead", "c1");
    expect((await screen.findAllByText("Created")).length).toBeGreaterThan(0);
    expect(advanceOnboarding).not.toHaveBeenCalled();
  });

  it("creates cloud agents paused until an E2B environment is attached", async () => {
    render(<CreateAgents companyId="c1" deploymentMode="cloud_auth" onDone={vi.fn()} />);
    await screen.findByDisplayValue("Software Lead");

    expect(screen.getByText(/attach an e2b environment before enabling them/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create & assign" }));

    await waitFor(() => expect(agentsCreate).toHaveBeenCalled());
    expect(agentsCreate).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        runtimeConfig: expect.objectContaining({
          heartbeat: expect.objectContaining({ enabled: false, wakeOnDemand: false }),
        }),
      }),
    );
    await waitFor(() => expect(agentsPause).toHaveBeenCalledWith("agent-software-lead", "c1"));
    expect(agentsPause.mock.invocationCallOrder[0]).toBeLessThan(assignAgent.mock.invocationCallOrder[0]!);
    expect(screen.queryByRole("button", { name: "Pick from marketplace" })).not.toBeInTheDocument();
  });

  it("is idempotent — reuses an existing same-named org agent instead of creating a new one", async () => {
    agentsList.mockResolvedValue([{ id: "existing-agent", kind: "org", name: "Software Lead" }]);
    render(<CreateAgents companyId="c1" onDone={vi.fn()} />);
    await screen.findByDisplayValue("Software Lead");

    fireEvent.click(screen.getByRole("button", { name: "Create & assign" }));

    await waitFor(() => expect(assignAgent).toHaveBeenCalledWith("dept-1", "existing-agent", "c1"));
    expect(agentsCreate).not.toHaveBeenCalled();
  });

  it("all departments created fires onDone exactly once, even with a single department", async () => {
    const onDone = vi.fn();
    render(<CreateAgents companyId="c1" onDone={onDone} />);
    await screen.findByDisplayValue("Software Lead");

    fireEvent.click(screen.getByRole("button", { name: "Create & assign" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("marketplace path: selecting a catalog item and clicking Install selected opens the modal locked to this company+department", async () => {
    getCatalog.mockResolvedValue({ schemaVersion: "1", generatedAt: "now", itemCount: 1, items: [ENGINEER_AGENT] });
    render(<CreateAgents companyId="c1" onDone={vi.fn()} />);
    await screen.findByDisplayValue("Software Lead");

    fireEvent.click(screen.getByRole("button", { name: "Pick from marketplace" }));
    fireEvent.click(await screen.findByText("Engineer"));
    fireEvent.click(screen.getByRole("button", { name: "Install selected" }));

    const modal = await screen.findByTestId("mock-install-modal");
    expect(within(modal).getByTestId("modal-item-name")).toHaveTextContent("Engineer");
    expect(within(modal).getByTestId("modal-locked-company")).toHaveTextContent("c1");
    expect(within(modal).getByTestId("modal-locked-dept")).toHaveTextContent("dept-1");
  });

  it("marketplace picker hides the AoA crew (aoa-* agents + the standard-crew team) but keeps regular agents", async () => {
    const crewAgent = {
      ...ENGINEER_AGENT,
      id: "agent:aoa-curated/aoa-scout",
      name: "Scout",
      source: { ...ENGINEER_AGENT.source, adapter: "aoa-curated", locator: "content/agents/aoa-scout" },
    } as CatalogItem;
    const crewTeam = {
      ...ENGINEER_AGENT,
      id: "team:aoa-curated/default-crew",
      type: "team",
      name: "Standard Crew",
      source: { ...ENGINEER_AGENT.source, adapter: "aoa-curated", locator: "content/teams/default-crew" },
    } as CatalogItem;
    getCatalog.mockResolvedValue({
      schemaVersion: "1",
      generatedAt: "now",
      itemCount: 3,
      items: [crewAgent, crewTeam, ENGINEER_AGENT],
    });
    render(<CreateAgents companyId="c1" onDone={vi.fn()} />);
    await screen.findByDisplayValue("Software Lead");

    fireEvent.click(screen.getByRole("button", { name: "Pick from marketplace" }));

    // Regular agent is offered…
    expect(await screen.findByText("Engineer")).toBeInTheDocument();
    // …the crew agent + crew team are filtered out.
    expect(screen.queryByText("Scout")).not.toBeInTheDocument();
    expect(screen.queryByText("Standard Crew")).not.toBeInTheDocument();
  });

  it("confirming the marketplace install marks the department created and fires onDone (no direct agent-create call)", async () => {
    getCatalog.mockResolvedValue({ schemaVersion: "1", generatedAt: "now", itemCount: 1, items: [ENGINEER_AGENT] });
    const onDone = vi.fn();
    render(<CreateAgents companyId="c1" onDone={onDone} />);
    await screen.findByDisplayValue("Software Lead");

    fireEvent.click(screen.getByRole("button", { name: "Pick from marketplace" }));
    fireEvent.click(await screen.findByText("Engineer"));
    fireEvent.click(screen.getByRole("button", { name: "Install selected" }));
    fireEvent.click(await screen.findByText("confirm-install"));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect((await screen.findAllByText("Created")).length).toBeGreaterThan(0);
    expect(agentsCreate).not.toHaveBeenCalled();
  });

  it("cancelling the marketplace modal does not mark the department created or fire onDone", async () => {
    getCatalog.mockResolvedValue({ schemaVersion: "1", generatedAt: "now", itemCount: 1, items: [ENGINEER_AGENT] });
    const onDone = vi.fn();
    render(<CreateAgents companyId="c1" onDone={onDone} />);
    await screen.findByDisplayValue("Software Lead");

    fireEvent.click(screen.getByRole("button", { name: "Pick from marketplace" }));
    fireEvent.click(await screen.findByText("Engineer"));
    fireEvent.click(screen.getByRole("button", { name: "Install selected" }));
    fireEvent.click(await screen.findByText("cancel-install"));

    expect(onDone).not.toHaveBeenCalled();
    expect(screen.queryByText("Created")).toBeNull();
  });

  it("Skip fires onDone immediately without creating or assigning anything", async () => {
    const onDone = vi.fn();
    render(<CreateAgents companyId="c1" onDone={onDone} />);
    await screen.findByDisplayValue("Software Lead");

    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(agentsCreate).not.toHaveBeenCalled();
    expect(assignAgent).not.toHaveBeenCalled();
  });

  it("fires onDone only once all departments have an agent (mixed create + marketplace paths across two departments)", async () => {
    projectsList.mockResolvedValue([makeDept({ id: "dept-1", name: "Software" }), makeDept({ id: "dept-2", name: "Marketing" })]);
    getCatalog.mockResolvedValue({ schemaVersion: "1", generatedAt: "now", itemCount: 1, items: [ENGINEER_AGENT] });
    const onDone = vi.fn();
    render(<CreateAgents companyId="c1" onDone={onDone} />);
    await screen.findByDisplayValue("Software Lead");
    await screen.findByDisplayValue("Marketing Lead");

    const dept1Card = screen.getByTestId("dept-card-dept-1");
    const dept2Card = screen.getByTestId("dept-card-dept-2");

    fireEvent.click(within(dept1Card).getByRole("button", { name: "Create & assign" }));
    await waitFor(() => expect(assignAgent).toHaveBeenCalledWith("dept-1", expect.any(String), "c1"));
    expect(onDone).not.toHaveBeenCalled();

    fireEvent.click(within(dept2Card).getByRole("button", { name: "Pick from marketplace" }));
    fireEvent.click(within(dept2Card).getByText("Engineer"));
    fireEvent.click(within(dept2Card).getByRole("button", { name: "Install selected" }));
    fireEvent.click(await within(dept2Card).findByText("confirm-install"));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("Skip is available even before any department has an agent, and a subsequent load error doesn't crash the surface", async () => {
    projectsList.mockRejectedValueOnce(new Error("network down"));
    render(<CreateAgents companyId="c1" onDone={vi.fn()} />);
    expect(await screen.findByText(/network down/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeTruthy();
  });
});
