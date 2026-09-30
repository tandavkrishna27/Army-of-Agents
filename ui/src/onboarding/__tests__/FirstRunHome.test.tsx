import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FirstRunHome } from "../FirstRunHome";

const deploymentMode = vi.hoisted(() => ({ value: "local_trusted" as string }));
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: () => ({ data: { deploymentMode: deploymentMode.value } }),
  };
});

const getFirstRunProgress = vi.hoisted(() =>
  vi.fn(async () => ({ firstRunPersona: null as string | null, firstRunCompleted: false })),
);
const setFirstRunPersona = vi.hoisted(() => vi.fn(async () => {}));
const setFirstRunCompleted = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../api/onboarding", () => ({
  getFirstRunProgress,
  setFirstRunPersona,
  setFirstRunCompleted,
}));

vi.mock("../inflight/InFlightFlow", () => ({
  InFlightFlow: ({ onDone, deploymentMode: mode }: { onDone: () => void; deploymentMode?: string }) => (
    <button onClick={onDone}>finish-in-flight:{mode ?? "unknown"}</button>
  ),
}));

describe("FirstRunHome (WS9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deploymentMode.value = "local_trusted";
    getFirstRunProgress.mockResolvedValue({ firstRunPersona: null, firstRunCompleted: false });
    setFirstRunPersona.mockResolvedValue(undefined);
    setFirstRunCompleted.mockResolvedValue(undefined);
  });

  it("shows the door band by default (no persisted persona)", async () => {
    render(<FirstRunHome companyId="co-1" />);
    expect(await screen.findByRole("button", { name: /bring a project in motion/i })).toBeInTheDocument();
  });

  it("short-circuits to onComplete when firstRunCompleted is already true (revisited /onboarding after finishing)", async () => {
    // Codex P2: a completed founder revisiting /onboarding (history/bookmark)
    // must NOT be shown the persona doors or re-run the tail.
    getFirstRunProgress.mockResolvedValue({ firstRunPersona: "in_flight", firstRunCompleted: true });
    const onComplete = vi.fn();
    render(<FirstRunHome companyId="co-1" onComplete={onComplete} />);

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /bring a project in motion/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/finish-in-flight/)).not.toBeInTheDocument();
  });

  it("picking In-flight writes the persona, then routes into InFlightFlow", async () => {
    const user = userEvent.setup();
    render(<FirstRunHome companyId="co-1" />);

    await user.click(await screen.findByRole("button", { name: /bring a project in motion/i }));

    await waitFor(() => expect(setFirstRunPersona).toHaveBeenCalledWith("co-1", "in_flight"));
    expect(await screen.findByText("finish-in-flight:local_trusted")).toBeInTheDocument();
    expect(setFirstRunCompleted).not.toHaveBeenCalled();
  });

  it("picking Explorer writes the persona AND completion, then calls onComplete", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<FirstRunHome companyId="co-1" onComplete={onComplete} />);

    await user.click(await screen.findByRole("button", { name: /explore on your own/i }));

    await waitFor(() => expect(setFirstRunPersona).toHaveBeenCalledWith("co-1", "explorer"));
    await waitFor(() => expect(setFirstRunCompleted).toHaveBeenCalledWith("co-1"));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });

  it("resumes straight into InFlightFlow when firstRunPersona is already in_flight", async () => {
    getFirstRunProgress.mockResolvedValue({ firstRunPersona: "in_flight", firstRunCompleted: false });
    render(<FirstRunHome companyId="co-1" />);

    expect(await screen.findByText("finish-in-flight:local_trusted")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /bring a project in motion/i })).toBeNull();
  });

  it("InFlightFlow's completion calls onComplete", async () => {
    const user = userEvent.setup();
    getFirstRunProgress.mockResolvedValue({ firstRunPersona: "in_flight", firstRunCompleted: false });
    const onComplete = vi.fn();
    render(<FirstRunHome companyId="co-1" onComplete={onComplete} />);

    await user.click(await screen.findByText("finish-in-flight:local_trusted"));
    expect(onComplete).toHaveBeenCalled();
  });

  it("threads cloud deployment mode into the in-flight execution boundary", async () => {
    deploymentMode.value = "cloud_auth";
    getFirstRunProgress.mockResolvedValue({ firstRunPersona: "in_flight", firstRunCompleted: false });

    render(<FirstRunHome companyId="co-1" />);

    expect(await screen.findByText("finish-in-flight:cloud_auth")).toBeInTheDocument();
  });

  it("code-review fix: a failed progress read shows a retry state, NOT the door band", async () => {
    getFirstRunProgress.mockRejectedValue(new Error("network down"));
    render(<FirstRunHome companyId="co-1" />);

    expect(await screen.findByRole("button", { name: /retry/i })).toBeInTheDocument();
    // Must NOT fall back to the door band — that risks an Explorer pick
    // firing premature completion, or re-asking an in-progress founder.
    expect(screen.queryByRole("button", { name: /bring a project in motion/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /explore on your own/i })).toBeNull();
    expect(setFirstRunCompleted).not.toHaveBeenCalled();
    expect(setFirstRunPersona).not.toHaveBeenCalled();
  });

  it("code-review fix: Retry re-attempts the read and recovers into the door band on success", async () => {
    const user = userEvent.setup();
    getFirstRunProgress
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ firstRunPersona: null, firstRunCompleted: false });
    render(<FirstRunHome companyId="co-1" />);

    await user.click(await screen.findByRole("button", { name: /retry/i }));

    expect(await screen.findByRole("button", { name: /bring a project in motion/i })).toBeInTheDocument();
    expect(getFirstRunProgress).toHaveBeenCalledTimes(2);
  });
});
