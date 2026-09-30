import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LibrarianStep } from "../LibrarianStep";

const list = vi.hoisted(() => vi.fn());
vi.mock("../../../api/projects", () => ({
  projectsApi: { list },
}));

// Phase 5e: the step lists ALL captures for the company in one call (both
// scopes) instead of sweeping department by department.
const listCaptures = vi.hoisted(() => vi.fn());
const retry = vi.hoisted(() => vi.fn());
vi.mock("../../../api/braindump", async () => {
  const actual = await vi.importActual<typeof import("../../../api/braindump")>("../../../api/braindump");
  return {
    ...actual,
    braindumpApi: { submit: vi.fn(), list: listCaptures, listCaptures: vi.fn(), get: vi.fn(), retry },
  };
});

const memoryList = vi.hoisted(() => vi.fn());
const memoryApprove = vi.hoisted(() => vi.fn());
vi.mock("../../../api/memory", () => ({
  memoryApi: { list: memoryList, approve: memoryApprove },
}));

function makeDept(overrides: Record<string, unknown> = {}) {
  return { id: "dept-1", name: "Software", type: "department", functionType: "software_development", ...overrides };
}

function makeCapture(overrides: Record<string, unknown> = {}) {
  return {
    id: "bd-1",
    companyId: "c1",
    departmentId: "dept-1",
    idempotencyKey: "dept-1:sess",
    content: "notes",
    contentLength: 5,
    status: "proposed",
    effectiveStatus: "proposed",
    librarianAgentId: "agent-1",
    runId: "run-1",
    proposedMemoryItemIds: ["mem-1"],
    failureReason: null,
    dispatchStartedAt: null,
    dispatchCompletedAt: null,
    createdByUserId: null,
    createdAt: "2026-07-19T00:00:00Z",
    updatedAt: "2026-07-19T00:00:00Z",
    ...overrides,
  };
}

function makeMemoryItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "mem-1",
    companyId: "c1",
    title: "We use Postgres",
    content: "The team standardized on Postgres + Drizzle ORM.",
    category: "context",
    source: "agent",
    status: "pending",
    tags: null,
    departmentId: "dept-1",
    projectId: null,
    createdBy: "agent-1",
    layer: "domain",
    priority: 0,
    visibility: "team",
    expiresAt: null,
    goalId: null,
    taskId: null,
    sourceArtifactId: null,
    sourceContext: "braindump",
    accessedAt: null,
    currentVersionId: null,
    embeddingRetries: 0,
    createdAt: "2026-07-19T00:00:00Z",
    updatedAt: "2026-07-19T00:00:00Z",
    ...overrides,
  };
}

describe("LibrarianStep (WS6 — In-flight standalone surface)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The step only shows captures from THIS braindump run, matched by the run
    // id embedded in each idempotency key. Pin the id so the fixtures'
    // "dept-1:sess" keys are in-run. It lives in localStorage so onboarding can
    // resume after a browser restart.
    localStorage.setItem("aoa:braindump-session:c1", "sess");
    list.mockResolvedValue([makeDept()]);
    listCaptures.mockResolvedValue([makeCapture()]);
    memoryList.mockResolvedValue({ items: [makeMemoryItem()], semanticAvailable: true });
    memoryApprove.mockResolvedValue({ ...makeMemoryItem(), status: "approved" });
    retry.mockResolvedValue(makeCapture());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the done AgentCharacter and lists proposed items when captures are already terminal", async () => {
    render(<LibrarianStep companyId="c1" onDone={vi.fn()} />);

    expect(await screen.findByRole("img", { name: "agent done" })).toBeTruthy();
    expect(screen.getByText("We use Postgres")).toBeTruthy();
    expect(screen.getByText(/Review what the Librarian found/i)).toBeTruthy();
  });

  it("shows the thinking AgentCharacter while a capture is still running, then flips to done via polling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listCaptures.mockResolvedValueOnce([makeCapture({ status: "running" })]);
    listCaptures.mockResolvedValueOnce([makeCapture({ status: "proposed" })]);

    render(<LibrarianStep companyId="c1" onDone={vi.fn()} />);

    expect(await screen.findByRole("img", { name: "agent thinking" })).toBeTruthy();
    expect(screen.getByText(/The Librarian is reading through/)).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    await waitFor(() => expect(listCaptures).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("img", { name: "agent done" })).toBeTruthy();
    expect(screen.getByText("We use Postgres")).toBeTruthy();
  });

  it("scopes the approve list to this run's proposed memory item ids, excluding unrelated pending items", async () => {
    listCaptures.mockResolvedValue([
      makeCapture({ id: "bd-1", proposedMemoryItemIds: ["mem-1"] }),
      makeCapture({ id: "bd-2", departmentId: "dept-2", proposedMemoryItemIds: ["mem-2"] }),
    ]);
    memoryList.mockResolvedValue({
      items: [
        makeMemoryItem({ id: "mem-1", title: "We use Postgres" }),
        makeMemoryItem({ id: "mem-2", title: "We ship weekly" }),
        makeMemoryItem({ id: "mem-unrelated", title: "Unrelated pending item" }),
      ],
      semanticAvailable: true,
    });

    render(<LibrarianStep companyId="c1" onDone={vi.fn()} />);

    expect(await screen.findByText("We use Postgres")).toBeTruthy();
    expect(screen.getByText("We ship weekly")).toBeTruthy();
    expect(screen.queryByText("Unrelated pending item")).toBeNull();
  });

  it("shows an empty state (and still allows Continue) when no captures propose any memory items, even if unrelated pending items exist", async () => {
    listCaptures.mockResolvedValue([makeCapture({ proposedMemoryItemIds: [] })]);
    memoryList.mockResolvedValue({
      items: [makeMemoryItem({ id: "mem-unrelated", title: "Unrelated pending item" })],
      semanticAvailable: true,
    });

    render(<LibrarianStep companyId="c1" onDone={vi.fn()} />);

    expect(await screen.findByRole("img", { name: "agent done" })).toBeTruthy();
    expect(screen.getByText(/No proposed memory items yet/)).toBeTruthy();
    expect(screen.queryByText("Unrelated pending item")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("Approve calls the real founder approval route and removes the item from the list", async () => {
    render(<LibrarianStep companyId="c1" onDone={vi.fn()} />);

    const approveBtn = await screen.findByRole("button", { name: "Approve" });
    fireEvent.click(approveBtn);

    await waitFor(() => expect(memoryApprove).toHaveBeenCalledWith("c1", "mem-1"));
    await waitFor(() => expect(screen.queryByText("We use Postgres")).toBeNull());
  });

  it("shows a failed capture's failure reason with a Retry action", async () => {
    listCaptures.mockResolvedValue([
      makeCapture({ id: "bd-2", status: "failed", failureReason: "The Librarian agent is not provisioned." }),
    ]);
    memoryList.mockResolvedValue({ items: [], semanticAvailable: true });

    render(<LibrarianStep companyId="c1" onDone={vi.fn()} />);

    expect(await screen.findByText("The Librarian agent is not provisioned.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("Retry calls the retry endpoint and clears the failure once it succeeds", async () => {
    listCaptures.mockResolvedValueOnce([
      makeCapture({ id: "bd-2", status: "failed", failureReason: "boom" }),
    ]);
    memoryList.mockResolvedValueOnce({ items: [], semanticAvailable: true });
    retry.mockResolvedValueOnce(makeCapture({ id: "bd-2", status: "proposed", failureReason: null }));

    render(<LibrarianStep companyId="c1" onDone={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => expect(retry).toHaveBeenCalledWith("c1", "bd-2"));
    await waitFor(() => expect(screen.queryByText("boom")).toBeNull());
  });

  it("Continue calls onDone even while still organizing", async () => {
    listCaptures.mockResolvedValue([makeCapture({ status: "running" })]);
    const onDone = vi.fn();
    render(<LibrarianStep companyId="c1" onDone={onDone} />);

    await screen.findByRole("img", { name: "agent thinking" });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("Continue only fires onDone once even on a rapid double-click", async () => {
    listCaptures.mockResolvedValue([makeCapture({ status: "running" })]);
    const onDone = vi.fn();
    render(<LibrarianStep companyId="c1" onDone={onDone} />);

    await screen.findByRole("img", { name: "agent thinking" });
    const continueBtn = screen.getByRole("button", { name: "Continue" });
    fireEvent.click(continueBtn);
    fireEvent.click(continueBtn);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("does not crash and stops polling after unmount while organizing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listCaptures.mockResolvedValue([makeCapture({ status: "running" })]);

    const { unmount } = render(<LibrarianStep companyId="c1" onDone={vi.fn()} />);
    await screen.findByRole("img", { name: "agent thinking" });

    expect(() => unmount()).not.toThrow();

    listCaptures.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(9000);
    });
    expect(listCaptures).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Item 5 / Phase 5e — company scope discovery + grouping.
  // -------------------------------------------------------------------------

  it("lists captures for the whole company in one call, not per department", async () => {
    render(<LibrarianStep companyId="c1" onDone={vi.fn()} />);
    await screen.findByRole("img", { name: "agent done" });

    expect(listCaptures).toHaveBeenCalledTimes(1);
    expect(listCaptures).toHaveBeenCalledWith("c1");
  });

  it("finds a company-wide capture even when the company has NO departments", async () => {
    // The old per-department sweep exited early here and reported nothing.
    list.mockResolvedValue([]);
    listCaptures.mockResolvedValue([
      makeCapture({ id: "bd-co", departmentId: null, proposedMemoryItemIds: ["mem-1"] }),
    ]);

    render(<LibrarianStep companyId="c1" onDone={vi.fn()} />);

    expect(await screen.findByRole("img", { name: "agent done" })).toBeTruthy();
    expect(screen.getByText("We use Postgres")).toBeTruthy();
    expect(screen.getByText("Company-wide")).toBeTruthy();
  });

  it("requests BOTH pending layers so identity proposals aren't dropped", async () => {
    render(<LibrarianStep companyId="c1" onDone={vi.fn()} />);
    await screen.findByRole("img", { name: "agent done" });

    const layers = memoryList.mock.calls.map((c) => (c[1] as { layer: string }).layer);
    expect(layers).toContain("domain");
    expect(layers).toContain("identity");
  });

  it("groups proposals by scope with Company-wide first", async () => {
    list.mockResolvedValue([makeDept({ id: "dept-1", name: "Software" })]);
    listCaptures.mockResolvedValue([
      makeCapture({ id: "bd-dept", departmentId: "dept-1", proposedMemoryItemIds: ["mem-dept"] }),
      makeCapture({ id: "bd-co", departmentId: null, proposedMemoryItemIds: ["mem-co"] }),
    ]);
    memoryList.mockResolvedValue({
      items: [
        makeMemoryItem({ id: "mem-dept", title: "We use Postgres" }),
        makeMemoryItem({ id: "mem-co", title: "We optimize for candor" }),
      ],
      semanticAvailable: true,
    });

    render(<LibrarianStep companyId="c1" onDone={vi.fn()} />);
    await screen.findByRole("img", { name: "agent done" });

    const headings = screen.getAllByText(/^(Company-wide|Software)$/).map((el) => el.textContent);
    expect(headings).toEqual(["Company-wide", "Software"]);
    expect(screen.getByText("We optimize for candor")).toBeTruthy();
    expect(screen.getByText("We use Postgres")).toBeTruthy();
  });

  it("stops spinning after the poll deadline and lets the founder continue", async () => {
    // A capture can stay non-terminal for reasons the founder can't act on
    // (a dead run whose failure write never landed). Spinning forever would
    // be a dead end in the middle of onboarding.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listCaptures.mockResolvedValue([makeCapture({ status: "running" })]);
    memoryList.mockResolvedValue({ items: [], semanticAvailable: true });

    render(<LibrarianStep companyId="c1" onDone={vi.fn()} />);
    expect(await screen.findByRole("img", { name: "agent thinking" })).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(125_000);
    });

    expect(await screen.findByText(/still working on this one/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("ignores captures from a PREVIOUS onboarding session", async () => {
    // A stale running capture from an old session would otherwise pin this
    // step on "Organizing…" forever, and its proposals would be offered for
    // approval as if the founder had just written them.
    listCaptures.mockResolvedValue([
      makeCapture({ id: "bd-old", idempotencyKey: "dept-1:older-session", status: "running" }),
      makeCapture({ id: "bd-now", idempotencyKey: "dept-1:sess", status: "proposed" }),
    ]);

    render(<LibrarianStep companyId="c1" onDone={vi.fn()} />);

    // Reaches "done" despite the stale running row.
    expect(await screen.findByRole("img", { name: "agent done" })).toBeTruthy();
  });

  it("handles a department with no braindumps yet (empty list) without hanging on thinking", async () => {
    listCaptures.mockResolvedValue([]);
    memoryList.mockResolvedValue({ items: [], semanticAvailable: true });

    render(<LibrarianStep companyId="c1" onDone={vi.fn()} />);

    expect(await screen.findByRole("img", { name: "agent done" })).toBeTruthy();
    expect(screen.getByText(/No proposed memory items yet/)).toBeTruthy();
  });

  it("does not block on organizing — shows a background note and lets the founder continue", async () => {
    // A capture still running (Librarian working in the background).
    listCaptures.mockResolvedValue([makeCapture({ status: "running" })]);
    memoryList.mockResolvedValue({ items: [], semanticAvailable: true });

    const onDone = vi.fn();
    render(<LibrarianStep companyId="c1" onDone={onDone} />);

    // A clear background note, not an indefinite blocking spinner.
    expect(await screen.findByText(/sorting|background|review (it )?in Memory/i)).toBeTruthy();
    // Continue is available immediately, even while the run is in flight.
    const cont = screen.getByRole("button", { name: /continue/i });
    fireEvent.click(cont);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
