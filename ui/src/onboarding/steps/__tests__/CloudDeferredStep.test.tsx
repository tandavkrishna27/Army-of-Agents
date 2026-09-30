import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudAwareEnvironmentStep, CloudAwareVerifyStep } from "../CloudDeferredStep";

const advanceOnboarding = vi.fn();

vi.mock("../../../api/onboarding", () => ({
  advanceOnboarding: (...args: unknown[]) => advanceOnboarding(...args),
}));

vi.mock("../VerifyStep", () => ({
  VerifyStep: () => <div data-testid="local-verify-step" />,
}));

const ctx = {
  userId: "user-1",
  companyId: "company-1",
  journey: "founder" as const,
  completedStates: ["AUTHENTICATED", "PROFILE_SET", "COMPANY_CREATED"] as const,
  deploymentMode: "cloud_auth" as const,
  organizationId: "organization-1",
};

describe("cloud onboarding continuations", () => {
  beforeEach(() => {
    advanceOnboarding.mockReset().mockResolvedValue({});
  });

  it("advances environment readiness without invoking the host filesystem step", async () => {
    const onComplete = vi.fn();
    render(<CloudAwareEnvironmentStep ctx={ctx as never} onComplete={onComplete} onBack={vi.fn()} />);

    expect(screen.queryByLabelText(/root folder/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("cloud-provider-key-notice")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /continue setup/i }));

    expect(advanceOnboarding).toHaveBeenCalledWith({
      companyId: "company-1",
      journey: "founder",
      requestedState: "ENVIRONMENT_READY",
    });
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("advances cloud readiness without invoking the local CLI verification step", async () => {
    const onComplete = vi.fn();
    render(<CloudAwareVerifyStep ctx={ctx as never} onComplete={onComplete} onBack={vi.fn()} />);

    expect(screen.queryByText(/run checks/i)).not.toBeInTheDocument();
    const notice = screen.getByTestId("cloud-provider-key-notice");
    expect(notice).toHaveTextContent(/isn't required|not required/i);
    expect(notice).not.toHaveTextContent(/extraction/i);
    expect(
      screen.getByRole("link", { name: /open settings.*providers/i }),
    ).toHaveAttribute("href", "/settings?tab=providers");
    await userEvent.click(screen.getByRole("button", { name: /continue setup/i }));

    expect(advanceOnboarding).toHaveBeenCalledWith({
      companyId: "company-1",
      journey: "founder",
      requestedState: "COMMANDER_VERIFIED",
    });
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("routes local_trusted verification to the local verification step", () => {
    render(
      <CloudAwareVerifyStep
        ctx={{ ...ctx, deploymentMode: "local_trusted" } as never}
        onComplete={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByTestId("local-verify-step")).toBeInTheDocument();
    expect(screen.queryByTestId("cloud-provider-key-notice")).not.toBeInTheDocument();
  });
});
