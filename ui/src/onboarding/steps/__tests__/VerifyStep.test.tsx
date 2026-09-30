import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { VerifyStep } from "../VerifyStep";
import { validateRegistry, type StepContext } from "../../registry";
import { ONBOARDING_STEPS } from "../index";
import { ApiError } from "../../../api/client";

const post = vi.hoisted(() => vi.fn());
vi.mock("../../../api/client", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, api: { ...(actual.api as object), post } };
});
vi.mock("../../../api/onboarding", () => ({
  advanceOnboarding: vi.fn(async () => ({ completedStates: [] })),
}));
// Realistic base config: Commander runs the Claude CLI (`cliTool`), and the crew
// `provider` is DELIBERATELY a different value — the Verify step must derive its
// recovery-credential provider from `cliTool` (what the server probes), never
// from the crew `provider` (Codex P2-A).
const getConfig = vi.hoisted(() => vi.fn(async () => ({ cliTool: "claude_cli", provider: "openai" })));
vi.mock("../../../api/internal-agent", () => ({ internalAgentApi: { getConfig } }));
const saveCommanderKey = vi.hoisted(() => vi.fn(async () => ({ ok: true, secretId: "s1" })));
const startCommanderLogin = vi.hoisted(() => vi.fn());
const getCommanderLoginStatus = vi.hoisted(() => vi.fn());
const cancelCommanderLogin = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const submitCommanderLoginCode = vi.hoisted(() => vi.fn());
const getCommanderAuthCapabilities = vi.hoisted(() =>
  vi.fn(async () => ({
    topology: {
      platform: "linux",
      installProfile: "local_single_user",
      networkLocation: "local",
      trustBoundary: "single_user",
      executionOwnership: "user_hosted",
    },
    providers: {
      openai: {
        provider: "openai",
        mode: "device_code",
        enabled: true,
        browserSafeRemotely: true,
        reason: null,
      },
      anthropic: {
        provider: "anthropic",
        mode: "paste_code",
        enabled: true,
        browserSafeRemotely: true,
        reason: null,
      },
    },
  })),
);
vi.mock("../../../api/commander-auth", () => ({
  saveCommanderKey,
  startCommanderLogin,
  getCommanderLoginStatus,
  cancelCommanderLogin,
  submitCommanderLoginCode,
  getCommanderAuthCapabilities,
}));
const getHealth = vi.hoisted(() =>
  vi.fn(async () => ({ status: "ok", deploymentMode: "local_trusted" })),
);
vi.mock("../../../api/health", () => ({ healthApi: { get: getHealth } }));

import { advanceOnboarding } from "../../../api/onboarding";

const ctx: StepContext = {
  userId: "u1",
  companyId: "c1",
  journey: "founder",
  completedStates: ["AUTHENTICATED", "PROFILE_SET", "ORGANIZATION_CREATED", "ENVIRONMENT_READY", "COMMANDER_SELECTED"],
};

const needsAuthResponse = () =>
  new ApiError("Request failed: 422", 422, {
    outcome: "needs_auth",
    result: {
      status: "fail",
      checks: [{ code: "codex_hello_probe_auth_required", message: "sign in" }],
    },
  });

describe("VerifyStep (Stage C / order 5, blocking)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders no step-local Back control (the FlowEngine chrome owns the shared Back affordance)", () => {
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} onBack={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
  });

  it("shows the cloud provider-key notice in cloud_auth", async () => {
    getHealth.mockResolvedValueOnce({ status: "ok", deploymentMode: "cloud_auth" });
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    const link = await screen.findByRole("link", { name: /providers/i });
    expect(link.getAttribute("href")).toBe("/settings?tab=providers");
  });

  it("advances COMMANDER_VERIFIED and completes when verified", async () => {
    post.mockResolvedValueOnce({ outcome: "verified", result: { status: "pass" } });
    const onComplete = vi.fn();
    render(<VerifyStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Verify"));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/companies/c1/internal-agent/verify", {});
    expect(advanceOnboarding).toHaveBeenCalledWith({
      companyId: "c1",
      journey: "founder",
      requestedState: "COMMANDER_VERIFIED",
    });
  });

  it("BLOCKS on needs_auth (422) — shows sign-in guidance + Check again, no advance/complete", async () => {
    post.mockRejectedValueOnce(
      new ApiError("Request failed: 422", 422, {
        outcome: "needs_auth",
        result: { status: "fail", checks: [{ code: "claude_hello_probe_auth_required", message: "sign in" }] },
      }),
    );
    const onComplete = vi.fn();
    render(<VerifyStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Verify"));
    expect(await screen.findByText("sign in")).toBeTruthy(); // the probe message
    expect(screen.getByText("Check again")).toBeTruthy();
    expect(advanceOnboarding).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("BLOCKS on not_installed (422) — shows an install hint", async () => {
    post.mockRejectedValueOnce(
      new ApiError("Request failed: 422", 422, {
        outcome: "not_installed",
        result: { status: "fail", checks: [{ code: "claude_command_unresolvable", message: "not found" }] },
      }),
    );
    const onComplete = vi.fn();
    render(<VerifyStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Verify"));
    expect(await screen.findByText(/install/i)).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();
  });

  const needsAuthError = () =>
    new ApiError("Request failed: 422", 422, {
      outcome: "needs_auth",
      result: { status: "fail", checks: [{ code: "claude_hello_probe_auth_required", message: "sign in" }] },
    });

  it("needs_auth → paste an API key → saves it (encrypted) and re-verifies to completion", async () => {
    post.mockRejectedValueOnce(needsAuthError());
    post.mockResolvedValueOnce({ outcome: "verified", result: { status: "pass" } });
    const onComplete = vi.fn();
    render(<VerifyStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Verify"));

    // Provider (Claude/anthropic) loads async → the key field becomes enabled.
    const input = (await screen.findByPlaceholderText(/sk-ant/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-ant-SECRET" } });
    fireEvent.click(screen.getByRole("button", { name: /save key & verify/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(saveCommanderKey).toHaveBeenCalledWith({ companyId: "c1", provider: "anthropic", value: "sk-ant-SECRET" });
    expect(advanceOnboarding).toHaveBeenCalledWith({
      companyId: "c1",
      journey: "founder",
      requestedState: "COMMANDER_VERIFIED",
    });
  });

  // Superseded 2026-07-20: the paste-code bridge (Tasks 1-4) landed, so Claude
  // is no longer API-key-only — it now offers the same in-app interactive
  // sign-in as Codex. See "VerifyStep — Claude in-app sign-in" below.
  it("Claude (anthropic) needs_auth shows both the API-key path and interactive sign-in", async () => {
    post.mockRejectedValueOnce(needsAuthError());
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Verify"));
    expect(await screen.findByPlaceholderText(/sk-ant/i)).toBeTruthy();
    expect(await screen.findByRole("button", { name: /sign in with claude/i })).toBeTruthy();
  });

  it("needs_auth → Codex interactive login → surfaces the verification URL while pending", async () => {
    getCommanderLoginStatus.mockResolvedValue({ status: "pending", loginUrl: "https://auth.openai.com/go?c=1" });
    getConfig.mockResolvedValue({ cliTool: "codex", provider: "anthropic" }); // interactive login is Codex-only; crew provider diverges
    post.mockRejectedValueOnce(needsAuthError());
    startCommanderLogin.mockResolvedValueOnce({ challengeId: "ch-1", loginUrl: "https://auth.openai.com/go?c=1" });
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Verify"));

    fireEvent.click(await screen.findByRole("button", { name: /sign in with codex/i }));
    const link = (await screen.findByText("Continue securely at auth.openai.com")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://auth.openai.com/go?c=1");
    expect(screen.queryByText("https://auth.openai.com/go?c=1")).toBeNull();
    expect(startCommanderLogin).toHaveBeenCalledWith({ companyId: "c1", provider: "openai" });
  });

  it("needs_auth → Codex interactive login → polls to completed and re-verifies", async () => {
    getConfig.mockResolvedValue({ cliTool: "codex", provider: "anthropic" });
    post.mockRejectedValueOnce(needsAuthError());
    startCommanderLogin.mockResolvedValueOnce({ challengeId: "ch-1", loginUrl: "https://auth.openai.com/go?c=1" });
    getCommanderLoginStatus.mockResolvedValue({ status: "completed", loginUrl: "https://auth.openai.com/go?c=1" });
    post.mockResolvedValueOnce({ outcome: "verified", result: { status: "pass" } });
    const onComplete = vi.fn();
    render(<VerifyStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Verify"));

    fireEvent.click(await screen.findByRole("button", { name: /sign in with codex/i }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled()); // immediate poll → completed → re-verify
    expect(getCommanderLoginStatus).toHaveBeenCalledWith({ companyId: "c1", challengeId: "ch-1" });
    expect(advanceOnboarding).toHaveBeenCalledWith({
      companyId: "c1",
      journey: "founder",
      requestedState: "COMMANDER_VERIFIED",
    });
  });

  it("stops polling and offers Start again after the server loses the challenge", async () => {
    getConfig.mockResolvedValue({ cliTool: "codex", provider: "anthropic" });
    post.mockRejectedValueOnce(needsAuthError());
    startCommanderLogin.mockResolvedValueOnce({
      challengeId: "ch-restarted",
      loginUrl: "https://auth.openai.com/device",
    });
    getCommanderLoginStatus.mockRejectedValueOnce(
      new ApiError("Request failed: 404", 404, { error: "challenge not found" }),
    );

    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Verify"));
    fireEvent.click(await screen.findByRole("button", { name: /sign in with codex/i }));

    expect(
      await screen.findByText(
        "This sign-in session expired or the server restarted. Start sign-in again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in with codex/i })).toBeInTheDocument();
  });

  // Fix 3: the challenge finalizing "completed" is not proof of a successful
  // login — the server computes it as exit 0 && a credential file present,
  // and the real CLI can print "Login successful" and exit 0 even after
  // REJECTING an invalid code when a stale credential file already exists.
  // The probe is the only authority; when it disagrees with "completed" the
  // founder must see an explicit message, not a silently-reverted panel.
  it("Fix 3: 'completed' that the re-verify probe rejects shows a clear message instead of silently tearing down the panel", async () => {
    getConfig.mockResolvedValue({ cliTool: "codex", provider: "anthropic" });
    post.mockRejectedValueOnce(needsAuthError()); // initial "Verify" click
    startCommanderLogin.mockResolvedValueOnce({ challengeId: "ch-1", loginUrl: "https://auth.openai.com/go?c=1" });
    getCommanderLoginStatus.mockResolvedValue({ status: "completed", loginUrl: "https://auth.openai.com/go?c=1" });
    post.mockRejectedValueOnce(needsAuthError()); // re-verify after "completed" — still not actually signed in
    const onComplete = vi.fn();
    render(<VerifyStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Verify"));

    fireEvent.click(await screen.findByRole("button", { name: /sign in with codex/i }));

    expect(await screen.findByText(/didn't complete/i)).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();
  });

  // P2-A: the recovery-credential provider follows Commander's `cliTool` (the CLI
  // the server verify route actually probes), NOT the independent crew `provider`.
  it("P2-A: derives the auth provider from Commander cliTool (claude_cli), ignoring a divergent crew provider", async () => {
    getConfig.mockResolvedValue({ cliTool: "claude_cli", provider: "openai" }); // Claude Commander, OpenAI crew
    post.mockRejectedValueOnce(needsAuthError());
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Verify"));
    // Resolves to anthropic (matches the CLI the server probes) → Claude key path
    // AND the Claude interactive sign-in (both providers now offer it).
    expect(await screen.findByPlaceholderText(/sk-ant/i)).toBeTruthy();
    expect(await screen.findByRole("button", { name: /sign in with claude/i })).toBeTruthy();
    // NOT the divergent OpenAI crew provider's button.
    expect(screen.queryByRole("button", { name: /sign in with codex/i })).toBeNull();
  });

  it("P2-A (mirror): cliTool codex with a divergent crew provider → OpenAI/Codex auth path", async () => {
    getConfig.mockResolvedValue({ cliTool: "codex", provider: "anthropic" }); // Codex Commander, Anthropic crew
    post.mockRejectedValueOnce(needsAuthError());
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Verify"));
    // openai → Codex interactive login is offered; the anthropic-only sk-ant hint is not.
    expect(await screen.findByRole("button", { name: /sign in with codex/i })).toBeTruthy();
    expect(screen.queryByPlaceholderText(/sk-ant/i)).toBeNull();
  });

  // P2-B: a still-pending login challenge is cancelled when the founder leaves the
  // step, releasing the detached CLI child + the shared (provider,authHome) slot.
  it("P2-B: cancels a still-pending login challenge when the step unmounts", async () => {
    getConfig.mockResolvedValue({ cliTool: "codex" }); // openai → interactive login available
    post.mockRejectedValueOnce(needsAuthError());
    startCommanderLogin.mockResolvedValueOnce({ challengeId: "ch-1", loginUrl: "https://auth.openai.com/go?c=1" });
    getCommanderLoginStatus.mockResolvedValue({ status: "pending", loginUrl: "https://auth.openai.com/go?c=1" });
    const { unmount } = render(<VerifyStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Verify"));
    fireEvent.click(await screen.findByRole("button", { name: /sign in with codex/i }));
    await screen.findByText("Continue securely at auth.openai.com"); // pending challenge surfaced
    unmount();
    await waitFor(() =>
      expect(cancelCommanderLogin).toHaveBeenCalledWith({ companyId: "c1", challengeId: "ch-1" }),
    );
  });

  it("P2-B: does NOT cancel a completed challenge on unmount", async () => {
    getConfig.mockResolvedValue({ cliTool: "codex" });
    post.mockRejectedValueOnce(needsAuthError());
    post.mockResolvedValueOnce({ outcome: "verified", result: { status: "pass" } });
    startCommanderLogin.mockResolvedValueOnce({ challengeId: "ch-2", loginUrl: "https://auth.openai.com/go?c=2" });
    getCommanderLoginStatus.mockResolvedValue({ status: "completed", loginUrl: "https://auth.openai.com/go?c=2" });
    const onComplete = vi.fn();
    const { unmount } = render(<VerifyStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Verify"));
    fireEvent.click(await screen.findByRole("button", { name: /sign in with codex/i }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled()); // completed → login cleared → terminal
    unmount();
    expect(cancelCommanderLogin).not.toHaveBeenCalled();
  });

  it("P2-B: no active challenge → no cancel on unmount", () => {
    getConfig.mockResolvedValue({ cliTool: "claude_cli" });
    const { unmount } = render(<VerifyStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    unmount();
    expect(cancelCommanderLogin).not.toHaveBeenCalled();
  });

  // WS3: "I'll sign in myself in the CLI" — a third, provider-agnostic recovery
  // path that re-runs the SAME hello-probe verify check on an interval (mirrors
  // the device-login poll above) until it reports verified, then auto-advances.
  describe("WS3: CLI auto-detect", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("is offered for BOTH providers (unlike the Codex-only interactive login)", async () => {
      getConfig.mockResolvedValue({ cliTool: "claude_cli" }); // anthropic — no device login
      post.mockRejectedValueOnce(needsAuthError());
      render(<VerifyStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
      fireEvent.click(screen.getByText("Verify"));
      expect(await screen.findByRole("button", { name: /sign in myself in the cli/i })).toBeTruthy();
    });

    it("polls the same verify probe (immediate tick, no waiting a full interval) until verified, then auto-advances", async () => {
      post.mockRejectedValueOnce(needsAuthError()); // initial "Verify" click
      post.mockResolvedValueOnce({ outcome: "verified", result: { status: "pass" } }); // auto-detect tick
      const onComplete = vi.fn();
      render(<VerifyStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
      fireEvent.click(screen.getByText("Verify"));

      fireEvent.click(await screen.findByRole("button", { name: /sign in myself in the cli/i }));

      await waitFor(() => expect(onComplete).toHaveBeenCalled());
      expect(post).toHaveBeenCalledTimes(2);
      expect(post).toHaveBeenLastCalledWith("/companies/c1/internal-agent/verify", {});
      expect(advanceOnboarding).toHaveBeenCalledWith({
        companyId: "c1",
        journey: "founder",
        requestedState: "COMMANDER_VERIFIED",
      });
    });

    // Copy updated 2026-07-20 (Task 6): the bare "watching for your sign-in…"
    // spinner text is replaced by the literal terminal command per provider —
    // see "VerifyStep — honest recovery copy" below for the dedicated coverage.
    // This test keeps its original intent: a clear watching status while
    // polling, and Cancel stops it and returns the start button.
    it("shows a clear watching status while polling, and Cancel stops it (returns the start button)", async () => {
      post.mockRejectedValueOnce(needsAuthError()); // initial "Verify" click
      post.mockRejectedValueOnce(needsAuthError()); // immediate auto-detect tick — still not signed in
      render(<VerifyStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
      fireEvent.click(screen.getByText("Verify"));

      fireEvent.click(await screen.findByRole("button", { name: /sign in myself in the cli/i }));
      expect(await screen.findByText("claude auth login")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
      expect(await screen.findByRole("button", { name: /sign in myself in the cli/i })).toBeTruthy();
      expect(screen.queryByText("claude auth login")).toBeNull();
    });

    // Code-review fix: the earlier "polls the same verify probe" test above only
    // proves the IMMEDIATE tick fires (real timers, no interval wait). This test
    // uses fake timers to advance clock time PAST CLI_AUTO_DETECT_POLL_MS
    // (~3000ms) and asserts the interval itself re-fires the probe — not just
    // the immediate tick — before transitioning to verified.
    it("re-fires the verify probe on the ~3000ms interval (not just the immediate tick), then verifies", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      post.mockRejectedValueOnce(needsAuthError()); // initial "Verify" click
      post.mockRejectedValueOnce(needsAuthError()); // immediate auto-detect tick — still not signed in
      post.mockResolvedValueOnce({ outcome: "verified", result: { status: "pass" } }); // interval tick — now verified
      const onComplete = vi.fn();
      render(<VerifyStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
      fireEvent.click(screen.getByText("Verify"));

      fireEvent.click(await screen.findByRole("button", { name: /sign in myself in the cli/i }));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(2)); // immediate tick, still not signed in

      // Advance past a single interval tick (CLI_AUTO_DETECT_POLL_MS) — the
      // interval must re-fire the SAME verify probe on its own, without any
      // further user interaction.
      act(() => {
        vi.advanceTimersByTime(3000);
      });

      await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
      expect(post).toHaveBeenLastCalledWith("/companies/c1/internal-agent/verify", {});
      await waitFor(() => expect(onComplete).toHaveBeenCalled());
      expect(advanceOnboarding).toHaveBeenCalledWith({
        companyId: "c1",
        journey: "founder",
        requestedState: "COMMANDER_VERIFIED",
      });
    });

    it("does not crash and does not fire onComplete after unmount while a CLI auto-detect poll is active", async () => {
      post.mockRejectedValueOnce(needsAuthError()); // initial "Verify" click
      post.mockRejectedValueOnce(needsAuthError()); // immediate auto-detect tick — still not signed in
      const onComplete = vi.fn();
      const { unmount } = render(<VerifyStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
      fireEvent.click(screen.getByText("Verify"));

      fireEvent.click(await screen.findByRole("button", { name: /sign in myself in the cli/i }));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(2));

      expect(() => unmount()).not.toThrow();
      expect(onComplete).not.toHaveBeenCalled();
    });
  });

  // Task 7: the server's `*_auth_expired` checks (Tasks 1-6) carry a precise,
  // founder-ready sentence naming the account and distinguishing "expired" from
  // "never signed in" — prefer that over the generic client-side guess, and
  // never let raw stream-json (`detail`) reach the founder.
  describe("Task 7: expired-session copy + no raw JSON leakage", () => {
    const expiredError = (overrides: { detail?: string } = {}) =>
      new ApiError("Request failed: 422", 422, {
        outcome: "needs_auth",
        result: {
          status: "fail",
          checks: [
            {
              code: "claude_hello_probe_auth_expired",
              level: "error",
              message: "Signed in as ada@example.com, but that session has expired or been revoked.",
              hint: "Sign in again — paste an API key below, or run `claude login` in a terminal and we'll detect it.",
              ...overrides,
            },
          ],
        },
      });

    it("names the account and offers recovery when the session has expired", async () => {
      post.mockRejectedValueOnce(expiredError());
      render(<VerifyStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
      fireEvent.click(screen.getByText("Verify"));

      expect((await screen.findAllByText(/ada@example\.com/)).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/expired or been revoked/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/paste an api key/i).length).toBeGreaterThan(0);
    });

    it("uses different copy for a founder who was never signed in", async () => {
      post.mockRejectedValueOnce(
        new ApiError("Request failed: 422", 422, {
          outcome: "needs_auth",
          result: {
            status: "fail",
            checks: [
              {
                code: "claude_hello_probe_auth_required",
                level: "error",
                message: "Claude CLI is installed, but you're not signed in yet.",
              },
            ],
          },
        }),
      );
      render(<VerifyStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
      fireEvent.click(screen.getByText("Verify"));

      expect(await screen.findByText(/not signed in yet/i)).toBeTruthy();
      expect(screen.queryByText(/expired or been revoked/i)).toBeNull();
    });

    it("never renders raw stream-json from a check's `detail`", async () => {
      post.mockRejectedValueOnce(
        expiredError({
          detail: '{"type":"system","subtype":"init","session_id":"s","model":"claude-opus-4-8"}',
        }),
      );
      const { container } = render(<VerifyStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
      fireEvent.click(screen.getByText("Verify"));

      await screen.findAllByText(/ada@example\.com/);
      expect(container.textContent).not.toContain("session_id");
      expect(container.textContent).not.toContain('{"type":"system"');
    });

    it("Codex expired copy names ChatGPT", async () => {
      getConfig.mockResolvedValue({ cliTool: "codex", provider: "anthropic" });
      post.mockRejectedValueOnce(
        new ApiError("Request failed: 422", 422, {
          outcome: "needs_auth",
          result: {
            status: "fail",
            checks: [
              {
                code: "codex_hello_probe_auth_expired",
                level: "error",
                message: "Codex is signed in using ChatGPT, but that session has expired or been rejected.",
                hint: "Sign in again below, or run `codex login` in a terminal and we'll detect it.",
              },
            ],
          },
        }),
      );
      render(<VerifyStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
      fireEvent.click(screen.getByText("Verify"));

      expect((await screen.findAllByText(/ChatGPT/)).length).toBeGreaterThan(0);
    });
  });
});

describe("assembled registry includes the verify step", () => {
  it("passes the guard and registers at order 5, non-skippable", () => {
    expect(validateRegistry(ONBOARDING_STEPS)).toEqual([]);
    const v = ONBOARDING_STEPS.find((s) => s.state === "COMMANDER_VERIFIED");
    expect(v?.order).toBe(5);
    expect(v?.dependsOn).toEqual(["COMMANDER_SELECTED"]);
    expect(v?.canSkip).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Check breakdown — the "it said valid but it wasn't" bug.
//
// The verify probe returns several checks. A real revoked-token run passes the
// first three (cwd, command resolvable, auth mode) and fails the last (hello
// probe). Rendering only checks[0] showed a single reassuring line and no way
// to tell success from failure.
// ---------------------------------------------------------------------------
describe("VerifyStep — per-check breakdown", () => {
  beforeEach(() => vi.clearAllMocks());

  const REVOKED_RUN = {
    outcome: "failed",
    result: {
      status: "fail",
      checks: [
        { code: "claude_cwd_valid", level: "info", message: "Working directory is valid: /home/ada/AoA" },
        { code: "claude_command_resolvable", level: "info", message: "Command is executable: claude" },
        { code: "claude_subscription_mode_possible", level: "info", message: "ANTHROPIC_API_KEY is not set" },
        {
          code: "claude_hello_probe_failed",
          level: "error",
          message: "Claude hello probe failed.",
          detail: '{"error":{"message":"OAuth access token has been revoked."}}',
          hint: "Run `claude --print` manually in this directory to debug.",
        },
      ],
    },
  };

  it("shows EVERY check, not just the first one", async () => {
    post.mockResolvedValue(REVOKED_RUN);
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByText(/Claude hello probe failed/)).toBeTruthy();
    expect(screen.getByText(/Working directory is valid/)).toBeTruthy();
    expect(screen.getByText(/Command is executable/)).toBeTruthy();
  });

  it("marks the FAILING check as failed and the passing ones as passed", async () => {
    post.mockResolvedValue(REVOKED_RUN);
    const { container } = render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    // Only the failure is styled as a failure — "Working directory is valid"
    // must never be what reads as the error, which is what confused the founder.
    await waitFor(() => {
      const failures = [...container.querySelectorAll(".text-destructive")].map((e) => e.textContent ?? "");
      expect(failures.join(" ")).toMatch(/hello probe failed/i);
      expect(failures.join(" ")).not.toMatch(/Working directory is valid/i);
    });
  });

  it("keeps sanitized raw detail collapsed until the founder asks for it", async () => {
    post.mockResolvedValue({
      ...REVOKED_RUN,
      result: {
        ...REVOKED_RUN.result,
        checks: REVOKED_RUN.result.checks.map((check) =>
          check.code === "claude_hello_probe_failed"
            ? { ...check, detail: "Provider rejected the saved session." }
            : check,
        ),
      },
    });
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    const summary = await screen.findByText("Technical details");
    const details = summary.closest("details");
    expect(details).toBeTruthy();
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("Provider rejected the saved session.")).toBeInTheDocument();
  });

  it("shows the Codex device code returned by the remote-safe login flow", async () => {
    getConfig.mockResolvedValueOnce({ cliTool: "codex", provider: "anthropic" });
    post.mockRejectedValueOnce(needsAuthResponse());
    startCommanderLogin.mockResolvedValueOnce({
      challengeId: "ch-device",
      loginUrl: "https://auth.openai.com/codex/device",
      mode: "device_code",
      userCode: "ABCD-EFGH",
      expiresAt: "2026-07-27T12:00:00.000Z",
    });
    getCommanderLoginStatus.mockResolvedValue({ status: "pending", loginUrl: null });
    const view = render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByText("Verify"));
    fireEvent.click(await screen.findByRole("button", { name: /sign in with codex/i }));
    expect(await screen.findByLabelText("Codex device code")).toHaveTextContent("ABCD-EFGH");
    view.unmount();
  });

  it("explains why subscription auth is unavailable on a shared hosted installation", async () => {
    getConfig.mockResolvedValueOnce({ cliTool: "codex", provider: "anthropic" });
    getCommanderAuthCapabilities.mockResolvedValueOnce({
      topology: {
        platform: "linux",
        installProfile: "hosted_multi_tenant",
        networkLocation: "remote",
        trustBoundary: "multi_tenant",
        executionOwnership: "aoa_hosted",
      },
      providers: {
        openai: {
          provider: "openai",
          mode: "device_code",
          enabled: false,
          browserSafeRemotely: true,
          reason: "Use a company API key or a dedicated execution target.",
        },
        anthropic: {
          provider: "anthropic",
          mode: "paste_code",
          enabled: false,
          browserSafeRemotely: true,
          reason: "Use a company API key or a dedicated execution target.",
        },
      },
    });
    post.mockRejectedValueOnce(needsAuthResponse());
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByText("Verify"));
    expect(await screen.findByText(/subscription sign-in is unavailable here/i)).toBeTruthy();
    expect(screen.getByText(/company API key or a dedicated execution target/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /sign in with codex/i })).toBeNull();
  });

  it("surfaces the server's hint for the failing check", async () => {
    post.mockResolvedValue(REVOKED_RUN);
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByText(/Run `claude --print` manually/)).toBeTruthy();
  });

  it("hides the breakdown once everything passes", async () => {
    post.mockResolvedValue({
      outcome: "verified",
      result: { status: "pass", checks: [{ code: "ok", level: "info", message: "Working directory is valid: /home/ada/AoA" }] },
    });
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(advanceOnboarding).toHaveBeenCalled());
    expect(screen.queryByText(/Working directory is valid/)).toBeNull();
  });
});

// Caught by live verification against a genuinely revoked token, not by any
// unit test: auth checks arrive at level "warn" (recoverable, not fatal), and
// keying the tick on level==="error" rendered a GREEN CHECK beside "your
// session has expired or been revoked".
describe("VerifyStep — a warn-level check must not render as a pass", () => {
  beforeEach(() => vi.clearAllMocks());

  const WARN_EXPIRED = {
    outcome: "needs_auth",
    result: {
      status: "warn",
      checks: [
        { code: "claude_cwd_valid", level: "info", message: "Working directory is valid: /home/ada" },
        {
          code: "claude_hello_probe_auth_expired",
          level: "warn",
          message: "Signed in as ada@example.com, but that session has expired or been revoked.",
          hint: "Sign in again — paste an API key below.",
        },
      ],
    },
  };

  it("marks the warn-level auth check as a problem, not a pass", async () => {
    post.mockRejectedValueOnce(new ApiError("Request failed: 422", 422, WARN_EXPIRED));
    const { container } = render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await screen.findAllByText(/expired or been revoked/i);
    const problems = [...container.querySelectorAll(".text-destructive")].map((e) => e.textContent ?? "");
    expect(problems.join(" ")).toMatch(/expired or been revoked/i);
    // The passing check must NOT be styled as a problem.
    expect(problems.join(" ")).not.toMatch(/Working directory is valid/);
  });

  it("still renders genuinely passing checks as passes", async () => {
    post.mockRejectedValueOnce(new ApiError("Request failed: 422", 422, WARN_EXPIRED));
    const { container } = render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await screen.findAllByText(/expired or been revoked/i);
    const items = [...container.querySelectorAll("li")];
    const cwdItem = items.find((li) => /Working directory is valid/.test(li.textContent ?? ""));
    expect(cwdItem?.textContent).toContain("✓");
    const authItem = items.find((li) => /expired or been revoked/.test(li.textContent ?? ""));
    expect(authItem?.textContent).not.toContain("✓");
  });
});

describe("VerifyStep — Claude in-app sign-in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // getConfig's implementation persists across tests (clearAllMocks clears
    // call history, not the implementation set by an earlier test's
    // mockResolvedValue) — pin it explicitly so the derived provider is
    // deterministically "anthropic" regardless of test execution order.
    getConfig.mockResolvedValue({ cliTool: "claude_cli", provider: "openai" });
    // Same leak risk: an earlier Codex test leaves getCommanderLoginStatus
    // defaulting to "completed", which would make the immediate device-poll
    // tick short-circuit straight to a fake "verified" before the paste-code
    // UI ever renders. Pin it to "pending" — these tests exercise the
    // paste-code path, not the device-poll auto-complete path.
    getCommanderLoginStatus.mockResolvedValue({ status: "pending", loginUrl: null });
  });

  const NEEDS_AUTH = {
    outcome: "needs_auth",
    result: { status: "warn", checks: [
      { code: "claude_hello_probe_auth_expired", level: "warn",
        message: "Signed in as ada@example.com, but that session has expired or been revoked." },
    ] },
  };

  it("offers interactive sign-in for Claude, not just Codex", async () => {
    post.mockRejectedValueOnce(new ApiError("Request failed: 422", 422, NEEDS_AUTH));
    startCommanderLogin.mockResolvedValue({ challengeId: "ch1", loginUrl: "https://claude.com/x" });
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    fireEvent.click(await screen.findByRole("button", { name: /sign in with claude/i }));

    expect(await screen.findByText("Continue securely at claude.com")).toBeTruthy();
    expect(screen.getByLabelText(/paste the code/i)).toBeTruthy();
  });

  it("submits the pasted code and re-runs the probe rather than trusting the CLI", async () => {
    post.mockRejectedValueOnce(new ApiError("Request failed: 422", 422, NEEDS_AUTH));
    startCommanderLogin.mockResolvedValue({ challengeId: "ch1", loginUrl: "https://claude.com/x" });
    submitCommanderLoginCode.mockResolvedValue({ ok: true });
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    fireEvent.click(await screen.findByRole("button", { name: /sign in with claude/i }));

    const postCallsBefore = post.mock.calls.length;
    fireEvent.change(await screen.findByLabelText(/paste the code/i), { target: { value: "ABC-123" } });
    fireEvent.click(screen.getByRole("button", { name: /submit code/i }));

    await waitFor(() =>
      expect(submitCommanderLoginCode).toHaveBeenCalledWith({
        companyId: "c1", challengeId: "ch1", code: "ABC-123",
      }),
    );
    // The probe is the ONLY authoritative completion signal.
    await waitFor(() => expect(post.mock.calls.length).toBeGreaterThan(postCallsBefore));
  });

  it("tells the founder to start again when the session is gone", async () => {
    post.mockRejectedValueOnce(new ApiError("Request failed: 422", 422, NEEDS_AUTH));
    startCommanderLogin.mockResolvedValue({ challengeId: "ch1", loginUrl: "https://claude.com/x" });
    submitCommanderLoginCode.mockRejectedValue(
      new ApiError("Request failed: 404", 404, { error: "This sign-in session is no longer active. Start sign-in again." }),
    );
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    fireEvent.click(await screen.findByRole("button", { name: /sign in with claude/i }));
    fireEvent.change(await screen.findByLabelText(/paste the code/i), { target: { value: "ABC-123" } });
    fireEvent.click(screen.getByRole("button", { name: /submit code/i }));

    expect(await screen.findByText(/start sign-in again/i)).toBeTruthy();
  });

  it("does not submit an empty code", async () => {
    post.mockRejectedValueOnce(new ApiError("Request failed: 422", 422, NEEDS_AUTH));
    startCommanderLogin.mockResolvedValue({ challengeId: "ch1", loginUrl: "https://claude.com/x" });
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    fireEvent.click(await screen.findByRole("button", { name: /sign in with claude/i }));

    const btn = await screen.findByRole("button", { name: /submit code/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(submitCommanderLoginCode).not.toHaveBeenCalled();
  });
});

describe("VerifyStep — honest recovery copy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // See rationale in "VerifyStep — Claude in-app sign-in" above.
    getConfig.mockResolvedValue({ cliTool: "claude_cli", provider: "openai" });
  });

  const NEEDS_AUTH = {
    outcome: "needs_auth",
    result: { status: "warn", checks: [
      { code: "claude_hello_probe_auth_required", level: "warn",
        message: "Claude CLI is installed, but you're not signed in yet." },
    ] },
  };

  it("does not claim 'no terminal required'", async () => {
    post.mockRejectedValueOnce(new ApiError("Request failed: 422", 422, NEEDS_AUTH));
    const { container } = render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await screen.findByText(/not signed in yet/i);
    expect(container.textContent).not.toMatch(/no terminal required/i);
  });

  it("shows the literal command while watching for a terminal sign-in", async () => {
    post.mockRejectedValueOnce(new ApiError("Request failed: 422", 422, NEEDS_AUTH)); // initial "Verify" click
    post.mockRejectedValueOnce(new ApiError("Request failed: 422", 422, NEEDS_AUTH)); // immediate auto-detect tick
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    fireEvent.click(await screen.findByRole("button", { name: /sign in myself/i }));

    expect(await screen.findByText("claude auth login")).toBeTruthy();
    expect(screen.getByText(/detect it automatically/i)).toBeTruthy();
  });
});

// Fix 4: the in-app sign-in panel said "we'll continue automatically" right
// above a paste-code input — true for Codex (local callback self-completes),
// false for Claude (the paste IS required). Copy must be provider-conditional.
describe("VerifyStep — provider-conditional sign-in link copy (Fix 4)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Claude (anthropic): tells the founder to paste the code, not 'continue automatically'", async () => {
    getConfig.mockResolvedValue({ cliTool: "claude_cli", provider: "openai" });
    getCommanderLoginStatus.mockResolvedValue({ status: "pending", loginUrl: null });
    post.mockRejectedValueOnce(
      new ApiError("Request failed: 422", 422, {
        outcome: "needs_auth",
        result: { status: "warn", checks: [
          { code: "claude_hello_probe_auth_required", level: "warn",
            message: "Claude CLI is installed, but you're not signed in yet." },
        ] },
      }),
    );
    startCommanderLogin.mockResolvedValue({ challengeId: "ch1", loginUrl: "https://claude.com/x" });
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    fireEvent.click(await screen.findByRole("button", { name: /sign in with claude/i }));

    expect(await screen.findByText(/paste the code it gives you below/i)).toBeTruthy();
    expect(screen.queryByText(/continue automatically/i)).toBeNull();
  });

  it("Codex (openai): keeps the automatic-continue copy", async () => {
    getConfig.mockResolvedValue({ cliTool: "codex", provider: "anthropic" });
    getCommanderLoginStatus.mockResolvedValue({ status: "pending", loginUrl: "https://auth.openai.com/go?c=1" });
    post.mockRejectedValueOnce(
      new ApiError("Request failed: 422", 422, {
        outcome: "needs_auth",
        result: { status: "fail", checks: [{ code: "codex_hello_probe_auth_required", message: "sign in" }] },
      }),
    );
    startCommanderLogin.mockResolvedValueOnce({ challengeId: "ch-1", loginUrl: "https://auth.openai.com/go?c=1" });
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Verify"));
    fireEvent.click(await screen.findByRole("button", { name: /sign in with codex/i }));

    expect(await screen.findByText(/continue automatically/i)).toBeTruthy();
    expect(screen.queryByText(/paste the code it gives you below/i)).toBeNull();
  });
});

// Fix 5: check() had no in-flight guard of its own — submitCode and a
// pollLogin tick could both invoke it, so on a successful login two probes
// could race to advanceOnboarding + onComplete.
describe("VerifyStep — concurrent probe guard (Fix 5)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("two overlapping check() triggers result in one probe POST and onComplete firing at most once", async () => {
    let resolvePost: (v: unknown) => void = () => {};
    post.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    );
    const onComplete = vi.fn();
    render(<VerifyStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    const verifyButton = screen.getByText("Verify");

    // Two clicks land before React has re-rendered the disabled/"Checking…"
    // state — the same race a pollLogin tick landing during submitCode's
    // check() would create.
    fireEvent.click(verifyButton);
    fireEvent.click(verifyButton);

    await act(async () => {
      resolvePost({ outcome: "verified", result: { status: "pass" } });
    });

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("a later, non-overlapping 'Check again' still works after a previous check finished", async () => {
    post.mockRejectedValueOnce(
      new ApiError("Request failed: 422", 422, {
        outcome: "needs_auth",
        result: { status: "fail", checks: [{ code: "claude_hello_probe_auth_required", message: "sign in" }] },
      }),
    );
    post.mockResolvedValueOnce({ outcome: "verified", result: { status: "pass" } });
    const onComplete = vi.fn();
    render(<VerifyStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Verify"));
    await screen.findByText("Check again");

    fireEvent.click(screen.getByText("Check again"));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledTimes(2);
  });
});

// Stale-verdict fix: `submitCode` never calls `clearPoll()`, so the
// `pollLogin` interval from the interactive sign-in flow is still live while
// `submitCode` awaits its own post-credential `check()`. If a poll tick lands
// during that window, the guard must make it await the SAME real probe — not
// read the `outcome` state left over from the PRIOR (pre-credential) probe.
describe("VerifyStep — a guarded caller awaits the real verdict, not a stale one", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfig.mockResolvedValue({ cliTool: "claude_cli", provider: "openai" });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a guarded caller awaits the real verdict, not a stale one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Probe A (the initial "Verify" click): needs_auth.
    post.mockRejectedValueOnce(
      new ApiError("Request failed: 422", 422, {
        outcome: "needs_auth",
        result: { status: "fail", checks: [{ code: "claude_hello_probe_auth_required", message: "sign in" }] },
      }),
    );
    startCommanderLogin.mockResolvedValueOnce({ challengeId: "ch1", loginUrl: "https://claude.com/x" });
    // pollLogin's immediate tick (fired by startLogin) sees "pending" — no
    // check() call yet.
    getCommanderLoginStatus.mockResolvedValueOnce({ status: "pending", loginUrl: "https://claude.com/x" });
    // The 2500ms interval tick sees "completed" — THIS is the overlapping
    // caller that must not get a stale verdict.
    getCommanderLoginStatus.mockResolvedValueOnce({ status: "completed", loginUrl: "https://claude.com/x" });
    submitCommanderLoginCode.mockResolvedValue({ ok: true });

    // Probe B (submitCode's post-credential check()) — held open so the
    // overlapping pollLogin tick's check() call can land WHILE it is still
    // in flight.
    let resolveProbeB: (v: unknown) => void = () => {};
    post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProbeB = resolve;
        }),
    );

    const onComplete = vi.fn();
    render(<VerifyStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Verify"));

    fireEvent.click(await screen.findByRole("button", { name: /sign in with claude/i }));
    fireEvent.change(await screen.findByLabelText(/paste the code/i), { target: { value: "ABC-123" } });
    fireEvent.click(screen.getByRole("button", { name: /submit code/i }));

    // submitCode() is now awaiting check() (Probe B) — post has been called
    // a second time and is being held open.
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));

    // Fire the poll interval tick WHILE Probe B is still in flight. Its
    // status resolves "completed", so pollLogin calls check() too — the
    // GUARDED, overlapping call.
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    await waitFor(() => expect(getCommanderLoginStatus).toHaveBeenCalledTimes(2));
    // The guarded call must NOT start a third probe — it awaits Probe B.
    expect(post).toHaveBeenCalledTimes(2);

    // Checkpoint BEFORE Probe B resolves — `outcome` is still "needs_auth"
    // for both the buggy and fixed code at this instant, so the panel that
    // renders `authError` is still mounted either way. With the stale-verdict
    // bug, the guarded call resolves synchronously to that stale "needs_auth"
    // and pollLogin sets this exact error immediately, well before Probe B
    // ever settles. The fix must show no such error here — the guarded call
    // is still genuinely awaiting the live probe.
    expect(screen.queryByText(/didn't complete/i)).toBeNull();

    // Now let Probe B resolve verified. Both submitCode's caller and the
    // guarded pollLogin caller must see this REAL verdict.
    await act(async () => {
      resolveProbeB({ outcome: "verified", result: { status: "pass" } });
    });

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    // onComplete must fire exactly once even though TWO callers awaited the
    // same in-flight probe.
    expect(onComplete).toHaveBeenCalledTimes(1);
    // And the stale error must never have been shown, even transiently
    // (outcome === "needs_auth" still gates its render at this point too,
    // since `check()` set outcome to "verified" only after this).
    expect(screen.queryByText(/didn't complete/i)).toBeNull();
  });
});
