import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CommanderStep } from "../CommanderStep";
import { validateRegistry, type StepContext } from "../../registry";
import { ONBOARDING_STEPS } from "../index";

const updateConfig = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../../../api/internal-agent", () => ({ internalAgentApi: { updateConfig } }));
vi.mock("../../../api/onboarding", () => ({
  advanceOnboarding: vi.fn(async () => ({ completedStates: [] })),
}));

import { advanceOnboarding } from "../../../api/onboarding";

const ctx: StepContext = {
  userId: "u1",
  companyId: "c1",
  journey: "founder",
  completedStates: ["AUTHENTICATED", "PROFILE_SET", "ORGANIZATION_CREATED", "ENVIRONMENT_READY"],
};

describe("CommanderStep (Stage C / order 4)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires a provider choice before continuing", async () => {
    const onComplete = vi.fn();
    render(<CommanderStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    // Continue is disabled until a card is selected.
    expect((screen.getByText("Continue").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("saves the Claude cliTool, advances COMMANDER_SELECTED, then completes", async () => {
    const onComplete = vi.fn();
    render(<CommanderStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Claude"));
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(updateConfig).toHaveBeenCalledWith("c1", {
      cliTool: "claude_cli",
      provider: "anthropic",
      model: null,
      crewModel: null,
    });
    expect(advanceOnboarding).toHaveBeenCalledWith({
      companyId: "c1",
      journey: "founder",
      requestedState: "COMMANDER_SELECTED",
    });
  });

  it("maps the Codex card to the codex cliTool", async () => {
    render(<CommanderStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Codex"));
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith("c1", {
        cliTool: "codex",
        provider: "openai",
        model: null,
        crewModel: null,
      }),
    );
  });

  it("describes the Commander limitation truthfully on AoA Cloud", () => {
    render(
      <CommanderStep
        ctx={{ ...ctx, deploymentMode: "cloud_auth" }}
        onComplete={vi.fn()}
        onBack={() => {}}
      />,
    );

    expect(screen.getByText(/commander does not run on aoa cloud yet/i)).toBeInTheDocument();
    expect(screen.getByText(/claude provider preference/i)).toBeInTheDocument();
    expect(screen.queryByText(/this runtime powers commander and every agent/i)).not.toBeInTheDocument();
  });
});

describe("assembled registry includes the commander step", () => {
  it("passes the registry guard and registers at order 4", () => {
    expect(validateRegistry(ONBOARDING_STEPS)).toEqual([]);
    const c = ONBOARDING_STEPS.find((s) => s.state === "COMMANDER_SELECTED");
    expect(c?.order).toBe(4);
    expect(c?.journeys).toEqual(["founder"]);
    expect(c?.dependsOn).toEqual(["ENVIRONMENT_READY"]);
  });
});
