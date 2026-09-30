import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../../../__tests__/test-utils";
import { AgentSkillsTab } from "../AgentSkillsTab";
import { agentsApi } from "../../../api/agents";
import { companySkillsApi } from "../../../api/companySkills";
import { ApiError } from "../../../api/client";

vi.mock("../../../api/agents", () => ({ agentsApi: { update: vi.fn() } }));
vi.mock("../../../api/companySkills", () => ({ companySkillsApi: { list: vi.fn() } }));

const { pushToast } = vi.hoisted(() => ({ pushToast: vi.fn() }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast }) }));

const skills = [
  { id: "s-a", key: "skill-a", name: "Skill A", description: "first" },
  { id: "s-b", key: "skill-b", name: "Skill B", description: "second" },
];

const row = (name: string) => screen.getByText(name).closest('[role="button"]') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(companySkillsApi.list).mockResolvedValue(skills as never);
});

describe("AgentSkillsTab — concurrency guard", () => {
  it("locks every row while a toggle is in flight so overlapping updates can't race", async () => {
    // First PATCH never resolves → the toggle stays in flight (busy).
    vi.mocked(agentsApi.update).mockReturnValue(new Promise(() => {}) as never);

    renderWithProviders(<AgentSkillsTab agentId="a1" companyId="c1" skillKeys={[]} />);
    await screen.findByText("Skill A");

    // Toggle A → exactly one update fires and the tab enters the busy state.
    fireEvent.click(row("Skill A"));
    await waitFor(() => expect(agentsApi.update).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(row("Skill B")).toHaveAttribute("aria-disabled", "true"));

    // While A is still saving, clicking B must NOT fire a second (racing) update.
    fireEvent.click(row("Skill B"));
    await new Promise((r) => setTimeout(r, 0));
    expect(agentsApi.update).toHaveBeenCalledTimes(1);
  });

  it("sends the full skillKeys array on toggle (attach)", async () => {
    vi.mocked(agentsApi.update).mockResolvedValue({} as never);

    renderWithProviders(<AgentSkillsTab agentId="a1" companyId="c1" skillKeys={[]} />);
    await screen.findByText("Skill A");

    fireEvent.click(row("Skill A"));
    await waitFor(() => expect(agentsApi.update).toHaveBeenCalledTimes(1));
    expect(agentsApi.update).toHaveBeenCalledWith("a1", { skillKeys: ["skill-a"] });
  });

  it("does not clobber an optimistic toggle when an unrelated refetch lands mid-save", async () => {
    // PATCH never resolves → the toggle stays in flight (busy).
    vi.mocked(agentsApi.update).mockReturnValue(new Promise(() => {}) as never);

    const { rerender } = renderWithProviders(
      <AgentSkillsTab agentId="a1" companyId="c1" skillKeys={[]} />,
    );
    await screen.findByText("Skill A");

    fireEvent.click(row("Skill A"));
    await waitFor(() => expect(row("Skill A")).toHaveAttribute("aria-pressed", "true"));

    // A parent refetch lands mid-save with a different attached set. The resync
    // guard must NOT overwrite the in-flight optimistic toggle.
    rerender(<AgentSkillsTab agentId="a1" companyId="c1" skillKeys={["skill-b"]} />);
    expect(row("Skill A")).toHaveAttribute("aria-pressed", "true");
  });

  it("resyncs from props when idle (external change to the attached set)", async () => {
    renderWithProviders(
      <AgentSkillsTab agentId="a1" companyId="c1" skillKeys={[]} />,
    ).rerender(<AgentSkillsTab agentId="a1" companyId="c1" skillKeys={["skill-a"]} />);

    await waitFor(() => expect(row("Skill A")).toHaveAttribute("aria-pressed", "true"));
  });

  it("rolls a failed toggle back to the freshest server state, not a stale snapshot", async () => {
    // PATCH we can reject on demand.
    let reject!: (e: unknown) => void;
    vi.mocked(agentsApi.update).mockReturnValue(
      new Promise((_, r) => { reject = r; }) as never,
    );

    const { rerender } = renderWithProviders(
      <AgentSkillsTab agentId="a1" companyId="c1" skillKeys={[]} />,
    );
    await screen.findByText("Skill A");

    fireEvent.click(row("Skill A")); // optimistic [skill-a], in flight
    await waitFor(() => expect(row("Skill A")).toHaveAttribute("aria-pressed", "true"));

    // An external change lands mid-save (agent now has skill-b, set elsewhere).
    rerender(<AgentSkillsTab agentId="a1" companyId="c1" skillKeys={["skill-b"]} />);
    expect(row("Skill A")).toHaveAttribute("aria-pressed", "true"); // guard holds during flight

    // The PATCH now fails: rollback must land on the fresh server state ([skill-b]),
    // not the stale pre-toggle snapshot ([]).
    reject(new Error("boom"));
    await waitFor(() => expect(row("Skill B")).toHaveAttribute("aria-pressed", "true"));
    expect(row("Skill A")).toHaveAttribute("aria-pressed", "false");
  });

  // Codex P2: an attached key whose library skill was deleted must stay visible and
  // removable — otherwise it's invisible but rides along in every PATCH.
  it("surfaces an attached skill key missing from the library and lets it be removed", async () => {
    vi.mocked(agentsApi.update).mockResolvedValue({} as never);

    renderWithProviders(
      <AgentSkillsTab agentId="a1" companyId="c1" skillKeys={["ghost-skill", "skill-a"]} />,
    );
    await screen.findByText("Skill A");

    // The orphan key is shown (by key) with an "unavailable" marker.
    expect(screen.getByText("ghost-skill")).toBeInTheDocument();
    expect(screen.getByText(/unavailable/i)).toBeInTheDocument();

    // Toggling it off PATCHes without the orphan key (drops it from the agent).
    fireEvent.click(screen.getByText("ghost-skill").closest('[role="button"]') as HTMLElement);
    await waitFor(() => expect(agentsApi.update).toHaveBeenCalledWith("a1", { skillKeys: ["skill-a"] }));
  });

  // Codex P2: after a successful toggle, the rollback baseline must advance to the
  // saved set — otherwise a later failed toggle (before the refetch lands) rolls back
  // to the stale initial value and drops the earlier success.
  it("keeps an earlier successful toggle when a later toggle fails before refetch", async () => {
    vi.mocked(agentsApi.update)
      .mockResolvedValueOnce({} as never) // toggle A succeeds
      .mockRejectedValueOnce(new Error("boom")); // toggle B fails

    renderWithProviders(<AgentSkillsTab agentId="a1" companyId="c1" skillKeys={[]} />);
    await screen.findByText("Skill A");

    fireEvent.click(row("Skill A"));
    await waitFor(() => expect(agentsApi.update).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(row("Skill A")).toHaveAttribute("aria-pressed", "true"));

    fireEvent.click(row("Skill B"));
    await waitFor(() => expect(agentsApi.update).toHaveBeenCalledTimes(2));

    // B's failure rolls back to the confirmed-saved set ([skill-a]), not the stale [].
    await waitFor(() => expect(row("Skill B")).toHaveAttribute("aria-pressed", "false"));
    expect(row("Skill A")).toHaveAttribute("aria-pressed", "true");
  });

  // Codex P2: the empty-library early return must not hide orphaned keys — otherwise
  // an agent with stale keys + an empty library has no row to toggle off.
  it("surfaces orphaned keys even when the company library is empty", async () => {
    vi.mocked(companySkillsApi.list).mockResolvedValueOnce([] as never); // empty library
    vi.mocked(agentsApi.update).mockResolvedValue({} as never);

    renderWithProviders(<AgentSkillsTab agentId="a1" companyId="c1" skillKeys={["ghost-skill"]} />);

    // Not the bare "No skills available" state — the orphan is shown and removable.
    expect(await screen.findByText("ghost-skill")).toBeInTheDocument();
    expect(screen.getByText(/unavailable/i)).toBeInTheDocument();

    fireEvent.click(screen.getByText("ghost-skill").closest('[role="button"]') as HTMLElement);
    await waitFor(() => expect(agentsApi.update).toHaveBeenCalledWith("a1", { skillKeys: [] }));
  });

  // Codex P2: the server rejects ANY unknown key, so a toggle's payload must exclude
  // ALL orphans (not just the one clicked) or the whole save 422s.
  it("excludes every orphan key from the payload, not just the one removed", async () => {
    vi.mocked(agentsApi.update).mockResolvedValue({} as never);

    renderWithProviders(
      <AgentSkillsTab agentId="a1" companyId="c1" skillKeys={["ghost-1", "ghost-2", "skill-a"]} />,
    );
    await screen.findByText("Skill A");
    expect(screen.getByText("ghost-1")).toBeInTheDocument();
    expect(screen.getByText("ghost-2")).toBeInTheDocument();

    // Removing one orphan PATCHes with only the valid key — no orphan survives to 422.
    fireEvent.click(screen.getByText("ghost-1").closest('[role="button"]') as HTMLElement);
    await waitFor(() => expect(agentsApi.update).toHaveBeenCalledWith("a1", { skillKeys: ["skill-a"] }));
  });

  // Follow-up #3: optimistic-concurrency token (Decision #104).
  it("includes expectedUpdatedAt in the payload when the prop is provided", async () => {
    vi.mocked(agentsApi.update).mockResolvedValue({} as never);
    renderWithProviders(
      <AgentSkillsTab agentId="a1" companyId="c1" skillKeys={[]} expectedUpdatedAt="2026-06-25T12:00:00.000Z" />,
    );
    await screen.findByText("Skill A");
    fireEvent.click(row("Skill A"));
    await waitFor(() => expect(agentsApi.update).toHaveBeenCalledTimes(1));
    expect(agentsApi.update).toHaveBeenCalledWith("a1", {
      skillKeys: ["skill-a"],
      expectedUpdatedAt: "2026-06-25T12:00:00.000Z",
    });
  });

  it("on a 409, rolls back and toasts 'changed elsewhere'", async () => {
    vi.mocked(agentsApi.update).mockRejectedValue(
      new ApiError("changed", 409, { error: "changed", details: { currentUpdatedAt: "…" } }),
    );
    renderWithProviders(
      <AgentSkillsTab agentId="a1" companyId="c1" skillKeys={[]} expectedUpdatedAt="2026-06-25T12:00:00.000Z" />,
    );
    await screen.findByText("Skill A");
    fireEvent.click(row("Skill A"));
    await waitFor(() => expect(pushToast).toHaveBeenCalled());
    // optimistic toggle rolled back
    expect(row("Skill A")).toHaveAttribute("aria-pressed", "false");
  });

  it("back-compat: no expectedUpdatedAt prop → payload omits the token", async () => {
    vi.mocked(agentsApi.update).mockResolvedValue({} as never);
    renderWithProviders(<AgentSkillsTab agentId="a1" companyId="c1" skillKeys={[]} />);
    await screen.findByText("Skill A");
    fireEvent.click(row("Skill A"));
    await waitFor(() => expect(agentsApi.update).toHaveBeenCalledWith("a1", { skillKeys: ["skill-a"] }));
  });

  it("two sequential toggles before any refetch send the FRESH token on the second call (no self-409)", async () => {
    // First update returns an ADVANCED updatedAt; the component must send THAT on
    // the next toggle, not the stale prop, so it can't 409 against its own write.
    vi.mocked(agentsApi.update)
      .mockResolvedValueOnce({ updatedAt: "2026-06-25T12:00:01.000Z" } as never)
      .mockResolvedValueOnce({ updatedAt: "2026-06-25T12:00:02.000Z" } as never);
    renderWithProviders(
      <AgentSkillsTab agentId="a1" companyId="c1" skillKeys={[]} expectedUpdatedAt="2026-06-25T12:00:00.000Z" />,
    );
    await screen.findByText("Skill A");
    await screen.findByText("Skill B");

    // First toggle: sends the prop token.
    fireEvent.click(row("Skill A"));
    await waitFor(() => expect(agentsApi.update).toHaveBeenCalledTimes(1));
    expect(agentsApi.update).toHaveBeenNthCalledWith(1, "a1", {
      skillKeys: ["skill-a"],
      expectedUpdatedAt: "2026-06-25T12:00:00.000Z",
    });

    // Second toggle (the prop has NOT been refreshed yet — no refetch landed):
    // must send the token advanced from the first response, not the stale prop.
    fireEvent.click(row("Skill B"));
    await waitFor(() => expect(agentsApi.update).toHaveBeenCalledTimes(2));
    expect(agentsApi.update).toHaveBeenNthCalledWith(2, "a1", {
      skillKeys: ["skill-a", "skill-b"],
      expectedUpdatedAt: "2026-06-25T12:00:01.000Z",
    });
  });
});
