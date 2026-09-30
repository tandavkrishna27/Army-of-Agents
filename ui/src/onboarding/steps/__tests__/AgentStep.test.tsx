import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AgentStep } from "../AgentStep";
import { validateRegistry, type StepContext } from "../../registry";
import { ONBOARDING_STEPS } from "../index";

const agentsList = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const agentsCreate = vi.hoisted(() => vi.fn(async () => ({ id: "a1" })));
const projectsList = vi.hoisted(() =>
  vi.fn(async () => [{ id: "d1", type: "department", name: "Engineering" }] as unknown[]),
);
const assignAgent = vi.hoisted(() => vi.fn(async () => ({})));
const getConfig = vi.hoisted(() => vi.fn(async () => ({ cliTool: "codex" })));

vi.mock("../../../api/agents", () => ({ agentsApi: { list: agentsList, create: agentsCreate } }));
vi.mock("../../../api/projects", () => ({ projectsApi: { list: projectsList, assignAgent } }));
vi.mock("../../../api/internal-agent", () => ({ internalAgentApi: { getConfig } }));
vi.mock("../../../api/onboarding", () => ({
  advanceOnboarding: vi.fn(async () => ({ completedStates: [] })),
}));

import { advanceOnboarding } from "../../../api/onboarding";

const ctx: StepContext = {
  userId: "u1",
  companyId: "c1",
  journey: "founder",
  completedStates: [
    "AUTHENTICATED",
    "PROFILE_SET",
    "ORGANIZATION_CREATED",
    "ENVIRONMENT_READY",
    "COMMANDER_SELECTED",
    "COMMANDER_VERIFIED",
    "DEPARTMENT_CREATED",
  ],
};

describe("AgentStep (Stage C / order 7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentsList.mockResolvedValue([]);
    agentsCreate.mockResolvedValue({ id: "a1" });
    projectsList.mockResolvedValue([{ id: "d1", type: "department", name: "Engineering" }]);
    getConfig.mockResolvedValue({ cliTool: "codex" });
  });

  it("creates an agent inheriting the Commander runtime, assigns it to the department, advances", async () => {
    const onComplete = vi.fn();
    render(<AgentStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    // department preselect must resolve before create is allowed
    await waitFor(() =>
      expect((screen.getByText("Create & assign").closest("button") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByText("Create & assign"));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    // codex cliTool → codex_local adapter (inherited)
    expect(agentsCreate).toHaveBeenCalledWith("c1", expect.objectContaining({ adapterType: "codex_local" }));
    // FIX: assigned to the department at creation
    expect(assignAgent).toHaveBeenCalledWith("d1", "a1", "c1");
    expect(advanceOnboarding).toHaveBeenCalledWith({
      companyId: "c1",
      journey: "founder",
      requestedState: "AGENT_ASSIGNED",
    });
  });

  it("shows the inherited Commander runtime in the happy path (transparency)", async () => {
    getConfig.mockResolvedValue({ cliTool: "codex" });
    render(<AgentStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    // The founder can SEE what the agent runs on — the question they raised.
    // No hardcoded model name: the server injects its own default at create
    // time, and copy pinned to a model string drifts.
    expect(await screen.findByText(/Codex \(your account's default model\)/)).toBeTruthy();
  });

  it("keeps Create disabled + offers a retry when the Commander config fails to load", async () => {
    // The race: a swallowed getConfig failure used to leave the guessed
    // claude_local default, so a Codex founder could mint a claude_local agent
    // that fails at first run. Now we block until the real runtime resolves.
    getConfig.mockRejectedValueOnce(new Error("boom"));
    render(<AgentStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    expect(await screen.findByText(/Couldn't load your Commander runtime/)).toBeTruthy();
    expect(
      (screen.getByText("Create & assign").closest("button") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("is idempotent — reuses an existing same-named org agent, still assigns it", async () => {
    agentsList.mockResolvedValue([{ id: "existing", kind: "org", name: "Director" }]);
    const onComplete = vi.fn();
    render(<AgentStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    await waitFor(() =>
      expect((screen.getByText("Create & assign").closest("button") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByText("Create & assign"));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(agentsCreate).not.toHaveBeenCalled();
    expect(assignAgent).toHaveBeenCalledWith("d1", "existing", "c1");
  });
});

describe("assembled registry (WS0c: AgentStep is no longer a wizard step)", () => {
  it("passes the guard, and AGENT_ASSIGNED/AgentStep are no longer registered — the founder wizard ends at the spine (SETUP_COMPLETE); Home owns the agent tail", () => {
    expect(validateRegistry(ONBOARDING_STEPS)).toEqual([]);
    expect(ONBOARDING_STEPS.find((s) => s.state === "AGENT_ASSIGNED")).toBeUndefined();
    expect(ONBOARDING_STEPS.find((s) => s.id === "agent")).toBeUndefined();
  });
});
