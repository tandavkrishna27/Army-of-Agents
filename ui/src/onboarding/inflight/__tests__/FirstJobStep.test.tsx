import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { FirstJobStep } from "../FirstJobStep";

const issuesCreate = vi.hoisted(() =>
  vi.fn(async (_companyId: string, data: Record<string, unknown>) => ({
    id: "issue-1",
    title: data.title,
  })),
);
vi.mock("../../../api/issues", () => ({
  issuesApi: { create: issuesCreate },
}));

const discussionsCreate = vi.hoisted(() =>
  vi.fn(async (_companyId: string, data: Record<string, unknown>) => ({
    id: "disc-1",
    title: data.title,
  })),
);
vi.mock("../../../api/discussions", () => ({
  discussionsApi: { create: discussionsCreate },
}));

const agentsList = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock("../../../api/agents", () => ({
  agentsApi: { list: agentsList },
}));

const projectsList = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock("../../../api/projects", () => ({
  projectsApi: { list: projectsList },
}));

// This surface is domain-only — like DefineDepartments/CreateAgents — and
// must never call advanceOnboarding. Mocked as a regression guard.
const advanceOnboarding = vi.hoisted(() => vi.fn());
vi.mock("../../../api/onboarding", () => ({ advanceOnboarding }));

describe("FirstJobStep (WS8 — In-flight standalone surface, task-only)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentsList.mockResolvedValue([]);
    projectsList.mockResolvedValue([]);
  });

  it("is task-only — no discussion path", async () => {
    render(<FirstJobStep companyId="c1" onDone={vi.fn()} />);
    expect(screen.queryByText(/start a discussion/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/what's on your mind/i)).toBeNull();
    // task card present + skip present
    expect(screen.getByPlaceholderText(/what needs doing/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /skip to home/i })).toBeInTheDocument();
    expect(advanceOnboarding).not.toHaveBeenCalled();
    // Flush the agentsApi.list effect so the pending-state update doesn't leak.
    // Scoped to the assignee select — the priority select always has 4 fixed
    // options, so a bare `getAllByRole("option")` count would break as soon
    // as priority/department were added.
    await waitFor(() =>
      expect(within(screen.getByLabelText("Assignee")).getAllByRole("option")).toHaveLength(1),
    );
  });

  it("warns that cloud tasks need an enabled E2B-backed assignee", async () => {
    render(<FirstJobStep companyId="c1" deploymentMode="cloud_auth" onDone={vi.fn()} />);

    expect(
      screen.getByText(/will not execute until the assignee has an e2b environment and is enabled/i),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(within(screen.getByLabelText("Assignee")).getAllByRole("option")).toHaveLength(1),
    );
  });

  it("assignee picker is populated from agentsApi.list, preferring org agents over hidden aoa crew", async () => {
    agentsList.mockResolvedValue([
      { id: "agent-1", kind: "org", name: "Scout" },
      { id: "agent-2", kind: "aoa", name: "Adjutant" },
    ]);
    render(<FirstJobStep companyId="c1" onDone={vi.fn()} />);

    const select = (await screen.findByLabelText("Assignee")) as HTMLSelectElement;
    await waitFor(() => expect(screen.getByRole("option", { name: "Scout" })).toBeTruthy());
    expect(within(select).queryByText("Adjutant")).toBeNull();
    expect(screen.getByRole("option", { name: "Unassigned" })).toBeTruthy();
  });

  it("creates a task and fires onDone; never starts a discussion", async () => {
    agentsList.mockResolvedValue([{ id: "agent-1", kind: "org", name: "Scout" }]);
    const onDone = vi.fn();
    render(<FirstJobStep companyId="c1" onDone={onDone} />);

    const select = (await screen.findByLabelText("Assignee")) as HTMLSelectElement;
    await waitFor(() => expect(screen.getByRole("option", { name: "Scout" })).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/what needs doing/i), {
      target: { value: "First task" },
    });
    fireEvent.change(select, { target: { value: "agent-1" } });
    fireEvent.click(screen.getByRole("button", { name: /create task/i }));

    await waitFor(() =>
      expect(issuesCreate).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ title: "First task", status: "todo", assigneeAgentId: "agent-1" }),
      ),
    );
    expect(discussionsCreate).not.toHaveBeenCalled();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(advanceOnboarding).not.toHaveBeenCalled();
  });

  it("Skip to Home calls onDone once and creates nothing", async () => {
    const onDone = vi.fn();
    render(<FirstJobStep companyId="c1" onDone={onDone} />);
    await waitFor(() =>
      expect(within(screen.getByLabelText("Assignee")).getAllByRole("option")).toHaveLength(1),
    );

    fireEvent.click(screen.getByRole("button", { name: "Skip to Home" }));

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(issuesCreate).not.toHaveBeenCalled();
    expect(discussionsCreate).not.toHaveBeenCalled();
  });

  it("onDone fires exactly once even if Create task and Skip are both triggered", async () => {
    let resolveIssue: (v: unknown) => void = () => {};
    issuesCreate.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIssue = resolve;
        }),
    );

    const onDone = vi.fn();
    render(<FirstJobStep companyId="c1" onDone={onDone} />);

    fireEvent.change(screen.getByPlaceholderText(/what needs doing/i), {
      target: { value: "Task A" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create task/i }));
    fireEvent.click(screen.getByRole("button", { name: "Skip to Home" }));

    resolveIssue({ id: "issue-1", title: "Task A" });

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // Give any trailing microtasks a chance to run before asserting the count stays 1.
    await new Promise((r) => setTimeout(r, 0));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("shows an error and does not call onDone when the task create fails", async () => {
    issuesCreate.mockRejectedValueOnce(new Error("boom"));
    const onDone = vi.fn();
    render(<FirstJobStep companyId="c1" onDone={onDone} />);

    fireEvent.change(screen.getByPlaceholderText(/what needs doing/i), {
      target: { value: "Task A" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create task/i }));

    expect(await screen.findByText("boom")).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    // Still submittable (retry state).
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });

  it("has description + priority, and defaults assignee to the created agent", async () => {
    agentsList.mockResolvedValue([{ id: "ag-1", name: "Ada", kind: "org", status: "idle" }]);
    projectsList.mockResolvedValue([{ id: "dept-1", name: "Software", type: "department" }]);
    render(<FirstJobStep companyId="c1" onDone={vi.fn()} />);

    expect(await screen.findByPlaceholderText(/describe|details|what.*involve/i)).toBeInTheDocument();
    expect(screen.getByText(/priority/i)).toBeInTheDocument();

    await waitFor(() => {
      const sel = screen.getByLabelText(/assignee/i) as HTMLSelectElement;
      expect(sel.value).toBe("ag-1");
    });
  });

  it("creates a task with description, priority, assignee, and department", async () => {
    agentsList.mockResolvedValue([{ id: "ag-1", name: "Ada", kind: "org", status: "idle" }]);
    projectsList.mockResolvedValue([{ id: "dept-1", name: "Software", type: "department" }]);
    render(<FirstJobStep companyId="c1" onDone={vi.fn()} />);

    await screen.findByPlaceholderText(/what needs doing/i);
    await waitFor(() => {
      const sel = screen.getByLabelText(/assignee/i) as HTMLSelectElement;
      expect(sel.value).toBe("ag-1");
    });

    fireEvent.change(screen.getByPlaceholderText(/what needs doing/i), {
      target: { value: "First task" },
    });
    fireEvent.change(screen.getByPlaceholderText(/describe|details/i), {
      target: { value: "do the thing" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create task/i }));

    await waitFor(() =>
      expect(issuesCreate).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          title: "First task",
          status: "todo",
          description: "do the thing",
          assigneeAgentId: "ag-1",
          projectId: "dept-1",
        }),
      ),
    );
  });
});
