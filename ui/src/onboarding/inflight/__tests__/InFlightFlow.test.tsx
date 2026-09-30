import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InFlightFlow } from "../InFlightFlow";

const setFirstRunCompleted = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../../api/onboarding", () => ({ setFirstRunCompleted }));

// Stub every In-flight surface with a minimal, identifiable stand-in that
// exposes an onDone button — keeps this a pure sequencer test (each surface
// already has its own unit tests).
vi.mock("../DefineDepartments", () => ({
  DefineDepartments: ({ onDone }: { onDone: () => void }) => (
    <button onClick={onDone}>finish-departments</button>
  ),
}));
vi.mock("../IntegrationsStep", () => ({
  IntegrationsStep: ({ onDone }: { onDone: () => void }) => (
    <button onClick={onDone}>finish-integrations</button>
  ),
}));
vi.mock("../BraindumpStep", () => ({
  BraindumpStep: ({ onDone }: { onDone: () => void }) => (
    <button onClick={onDone}>finish-braindump</button>
  ),
}));
vi.mock("../LibrarianStep", () => ({
  LibrarianStep: ({ onDone }: { onDone: () => void }) => (
    <button onClick={onDone}>finish-librarian</button>
  ),
}));
vi.mock("../CreateAgents", () => ({
  CreateAgents: ({ onDone }: { onDone: () => void }) => (
    <button onClick={onDone}>finish-agents</button>
  ),
}));
vi.mock("../FirstJobStep", () => ({
  FirstJobStep: ({ onDone }: { onDone: () => void }) => (
    <button onClick={onDone}>finish-first-job</button>
  ),
}));

const STORAGE_KEY = "aoa:inflight-step:co-1";

describe("InFlightFlow (WS9 — In-flight sequencer)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setFirstRunCompleted.mockResolvedValue(true);
    window.localStorage.clear();
  });

  it("starts at Departments with no stored marker (fresh company)", async () => {
    render(<InFlightFlow companyId="co-1" onDone={vi.fn()} />);
    expect(await screen.findByText("finish-departments")).toBeInTheDocument();
  });

  it("advances through every surface in order on each onDone, persisting the step marker, then calls setFirstRunCompleted and the parent onDone", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(<InFlightFlow companyId="co-1" onDone={onDone} />);

    const order = [
      "finish-departments",
      "finish-integrations",
      "finish-braindump",
      "finish-librarian",
      "finish-agents",
      "finish-first-job",
    ];

    for (let i = 0; i < order.length; i++) {
      const button = await screen.findByText(order[i]!);
      await user.click(button);
      if (i < order.length - 1) {
        // Marker persisted as the NEXT step's index after each onDone.
        await waitFor(() => expect(window.localStorage.getItem(STORAGE_KEY)).toBe(String(i + 1)));
      }
    }

    await waitFor(() => expect(setFirstRunCompleted).toHaveBeenCalledWith("co-1"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // setFirstRunCompleted must resolve BEFORE the parent onDone fires.
    expect(setFirstRunCompleted.mock.invocationCallOrder[0]!).toBeLessThan(onDone.mock.invocationCallOrder[0]!);
    // The marker is cleared once the sequence completes (on a confirmed write).
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("keeps the step marker when the completion write fails, so a loop-back resumes at the final step (not from scratch)", async () => {
    // Codex P2: setFirstRunCompleted is best-effort; if the write fails, the
    // index gate can bounce the founder back into onboarding. Preserving the
    // marker means they resume at first-job, not the top of the tail.
    setFirstRunCompleted.mockResolvedValue(false);
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(<InFlightFlow companyId="co-1" onDone={onDone} />);

    for (const label of [
      "finish-departments",
      "finish-integrations",
      "finish-braindump",
      "finish-librarian",
      "finish-agents",
      "finish-first-job",
    ]) {
      await user.click(await screen.findByText(label));
    }

    await waitFor(() => expect(setFirstRunCompleted).toHaveBeenCalledWith("co-1"));
    // Parent onDone still fires (best-effort forward progress)…
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // …but the marker is NOT cleared — it stays at the final surface (first-job = index 5).
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("5");
  });

  it("resumes from the stored step index, not ambient department/agent data", async () => {
    window.localStorage.setItem(STORAGE_KEY, "2"); // braindump
    render(<InFlightFlow companyId="co-1" onDone={vi.fn()} />);

    expect(await screen.findByText("finish-braindump")).toBeInTheDocument();
    expect(screen.queryByText("finish-departments")).toBeNull();
    expect(screen.queryByText("finish-integrations")).toBeNull();
  });

  it("clamps an out-of-range stored index to a valid step", async () => {
    window.localStorage.setItem(STORAGE_KEY, "999");
    render(<InFlightFlow companyId="co-1" onDone={vi.fn()} />);
    expect(await screen.findByText("finish-first-job")).toBeInTheDocument();
  });

  it("falls back to step 0 for a negative or non-numeric stored value", async () => {
    window.localStorage.setItem(STORAGE_KEY, "not-a-number");
    render(<InFlightFlow companyId="co-1" onDone={vi.fn()} />);
    expect(await screen.findByText("finish-departments")).toBeInTheDocument();
  });

  it("falls back to step 0 (best-effort) when localStorage read throws", async () => {
    const getItemSpy = vi
      .spyOn(window.localStorage.__proto__, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    try {
      render(<InFlightFlow companyId="co-1" onDone={vi.fn()} />);
      expect(await screen.findByText("finish-departments")).toBeInTheDocument();
    } finally {
      getItemSpy.mockRestore();
    }
  });

  it("shows Back only after the first surface; Back steps to the previous surface", async () => {
    const user = userEvent.setup();

    // index 0 = departments -> NO back (that's the Map fork boundary).
    window.localStorage.setItem(STORAGE_KEY, "0");
    const { unmount } = render(<InFlightFlow companyId="co-1" onDone={vi.fn()} />);
    await screen.findByText("finish-departments");
    expect(screen.queryByRole("button", { name: /^back$/i })).toBeNull();
    unmount();

    // index 2 = braindump -> Back present, clicking steps back to integrations
    // (index 1) and persists the decremented marker.
    window.localStorage.setItem(STORAGE_KEY, "2");
    render(<InFlightFlow companyId="co-1" onDone={vi.fn()} />);
    await screen.findByText("finish-braindump");
    // Phase 2 Task 3/12 added CreateOrganizationStep to the founder spine, so
    // the continuous counter (spine + In-flight) shifted by 1 (13 -> 14).
    expect(screen.getByTestId("onboarding-step-position").textContent).toBe("Step 11 of 14");

    const back = screen.getByRole("button", { name: /^back$/i });
    await user.click(back);

    await screen.findByText("finish-integrations");
    expect(screen.getByTestId("onboarding-step-position").textContent).toBe("Step 10 of 14");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1");
  });
});
