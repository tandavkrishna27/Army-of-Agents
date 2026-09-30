import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { IntegrationsStep } from "../IntegrationsStep";
import { ApiError } from "../../../api/client";

const getAppInstallUrl = vi.hoisted(() => vi.fn());
vi.mock("../../../api/github-integration", () => ({
  githubIntegrationApi: { getAppInstallUrl },
}));

// This surface is domain-only, like DefineDepartments — it never calls
// advanceOnboarding. Mock it anyway as a regression guard.
const advanceOnboarding = vi.hoisted(() => vi.fn());
vi.mock("../../../api/onboarding", () => ({ advanceOnboarding }));

describe("IntegrationsStep (WS5 — In-flight standalone surface)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAppInstallUrl.mockResolvedValue({ url: "https://github.com/apps/aoa-app/installations/new?state=abc" });
    // jsdom doesn't implement real navigation — swallow the "Not implemented"
    // console.error so a successful Connect test doesn't pollute output.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("renders the GitHub card", () => {
    render(<IntegrationsStep companyId="c1" onDone={vi.fn()} />);
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect GitHub App" })).toBeTruthy();
  });

  it("Connect initiates the App install flow with the onboarding return target", async () => {
    const onDone = vi.fn();
    render(<IntegrationsStep companyId="c1" onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub App" }));

    await waitFor(() => expect(getAppInstallUrl).toHaveBeenCalledWith("c1", "integrations"));
  });

  it("successful connect calls onDone", async () => {
    const onDone = vi.fn();
    render(<IntegrationsStep companyId="c1" onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub App" }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("a 503 from install-url shows the paste-URL fallback instead of a broken button", async () => {
    getAppInstallUrl.mockRejectedValue(new ApiError("GitHub App not configured", 503, { error: "GITHUB_APP_SLUG must be set" }));
    render(<IntegrationsStep companyId="c1" onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub App" }));

    expect(await screen.findByText(/GitHub App isn't set up on this instance/)).toBeTruthy();
    expect(screen.getByLabelText("Repository URL")).toBeTruthy();
    // The Connect button is gone entirely (not left disabled/broken).
    expect(screen.queryByRole("button", { name: "Connect GitHub App" })).toBeNull();
  });

  it("a non-503 connect error surfaces inline without switching to paste mode", async () => {
    getAppInstallUrl.mockRejectedValue(new Error("network down"));
    render(<IntegrationsStep companyId="c1" onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub App" }));

    expect(await screen.findByText("network down")).toBeTruthy();
    expect(screen.queryByLabelText("Repository URL")).toBeNull();
  });

  it("paste-URL validates via the shared isGitHubRepoUrl", async () => {
    render(<IntegrationsStep companyId="c1" onDone={vi.fn()} />);
    fireEvent.click(screen.getByText(/Or paste a public repo URL instead/));

    const input = screen.getByLabelText("Repository URL");
    const continueBtn = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "https://gitlab.com/acme/product" } });
    expect(continueBtn.disabled).toBe(true);
    expect(screen.getByText(/valid GitHub repository URL/)).toBeTruthy();

    fireEvent.change(input, { target: { value: "https://github.com/acme/product" } });
    expect(continueBtn.disabled).toBe(false);
  });

  it("a valid pasted URL calls onDone on Continue", async () => {
    const onDone = vi.fn();
    render(<IntegrationsStep companyId="c1" onDone={onDone} />);
    fireEvent.click(screen.getByText(/Or paste a public repo URL instead/));

    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "https://github.com/acme/product" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("Skip calls onDone without ever calling the install API", () => {
    const onDone = vi.fn();
    render(<IntegrationsStep companyId="c1" onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(getAppInstallUrl).not.toHaveBeenCalled();
  });

  it("does not re-fire onDone if Skip is clicked twice", () => {
    const onDone = vi.fn();
    render(<IntegrationsStep companyId="c1" onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("renders a disabled 'coming soon' scaffold for future integrations", () => {
    render(<IntegrationsStep companyId="c1" onDone={vi.fn()} />);
    expect(screen.getByText(/Slack · coming soon/)).toBeTruthy();
  });
});
