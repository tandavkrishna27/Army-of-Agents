import { useEffect, useRef, useState } from "react";
import type { StepProps } from "../registry";
import { api, ApiError } from "../../api/client";
import { healthApi } from "../../api/health";
import { CloudProviderKeyNotice } from "../CloudProviderKeyNotice";
import { advanceOnboarding } from "../../api/onboarding";
import { internalAgentApi } from "../../api/internal-agent";
import {
  saveCommanderKey,
  startCommanderLogin,
  getCommanderLoginStatus,
  cancelCommanderLogin,
  submitCommanderLoginCode,
  getCommanderAuthCapabilities,
  type CommanderAuthCapability,
  type CommanderSubscriptionMode,
  type CommanderLoginStatus,
} from "../../api/commander-auth";
import { cliToolToProvider, type CommanderProvider } from "@armyofagents/shared";
import { Button } from "@/components/ui/button";
import { AgentCharacter, LoadingDots, Reveal } from "../motion";
import { GradientText, StepHeading, StepShell } from "./shared";

type Outcome = "idle" | "verified" | "needs_auth" | "not_installed" | "failed";

/** One probe result from the verify route. `level` is "error" for a check that
 *  failed; `hint` is the server's actionable next step, when it has one. */
type VerifyCheck = {
  code?: string;
  level?: string;
  message?: string;
  detail?: string;
  hint?: string;
};

type VerifyBody = {
  outcome?: Outcome;
  result?: { status?: string; checks?: VerifyCheck[] };
};

/**
 * The verify probe returns several checks — working directory, command
 * resolvable, auth mode, then a live "hello" probe. Showing only `checks[0]`
 * meant a run where the first three passed and the last FAILED still rendered
 * a single reassuring line ("Working directory is valid: …"), with no way to
 * tell success from failure. Every check is now shown with its own state, and
 * the failing one's hint is surfaced.
 */
function isFailedCheck(c: VerifyCheck): boolean {
  return c.level === "error" || c.level === "fail";
}

/**
 * A check that did NOT pass. Auth checks are emitted at `level: "warn"` (they
 * are recoverable, not fatal), so keying only on "error" rendered a green tick
 * beside "your session has expired or been revoked" — the same "it says fine
 * when it isn't" confusion this step exists to eliminate. Only `info` is a pass.
 */
function isPassedCheck(c: VerifyCheck): boolean {
  return !c.level || c.level === "info" || c.level === "pass";
}

/**
 * The raw `detail` of a failed probe is a stream-json dump. When the CLI is
 * simply signed out, the useful sentence is buried inside it — pull it out so
 * the founder reads "your session expired" instead of a wall of JSON.
 */
function authHintFrom(checks: VerifyCheck[]): string | null {
  const blob = checks.map((c) => `${c.message ?? ""} ${c.detail ?? ""}`).join(" ");
  if (/revoked|401|unauthor|authentication_error|not logged in|please log in/i.test(blob)) {
    return "Your CLI sign-in has expired or been revoked. Sign in again below, or run the CLI once in a terminal and sign in there.";
  }
  return null;
}

/**
 * The server's `*_auth_expired` checks (Tasks 1-6) carry a precise, founder-ready
 * sentence — including WHICH account is signed in — that the client can't derive
 * on its own (e.g. "Signed in as ada@example.com, but that session has expired or
 * been revoked."). Prefer that over the generic client-side `authHintFrom` guess.
 */
function expiredAuthMessage(checks: VerifyCheck[]): string | null {
  return checks.find((c) => c.code?.includes("auth_expired"))?.message ?? null;
}

/**
 * Older probes sometimes returned an entire stream-json event as `detail`.
 * Keep those dumps out of the DOM entirely: collapsing them is not enough for
 * screenshots, accessibility trees, or copy-all diagnostics. Current adapters
 * return a short, redacted human-readable detail instead.
 */
function technicalDetailFor(check: VerifyCheck): string | null {
  const detail = check.detail?.trim();
  if (!detail) return null;
  if (/^[{\[]/.test(detail) || /"(?:session_id|type|subtype)"\s*:/.test(detail)) return null;
  return detail;
}

const PROVIDER_LABEL: Record<CommanderProvider, string> = { anthropic: "Claude", openai: "Codex" };

/** The literal terminal command for each provider's own sign-in, shown verbatim
 *  while we watch for it (WS3 CLI auto-detect) so the founder knows exactly
 *  what to type instead of staring at a bare spinner. */
const PROVIDER_CLI_LOGIN_COMMAND: Record<CommanderProvider, string> = {
  anthropic: "claude auth login",
  openai: "codex login --device-auth",
};

/** Interval (ms) between CLI-auto-detect poll ticks, once past the immediate first check. */
const CLI_AUTO_DETECT_POLL_MS = 3000;

/** OS-appropriate install hint based on the server where the CLI must run. */
function installHint(platform: string | null): string {
  const p = platform?.toLowerCase() ?? "";
  if (p.includes("mac")) return "Install the CLI (e.g. `brew install …`) or download it from the vendor docs.";
  if (p.includes("win")) return "Install the CLI (e.g. `winget install …`) or run the vendor installer.";
  return "Install the CLI (e.g. `npm i -g …`) or follow the vendor install docs.";
}

function loginHost(loginUrl: string): string {
  try {
    return new URL(loginUrl).hostname;
  } catch {
    return "provider sign-in page";
  }
}

/**
 * "Verify your tooling" step (Stage C / order 5). Drives the shared adapter
 * probe via the verify route. BLOCKING: only a `verified` outcome advances
 * COMMANDER_VERIFIED. On `needs_auth` the founder can sign in WITHOUT a terminal
 * — paste an API key (stored encrypted), run the interactive device login (Plan
 * 3 §6.1/§6.2, Codex-only), or (WS3) do it themselves in a terminal and let this
 * step auto-detect completion by polling the same verify probe — then we auto
 * re-verify. The live device flow is dogfood-verified; CI covers the key-paste,
 * device-poll, and CLI-auto-detect-poll wiring.
 */
export function VerifyStep({ ctx, onComplete }: StepProps) {
  const [outcome, setOutcome] = useState<Outcome>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [checks, setChecks] = useState<VerifyCheck[]>([]);
  const [deploymentMode, setDeploymentMode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // Fix (stale-verdict guard): holds the IN-FLIGHT probe promise so a guarded
  // caller can AWAIT the real verdict instead of reading the stale `outcome`
  // closure state. See `check()` below.
  const inflightCheckRef = useRef<Promise<Outcome> | null>(null);

  const [provider, setProvider] = useState<CommanderProvider | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [capability, setCapability] = useState<CommanderAuthCapability | null>(null);
  const [topologyLabel, setTopologyLabel] = useState<string | null>(null);
  const [topologyPlatform, setTopologyPlatform] = useState<string | null>(null);
  const [login, setLogin] = useState<{
    challengeId: string;
    loginUrl: string;
    status: CommanderLoginStatus;
    mode: CommanderSubscriptionMode;
    userCode: string | null;
    expiresAt: string;
  } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const loginPollInFlightRef = useRef(false);

  // Paste-code bridge (Tasks 1-4): Claude's `claude auth login` has no in-app
  // callback like Codex's device flow, so the founder pastes the code shown on
  // the browser sign-in page and we relay it to the live CLI child on stdin.
  const [loginCode, setLoginCode] = useState("");
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);

  // WS3: "do it yourself in the CLI" — instead of a device-login handshake,
  // just keep re-running the SAME hello-probe verify check on an interval
  // until it comes back verified (the founder ran `claude auth login` / etc.
  // themselves in a terminal outside AoA). Works for any provider, unlike the
  // interactive device login below (Codex-only).
  const [cliPolling, setCliPolling] = useState(false);
  const cliPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Derive the recovery-credential provider from Commander's CLI (`cliTool`), NOT
  // the crew `provider` — they are independent config. The verify route probes
  // the adapter resolved from `cliTool` (server resolveCommanderAdapterType), so
  // offering/saving a key for a DIFFERENT CLI than the one being probed would
  // loop the founder forever (e.g. Claude Commander + OpenAI crew → OpenAI key →
  // re-probe Claude → still blocked). Codex P2-A. `cliToolToProvider` is the
  // shared source of truth (also drives the server); we narrow its CrewProvider
  // result to the two Commander providers this step can recover (opencode/google
  // have no key-paste path → provider stays null).
  useEffect(() => {
    if (!ctx.companyId) return;
    let alive = true;
    void internalAgentApi
      .getConfig(ctx.companyId)
      .then((cfg) => {
        const p = cliToolToProvider((cfg as { cliTool?: string | null })?.cliTool);
        if (alive && (p === "anthropic" || p === "openai")) setProvider(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [ctx.companyId]);

  useEffect(() => {
    let alive = true;
    void healthApi
      .get()
      .then((h) => {
        if (alive) setDeploymentMode(h.deploymentMode ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!ctx.companyId || !provider) {
      setCapability(null);
      return;
    }
    let alive = true;
    void getCommanderAuthCapabilities({ companyId: ctx.companyId })
      .then((result) => {
        if (!alive) return;
        setCapability(result.providers[provider]);
        setTopologyPlatform(result.topology.platform);
        setTopologyLabel(
          `${result.topology.platform} · ${result.topology.installProfile.replaceAll("_", " ")}`,
        );
      })
      .catch(() => {
        if (alive) setCapability(null);
      });
    return () => {
      alive = false;
    };
  }, [ctx.companyId, provider]);

  const clearPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const clearCliPoll = () => {
    if (cliPollRef.current) {
      clearInterval(cliPollRef.current);
      cliPollRef.current = null;
    }
    setCliPolling(false);
  };

  // Mirror the latest active login challenge (with the company that created it)
  // into a ref so the empty-dep unmount cleanup below sees the CURRENT value — a
  // plain closure would capture the initial null and never cancel anything.
  const activeLoginRef = useRef<{ companyId: string; challengeId: string; status: CommanderLoginStatus } | null>(
    null,
  );
  useEffect(() => {
    activeLoginRef.current =
      login && ctx.companyId
        ? { companyId: ctx.companyId, challengeId: login.challengeId, status: login.status }
        : null;
  }, [login, ctx.companyId]);

  // On unmount (incl. navigating Back, which unmounts this step) stop BOTH poll
  // loops AND cancel a still-`pending` login. Otherwise the detached CLI child +
  // `pending` row stay alive, and the login slot — shared by (provider,
  // authHome) — 409s every other company until it completes/expires. A
  // completed/failed/timeout challenge is already terminal → skip the request.
  // Codex P2-B.
  useEffect(() => {
    return () => {
      clearPoll();
      clearCliPoll();
      const active = activeLoginRef.current;
      if (active && active.status === "pending") {
        void cancelCommanderLogin({ companyId: active.companyId, challengeId: active.challengeId }).catch(
          () => {},
        );
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on unmount; latest state is read via activeLoginRef.
  }, []);

  /**
   * Returns the resolved Outcome so callers (pollLogin's Fix 3, submitCode)
   * can act on the real verdict instead of racing the `outcome` state, which
   * only updates on the next render.
   *
   * Fix 5: guard against overlapping invocations — `submitCode` and a
   * `pollLogin` tick can both call `check()` around the same time, and
   * without a guard two probes can race to `advanceOnboarding` +
   * `onComplete()`.
   *
   * Stale-verdict fix: the guard must return the SAME in-flight probe, not a
   * snapshot of `outcome` state. `submitCode` never calls `clearPoll()`, so a
   * `pollLogin` interval tick can land while `submitCode`'s `check()` is still
   * awaiting the post-credential probe. If the guarded call returned stale
   * `outcome`, it would report whatever the PREVIOUS (pre-credential) probe
   * found — e.g. "needs_auth" — even though the in-flight probe was about to
   * come back "verified". `inflightCheckRef` holds the live promise so a
   * guarded caller awaits the REAL verdict. `busyRef` is set synchronously
   * inside the same run so `startCliAutoDetect`'s tick (which only reads
   * `busyRef`, not the promise) still skips while a check is in flight.
   */
  const check = async (): Promise<Outcome> => {
    const companyId = ctx.companyId;
    if (!companyId) return "idle";
    if (inflightCheckRef.current) return inflightCheckRef.current;

    const run = (async (): Promise<Outcome> => {
      busyRef.current = true;
      setBusy(true);
      setAuthError(null);
      try {
        const res = await api.post<VerifyBody>(`/companies/${companyId}/internal-agent/verify`, {});
        const list = res.result?.checks ?? [];
        const nextOutcome = res.outcome ?? "verified";
        setOutcome(nextOutcome);
        setChecks(list);
        // Headline the FAILING check, not checks[0] — otherwise a passing first
        // check masks the failure that actually blocked the step.
        setMessage((list.find((c) => !isPassedCheck(c)) ?? list[0])?.message ?? null);
        if (nextOutcome === "verified") {
          clearPoll();
          clearCliPoll();
          await advanceOnboarding({
            companyId,
            journey: ctx.journey,
            requestedState: "COMMANDER_VERIFIED",
          });
          onComplete();
        }
        return nextOutcome;
      } catch (e) {
        const body = e instanceof ApiError ? (e.body as VerifyBody | null) : null;
        const list = body?.result?.checks ?? [];
        const nextOutcome = body?.outcome ?? "failed";
        setOutcome(nextOutcome);
        setChecks(list);
        setMessage(
          (list.find(isFailedCheck) ?? list[0])?.message ??
            (e instanceof Error ? e.message : "Verification failed."),
        );
        return nextOutcome;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    })();

    inflightCheckRef.current = run;
    try {
      return await run;
    } finally {
      inflightCheckRef.current = null;
    }
  };

  const saveKeyAndReverify = async () => {
    if (!ctx.companyId || !provider || !apiKey.trim()) return;
    setAuthBusy(true);
    setAuthError(null);
    try {
      await saveCommanderKey({ companyId: ctx.companyId, provider, value: apiKey.trim() });
      setApiKey("");
      await check();
    } catch (e) {
      const body =
        e instanceof ApiError
          ? (e.body as { error?: string; remediation?: string; supportId?: string } | null)
          : null;
      setAuthError(
        body?.error
          ? `${body.error}${body.remediation ? ` ${body.remediation}` : ""}${body.supportId ? ` Support ID: ${body.supportId}` : ""}`
          : e instanceof Error
            ? e.message
            : "Could not save the key.",
      );
    } finally {
      setAuthBusy(false);
    }
  };

  const startLogin = async () => {
    if (!ctx.companyId || !provider) return;
    setAuthBusy(true);
    setAuthError(null);
    try {
      const { challengeId, loginUrl, mode, userCode, expiresAt } = await startCommanderLogin({
        companyId: ctx.companyId,
        provider,
      });
      setLogin({ challengeId, loginUrl, status: "pending", mode, userCode, expiresAt });
      clearPoll();
      pollRef.current = setInterval(() => void pollLogin(challengeId), 2500);
      void pollLogin(challengeId); // poll once immediately, don't wait a full interval
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : "Could not start sign-in.");
    } finally {
      setAuthBusy(false);
    }
  };

  const pollLogin = async (challengeId: string) => {
    if (!ctx.companyId || loginPollInFlightRef.current) return;
    loginPollInFlightRef.current = true;
    try {
      const { status } = await getCommanderLoginStatus({ companyId: ctx.companyId, challengeId });
      setLogin((prev) => (prev ? { ...prev, status } : prev));
      if (status === "completed") {
        clearPoll();
        // Fix 3: the CHALLENGE finalizing `completed` is not proof the
        // sign-in worked — the server computes it as exit 0 && a credential
        // file present, and the real CLI prints "Login successful" and exits
        // 0 even after REJECTING an invalid code when a stale credential
        // file already exists. Keep the panel up (don't clear `login` yet)
        // until the probe's actual verdict is known, so the founder's
        // paste-code input doesn't vanish before we know whether it worked.
        const result = await check();
        setLogin(null);
        if (result !== "verified") {
          setAuthError("That sign-in didn't complete. Start sign-in again.");
        }
      } else if (status === "failed" || status === "timeout") {
        clearPoll();
        setAuthError(`Sign-in ${status}. Try again.`);
        setLogin(null);
      }
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 410)) {
        clearPoll();
        setLogin(null);
        setAuthError("This sign-in session expired or the server restarted. Start sign-in again.");
      }
      // transient — keep polling
    } finally {
      loginPollInFlightRef.current = false;
    }
  };

  const cancelLogin = async () => {
    if (!ctx.companyId || !login) return;
    setAuthBusy(true);
    try {
      await cancelCommanderLogin({
        companyId: ctx.companyId,
        challengeId: login.challengeId,
      });
      clearPoll();
      setLogin(null);
      setLoginCode("");
      setCodeError(null);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Could not cancel sign-in.");
    } finally {
      setAuthBusy(false);
    }
  };

  /**
   * Paste-code bridge: deliver the code the founder copied from the browser
   * sign-in page to the live CLI child (server-side stdin write), then
   * re-run the verify probe. Completion is decided by the PROBE — never by
   * the 202 itself, the login challenge's `completed` flag, or the CLI's own
   * "Login successful" line — a reviewer confirmed a stale credential file
   * from an earlier revoked login can make both of those lie after a
   * REJECTED code. A 404/410 means the sign-in session is gone server-side
   * (restart, or the CLI child exited) and the founder must start again.
   */
  const submitCode = async () => {
    if (!ctx.companyId || !login || !loginCode.trim()) return;
    setCodeBusy(true);
    setCodeError(null);
    try {
      await submitCommanderLoginCode({
        companyId: ctx.companyId,
        challengeId: login.challengeId,
        code: loginCode.trim(),
      });
      setLoginCode("");
      await check();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { error?: string } | null) : null;
      setCodeError(body?.error ?? (e instanceof Error ? e.message : "Could not submit the code."));
    } finally {
      setCodeBusy(false);
    }
  };

  /**
   * WS3 — "I'll sign in myself in the CLI." No handshake to start: just
   * re-run `check()` on an interval until it reports `verified` (which
   * itself advances + completes and calls `clearCliPoll()`). Skips a tick
   * while a check is already in flight (`busyRef`) so overlapping requests
   * can't pile up.
   */
  const startCliAutoDetect = () => {
    if (cliPollRef.current) return;
    setCliPolling(true);
    setAuthError(null);
    const tick = () => {
      if (busyRef.current) return;
      void check();
    };
    cliPollRef.current = setInterval(tick, CLI_AUTO_DETECT_POLL_MS);
    tick(); // check immediately, don't wait a full interval
  };

  const providerLabel = provider ? PROVIDER_LABEL[provider] : "your CLI";

  return (
    <StepShell>
      <Reveal>
        <StepHeading
          title={
            <>
              Verify your <GradientText>tooling</GradientText>
            </>
          }
          subtitle="We check that your Commander CLI is installed, launchable, and signed in. You never have to touch a terminal unless something's missing."
        />
      </Reveal>

      <CloudProviderKeyNotice deploymentMode={deploymentMode} />

      <Reveal delay={0.09}>
        <div className="flex flex-col items-center gap-3">
          <AgentCharacter
            state={busy || cliPolling ? "working" : outcome === "verified" ? "done" : "idle"}
            eyeColor={outcome === "verified" ? "#4a9a4a" : "#D13A26"}
          />
          <LoadingDots state={busy ? "loading" : outcome === "verified" ? "done" : "idle"} />
        </div>
      </Reveal>

      {/* Per-check breakdown. The founder can see WHICH part failed instead of
          reading one line and guessing whether the step passed. */}
      {checks.length > 0 && outcome !== "verified" && (
        <Reveal delay={0.14}>
          <ul
            aria-label="Verification checks"
            className="space-y-1 rounded-xl border border-border-strong bg-surface/40 p-3 text-left text-[11px]"
          >
            {checks.map((c, i) => {
              const passed = isPassedCheck(c);
              const failed = isFailedCheck(c);
              const technicalDetail = technicalDetailFor(c);
              // Three states, not two: info passes, error fails, and warn is a
              // real problem the founder must act on (that is how a recoverable
              // auth failure arrives) — so it must never render as a tick.
              const icon = passed ? "✓" : failed ? "✕" : "!";
              return (
                <li key={c.code ?? i} className="flex items-start gap-2">
                  <span
                    aria-hidden
                    className={passed ? "" : "text-destructive"}
                    style={passed ? { color: "var(--done)" } : undefined}
                  >
                    {icon}
                  </span>
                  <span className={passed ? "min-w-0 text-dim" : "min-w-0 text-destructive"}>
                    {c.message ?? c.code}
                    {!passed && c.hint && <span className="mt-0.5 block text-dim">{c.hint}</span>}
                    {!passed && technicalDetail && (
                      <details className="mt-1 text-dim">
                        <summary className="cursor-pointer select-none text-[11px] font-medium text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                          Technical details
                        </summary>
                        <pre className="mt-1 whitespace-pre-wrap break-words rounded-md border border-border bg-field p-2 font-mono text-[10px] leading-relaxed [overflow-wrap:anywhere]">
                          {technicalDetail}
                        </pre>
                      </details>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </Reveal>
      )}

      {outcome === "not_installed" && (
        <Reveal delay={0.18}>
          <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-950/20 p-3 text-left text-xs text-dim">
            <p className="text-text">The CLI isn't installed or isn't on your PATH.</p>
            <p>{installHint(topologyPlatform)}</p>
            <p className="text-text">Install it, then choose "Check again".</p>
          </div>
        </Reveal>
      )}
      {outcome === "needs_auth" && (
        <Reveal delay={0.18}>
          <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-950/20 p-3 text-left text-xs text-dim">
            <p className="text-text">
              {expiredAuthMessage(checks) ??
                authHintFrom(checks) ??
                `The ${providerLabel} CLI is installed but needs sign-in.`}{" "}
              Choose one:
            </p>
            {topologyLabel && (
              <p className="rounded-md border border-border bg-field px-2 py-1 text-[11px] text-dim">
                Detected installation: {topologyLabel}
              </p>
            )}

            <div className="space-y-2">
              <label className="block font-medium text-text" htmlFor="commander-api-key">
                Paste an API key
              </label>
              <input
                id="commander-api-key"
                type="password"
                autoComplete="off"
                className="w-full rounded-md border border-border-strong bg-field px-2 py-1.5 text-text outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                placeholder={provider === "openai" ? "sk-…" : "sk-ant-…"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={authBusy || !provider}
              />
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                onClick={() => void saveKeyAndReverify()}
                disabled={authBusy || !provider || !apiKey.trim()}
              >
                {authBusy ? "Working…" : "Save key & verify"}
              </Button>
            </div>

            {/* Capability-gated remote-safe subscription sign-in. */}
            {(provider === "openai" || provider === "anthropic") && capability?.enabled && (
              <>
                <div className="flex items-center gap-2 text-very-dim">
                  <span className="h-px flex-1 bg-border" />
                  or
                  <span className="h-px flex-1 bg-border" />
                </div>

                {login ? (
                  <div className="space-y-2">
                    <p>
                      {provider === "anthropic"
                        ? "Open this link to sign in, then paste the code it gives you below."
                        : "Open this link to finish signing in, then keep this tab open — we'll continue automatically:"}
                    </p>
                    <a
                      href={login.loginUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block break-all font-mono text-[11px] text-brand-hover underline"
                    >
                      Continue securely at {loginHost(login.loginUrl)}
                    </a>
                    <p>Waiting for sign-in… ({login.status})</p>
                    {login.expiresAt && (
                      <p className="text-[11px] text-dim">
                        This sign-in expires at {new Date(login.expiresAt).toLocaleTimeString()}.
                      </p>
                    )}

                    {login.mode === "device_code" && login.userCode && (
                      <div className="rounded-md border border-border bg-field p-3">
                        <p className="mb-1 text-dim">Enter this one-time code on that page:</p>
                        <code
                          aria-label="Codex device code"
                          className="block select-all text-center font-mono text-lg font-semibold tracking-widest text-text"
                        >
                          {login.userCode}
                        </code>
                        <Button
                          type="button"
                          variant="ghost"
                          className="mt-2 w-full"
                          onClick={() => void navigator.clipboard?.writeText(login.userCode ?? "")}
                        >
                          Copy code
                        </Button>
                      </div>
                    )}

                    {provider === "anthropic" && (
                      <div className="space-y-2 pt-1">
                        <label className="block font-medium text-text" htmlFor="commander-login-code">
                          Paste the code from that page
                        </label>
                        <input
                          id="commander-login-code"
                          type="text"
                          autoComplete="off"
                          className="w-full rounded-md border border-border-strong bg-field px-2 py-1.5 text-text outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                          placeholder="Paste code here"
                          value={loginCode}
                          onChange={(e) => setLoginCode(e.target.value)}
                          disabled={codeBusy}
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          className="w-full"
                          onClick={() => void submitCode()}
                          disabled={codeBusy || !loginCode.trim()}
                        >
                          {codeBusy ? "Submitting…" : "Submit code"}
                        </Button>
                        {codeError && <p className="text-destructive">{codeError}</p>}
                      </div>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-full"
                      onClick={() => void cancelLogin()}
                      disabled={authBusy}
                    >
                      Cancel sign-in
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    className="w-full"
                    onClick={() => void startLogin()}
                    disabled={authBusy || !provider}
                  >
                    {authBusy ? "Working…" : `Sign in with ${providerLabel}`}
                  </Button>
                )}
              </>
            )}
            {capability && !capability.enabled && (
              <div className="rounded-md border border-amber-500/30 bg-amber-950/20 p-2">
                <p className="font-medium text-text">Subscription sign-in is unavailable here.</p>
                <p>{capability.reason}</p>
              </div>
            )}

            {/* WS3 — CLI auto-detect: the fallback for BOTH providers when the
                in-app bridge above can't run (server restarted, spawn failed,
                or the founder just prefers a terminal). */}
            <div className="flex items-center gap-2 text-very-dim">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
            {cliPolling ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <LoadingDots state="loading" />
                  <p>
                    Run{" "}
                    <code className="rounded bg-field px-1 py-0.5">
                      {provider ? PROVIDER_CLI_LOGIN_COMMAND[provider] : "the CLI's sign-in command"}
                    </code>{" "}
                    in a terminal — we'll detect it automatically and continue.
                  </p>
                </div>
                <Button type="button" variant="ghost" className="w-full" onClick={clearCliPoll}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                onClick={startCliAutoDetect}
                disabled={authBusy}
              >
                I'll sign in myself in the CLI
              </Button>
            )}

            {authError && <p className="text-destructive">{authError}</p>}
          </div>
        </Reveal>
      )}
      {outcome === "failed" && (
        <Reveal delay={0.18}>
          <div className="space-y-1 text-left text-xs">
            {checks.length === 0 && (
              <p className="text-destructive">{message ?? "Verification failed."}</p>
            )}
            {authHintFrom(checks) && <p className="text-dim">{authHintFrom(checks)}</p>}
          </div>
        </Reveal>
      )}

      <Reveal delay={0.27}>
        <Button className="w-full" onClick={() => void check()} disabled={busy}>
          {busy ? "Checking…" : outcome === "idle" ? "Verify" : "Check again"}
        </Button>
      </Reveal>
    </StepShell>
  );
}
