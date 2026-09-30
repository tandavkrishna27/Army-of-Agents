import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SpineCompleteStep } from "../SpineCompleteStep";
import { validateRegistry, type StepContext } from "../../registry";
import { ONBOARDING_STEPS } from "../index";

vi.mock("../../../api/onboarding", () => ({
  advanceOnboarding: vi.fn(async () => ({ completedStates: [] })),
  setFirstRunCompleted: vi.fn(async () => undefined),
}));

import { advanceOnboarding, setFirstRunCompleted } from "../../../api/onboarding";

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
  ],
};

describe("SpineCompleteStep (WS0c terminal wizard step)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("advances SETUP_COMPLETE on mount (no button click required) and completes", async () => {
    const onComplete = vi.fn();
    render(<SpineCompleteStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(advanceOnboarding).toHaveBeenCalledWith({
      companyId: "c1",
      journey: "founder",
      requestedState: "SETUP_COMPLETE",
    });
  });

  it("does NOT write firstRunCompleted — that write moves to Home/WS9", async () => {
    const onComplete = vi.fn();
    render(<SpineCompleteStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(setFirstRunCompleted).not.toHaveBeenCalled();
  });

  it("shows an error and a Retry button when the advance fails, and does not call onComplete", async () => {
    (advanceOnboarding as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("advance blew up"),
    );
    const onComplete = vi.fn();
    render(<SpineCompleteStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    expect(await screen.findByText("advance blew up")).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();
    const retry = screen.getByText("Retry").closest("button") as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
  });

  it("is genuinely retryable — clicking Retry after a failure re-fires the advance and can succeed", async () => {
    (advanceOnboarding as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("advance blew up"),
    );
    const onComplete = vi.fn();
    render(<SpineCompleteStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    await screen.findByText("Retry");

    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(advanceOnboarding).toHaveBeenCalledTimes(2);
  });

  it("does not double-fire the mount advance under React StrictMode's double-invoked effects (mount → unmount → remount)", async () => {
    const onComplete = vi.fn();
    render(
      <StrictMode>
        <SpineCompleteStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />
      </StrictMode>,
    );
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    // StrictMode intentionally mounts, cleans up, and remounts effects once
    // in dev to surface missing cleanup — the startedRef guard must absorb
    // that and still only fire (and complete) the advance a single time.
    expect(advanceOnboarding).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("keeps Retry genuinely disabled/busy while a retry is in flight, blocking a fast double-click from launching concurrent advances", async () => {
    (advanceOnboarding as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("advance blew up"),
    );
    let resolveRetry: ((value: { completedStates: string[] }) => void) | undefined;
    const pending = new Promise<{ completedStates: string[] }>((resolve) => {
      resolveRetry = resolve;
    });
    (advanceOnboarding as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => pending,
    );

    const onComplete = vi.fn();
    render(<SpineCompleteStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    await screen.findByText("Retry");

    fireEvent.click(screen.getByText("Retry"));

    // While the retry request is outstanding, the button must actually
    // reflect the busy state (not the pre-fix dead `disabled={busy}` that
    // could never be true while the error branch rendered).
    const busyButton = (await screen.findByText("Retrying…")).closest(
      "button",
    ) as HTMLButtonElement;
    expect(busyButton.disabled).toBe(true);

    // A fast double-click while busy must not launch a second concurrent
    // advance — disabled buttons don't dispatch click handlers.
    fireEvent.click(busyButton);
    expect(advanceOnboarding).toHaveBeenCalledTimes(2); // mount call + the one in-flight retry

    resolveRetry?.({ completedStates: [] });
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(advanceOnboarding).toHaveBeenCalledTimes(2);
  });
});

describe("assembled registry includes the terminal step", () => {
  it("passes the guard and registers SETUP_COMPLETE as the last founder step, gated on COMMANDER_VERIFIED", () => {
    expect(validateRegistry(ONBOARDING_STEPS)).toEqual([]);
    const founderSteps = ONBOARDING_STEPS.filter((s) => s.journeys.includes("founder"));
    // Phase 2 Task 3/12 added CreateOrganizationStep (id "organization") ahead
    // of the company step, so the founder spine grew from 6 to 7 steps.
    expect(founderSteps).toHaveLength(7);
    const terminal = founderSteps[founderSteps.length - 1];
    expect(terminal.state).toBe("SETUP_COMPLETE");
    expect(terminal.dependsOn).toEqual(["COMMANDER_VERIFIED"]);
  });
});
