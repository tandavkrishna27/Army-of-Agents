/**
 * Shared provider readiness card — the ONE rendering of "is this provider
 * usable?" consumed by all three surfaces: the Settings -> Providers tab, the
 * agent config badge, and onboarding's Verify step (design D6, "extract, don't
 * duplicate"). Two drifting copies of an auth flow is the failure mode this
 * whole feature exists to prevent.
 *
 * PRESENTATIONAL ONLY. It owns no fetching and holds no state beyond the
 * uncommitted key draft, so each surface supplies its own handlers and its own
 * loading/error policy.
 *
 * The governing rule, of which every branch below is one instance: NOTHING MAY
 * READ "Ready" WITHOUT AN OBSERVED WORKING RUN.
 */
import { useState } from "react";
import {
  ADAPTER_PROBE_BUSY_ERROR,
  ADAPTER_PROBE_RETRY_AFTER_SECONDS,
  getProviderById,
  isRunnableInstallCommand,
  type AdapterEnvironmentCheckLevel,
  type ProbeOutcome,
  type ProviderDescriptor,
  type ProviderId,
} from "@armyofagents/shared";
import { ApiError } from "../../api/client";
import {
  deriveCardStatus,
  keyInputState,
  loginUnavailableFrom,
  type ProviderLoginMode,
  type ProviderLoginStatus,
  type ProviderStatusRow,
  type ReadinessCheck,
  type ScopedReadiness,
} from "../../api/providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyText } from "@/components/CopyText";
import { relativeTime } from "@/lib/utils";

/* ── outcome vocabulary ────────────────────────────────────────────────── */

/**
 * Canonical founder-facing copy per outcome.
 *
 * The `never` default is load-bearing: adding a seventh `ProbeOutcome` must be
 * a COMPILE error here, not a card that silently renders a blank badge. A blank
 * badge reads as "fine" — which is exactly the false-green this surface exists
 * to remove.
 */
export function outcomeLabel(outcome: ProbeOutcome): string {
  switch (outcome) {
    case "verified":
      return "Ready";
    case "needs_auth":
      return "Needs sign-in";
    case "not_installed":
      return "Not installed";
    case "failed":
      return "Check failed";
    case "unknown":
      return "Not verified";
    case "unverifiable":
      return "Can't verify (custom command)";
    default:
      return assertExhaustiveOutcome(outcome, "Not verified");
  }
}

/**
 * Keep the COMPILE-time exhaustiveness, drop the RUNTIME throw.
 *
 * The `never` assignment still makes a seventh `ProbeOutcome` a build error,
 * which is the property worth having. Throwing on top of it is not: `outcome` is
 * documented as unvalidated at both ends — `probe-outcome.ts` notes drizzle's
 * `text(..., { enum })` emits no DB CHECK constraint, and
 * `server/src/routes/providers.ts` casts the stored value with
 * `(row?.outcome as ProbeOutcome | undefined) ?? "unknown"`. So a single stale
 * or hand-edited row would throw inside render and white-screen the entire
 * Providers tab. Degrading to the neutral "not verified" treatment is both safer
 * and more honest: an unrecognised verdict is precisely a verdict we don't have.
 */
function assertExhaustiveOutcome<T>(outcome: never, fallback: T): T {
  void outcome;
  return fallback;
}

export type OutcomeTone = "ready" | "neutral" | "warn" | "error";

/**
 * Tone per outcome. `unknown` and `unverifiable` are NEUTRAL on purpose —
 * nothing is broken in either case. "We haven't checked" and "we can't check a
 * custom command" are statements about our knowledge, not about the founder's
 * setup; painting them red cries wolf on a working machine and trains people to
 * ignore the one badge that matters.
 */
export function outcomeTone(outcome: ProbeOutcome): OutcomeTone {
  switch (outcome) {
    case "verified":
      return "ready";
    case "unknown":
    case "unverifiable":
      return "neutral";
    case "needs_auth":
    case "not_installed":
      return "warn";
    case "failed":
      return "error";
    default:
      // Same reasoning as outcomeLabel: unknown verdict -> neutral, never a throw.
      return assertExhaustiveOutcome(outcome, "neutral");
  }
}

/**
 * Per-check level styling, exhaustive over the SHARED
 * `AdapterEnvironmentCheckLevel`. Declared as a total Record rather than a
 * ternary chain so adding a fourth level is a compile error here instead of an
 * unstyled row that reads as ordinary text.
 */
const CHECK_LEVEL_CLASS: Record<AdapterEnvironmentCheckLevel, string> = {
  info: "text-muted-foreground",
  warn: "text-amber-700 dark:text-amber-300",
  error: "text-red-700 dark:text-red-300",
};

/**
 * Palette mirrors `AdapterEnvironmentResult` in AgentConfigForm.tsx.
 *
 * EXPORTED so the agent-config readiness badge paints the same tone the
 * Settings tab does. A second palette is how "Needs sign-in" ends up amber on
 * one surface and grey on another, and the greyer of two renderings is always
 * the one that gets believed.
 */
export const TONE_CLASS: Record<OutcomeTone, string> = {
  ready:
    "text-green-700 dark:text-green-300 border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10",
  neutral: "text-muted-foreground border-border bg-muted/40",
  warn:
    "text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10",
  error:
    "text-red-700 dark:text-red-300 border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10",
};

/**
 * Dot colour per tone, for the compact Providers list where a full pill is too
 * heavy. Kept beside TONE_CLASS so the list dot and the card pill are two views
 * of one palette, not two palettes.
 *
 * A verdict we HAVE is a FILLED dot (green/amber/red); a verdict we DON'T have
 * yet — `neutral`, i.e. not checked / can't check — is a HOLLOW ring, so
 * "pending" reads differently from a real status at a glance and a fresh
 * company's list is calm rings rather than a wall of dead grey fills.
 */
export const TONE_DOT: Record<OutcomeTone, string> = {
  ready: "bg-green-500",
  neutral: "border-2 border-muted-foreground/50",
  warn: "bg-amber-500",
  error: "bg-red-500",
};

/* ── install hint ──────────────────────────────────────────────────────── */

export type InstallPlatform = "mac" | "win" | "linux";

/**
 * The platform assumed when sniffing yields nothing recognisable — including
 * jsdom, which returns `""`. Named rather than inlined so tests that omit the
 * `platform` prop are exercising a DECLARED default instead of silently landing
 * on linux by falling off the end of a chain.
 */
export const DEFAULT_INSTALL_PLATFORM: InstallPlatform = "linux";

export function detectPlatform(): InstallPlatform {
  const p = typeof navigator !== "undefined" ? (navigator.platform || "").toLowerCase() : "";
  if (p.includes("mac")) return "mac";
  if (p.includes("win")) return "win";
  return DEFAULT_INSTALL_PLATFORM;
}

/**
 * A resolved install hint. `kind` is the load-bearing part.
 *
 * Not every platform entry is a command: Grok's is prose on all three, and
 * `cursor.win` / `opencode.win` are prose too ("See the Cursor CLI docs for
 * Windows install."). Rendering those the same way as `npm install -g …` — in a
 * monospace block under "run this" — tells a Windows founder to paste an English
 * sentence into a terminal. `docs` hints therefore render as PROSE PLUS A LINK,
 * with the link as the action, not as a decorative extra beneath a fake command.
 *
 * The command/prose distinction is drawn by the SHARED `isRunnableInstallCommand`
 * — the same predicate the catalog test uses to demand a `docsUrl` behind every
 * non-command hint — so the pin and the rendering cannot disagree.
 */
export type ResolvedInstallHint =
  | { kind: "command"; text: string; docsUrl?: string }
  | { kind: "docs"; text: string; docsUrl?: string };

/**
 * Pick the per-OS install hint. Returns `null` for managed runtimes that
 * declare none (Cursor Cloud) — there is nothing to install, so an empty
 * "install this" block would be an instruction to do nothing.
 *
 * Lives here rather than inline in JSX so the three consuming surfaces cannot
 * each grow their own subtly different OS detection.
 */
export function installHintFor(
  hint: ProviderDescriptor["installHint"] | undefined,
  platform: InstallPlatform = detectPlatform(),
): ResolvedInstallHint | null {
  if (!hint) return null;
  const text = hint[platform];
  return {
    kind: isRunnableInstallCommand(text) ? "command" : "docs",
    text,
    ...(hint.docsUrl ? { docsUrl: hint.docsUrl } : {}),
  };
}

/* ── error copy ────────────────────────────────────────────────────────── */

/**
 * A rejection rendered for founders.
 *
 * `transient` separates "this is broken" from "this is busy, try again in a
 * moment". A 429 probe back-off and a 409 host-login-slot conflict are both the
 * system working as designed under contention; painting them in destructive red
 * next to a status badge whose whole job is signalling breakage is the same
 * cry-wolf failure as colouring `unverifiable` as an error.
 */
export interface ProviderActionError {
  text: string;
  transient: boolean;
}

/**
 * Turn any rejection into founder-readable copy. Centralised so all three
 * surfaces render the same words for the same failure.
 *
 * The 429 window comes from the SHARED constant, never a literal 30: hardcoding
 * it would promise a retry window the server stops honouring the first time its
 * back-off changes.
 */
export function providerActionError(err: unknown): ProviderActionError | null {
  if (err === null || err === undefined) return null;
  if (typeof err === "string") return err ? { text: err, transient: false } : null;

  const unavailable = loginUnavailableFrom(err);
  if (unavailable) {
    return {
      text: unavailable.manualCommand
        ? `${unavailable.error} Run \`${unavailable.manualCommand}\` in a terminal instead.`
        : unavailable.error,
      transient: false,
    };
  }

  if (err instanceof ApiError) {
    if (err.status === 429) {
      return {
        text: `${ADAPTER_PROBE_BUSY_ERROR} Try again in about ${ADAPTER_PROBE_RETRY_AFTER_SECONDS} seconds.`,
        transient: true,
      };
    }
    // A 409 means different things on different routes: the host login slot
    // (shared across every company on this machine) OR a concurrent provider-key
    // save. Each ships its own actionable server message, so show it verbatim
    // rather than rewriting one as the other's remedy (a key-save conflict must
    // not read as "another company is signing in"). Both are transient, so the
    // styling stays non-destructive. Fall back to a friendly generic line only
    // when the server gave nothing useful (a bare "Conflict").
    if (err.status === 409) {
      const raw = err.message?.trim();
      const useful = Boolean(raw) && !/^conflict$/i.test(raw);
      return {
        text: useful
          ? raw
          : "This provider is busy with another request on this machine. Try again shortly.",
        transient: true,
      };
    }
  }

  if (err instanceof Error) return { text: err.message, transient: false };
  return { text: "Something went wrong.", transient: false };
}

/** Text-only convenience for callers that don't need the tone. */
export function providerActionErrorCopy(err: unknown): string | null {
  return providerActionError(err)?.text ?? null;
}

/* ── component ─────────────────────────────────────────────────────────── */

/**
 * Per-action busy flags. A single boolean made the Test spinner disable the key
 * input and the Sign in button, so a founder who pressed Test could not start
 * typing a key while the probe ran. `true` still means "everything", which keeps
 * the simple call sites simple.
 */
export interface ProviderCardBusy {
  test?: boolean;
  key?: boolean;
  login?: boolean;
}

export interface ProviderReadinessCardProps {
  row: ProviderStatusRow;
  onTest(): void;
  /**
   * Resolve to commit the key (the card clears its draft), reject to surface the
   * failure. The card awaits this itself so no surface has to remember to.
   */
  onSaveKey(value: string): Promise<void>;
  /**
   * Omitted by surfaces that do not offer interactive login. Even when supplied
   * the button only renders for a self-completing provider.
   */
  onStartLogin?(): void;
  /** Cancel an in-flight login; the host slot is shared, so releasing it matters. */
  onCancelLogin?(): void;
  /**
   * In-flight login challenge, when the surface is polling one. Lives on the
   * shared card rather than the page so challenge progress cannot drift between
   * the three surfaces (design D6).
   */
  login?: {
    status: ProviderLoginStatus;
    loginUrl: string | null;
    mode: ProviderLoginMode;
    userCode: string | null;
    expiresAt: string;
  } | null;
  /**
   * Navigate to another provider's card. Supplied by surfaces that render more
   * than one (the Settings tab); without it a borrower renders plain text rather
   * than a control that does nothing.
   */
  onOpenProvider?(ownerId: ProviderId): void;
  busy?: boolean | ProviderCardBusy;
  /**
   * Accepts a raw rejection as well as a prepared string, so every surface gets
   * the 429/409/login-unavailable copy for free instead of re-deriving it.
   */
  error?: unknown;
  /** Test seam; defaults to sniffing `navigator`. */
  platform?: InstallPlatform;
}

function normalizeBusy(busy: boolean | ProviderCardBusy | undefined): Required<ProviderCardBusy> {
  if (busy === true) return { test: true, key: true, login: true };
  if (!busy) return { test: false, key: false, login: false };
  return { test: Boolean(busy.test), key: Boolean(busy.key), login: Boolean(busy.login) };
}

export function ProviderReadinessCard({
  row,
  onTest,
  onSaveKey,
  onStartLogin,
  onCancelLogin,
  login = null,
  onOpenProvider,
  busy = false,
  error = null,
  platform,
}: ProviderReadinessCardProps) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const { descriptor, companyDefault } = row;
  const { outcome, failingAgents, unverifiableAgents, uncheckedAgents, canClaimReady } =
    deriveCardStatus(row);

  const busyFlags = normalizeBusy(busy);
  const keyBusy = busyFlags.key || saving;

  // A verified company default is NOT sufficient to show a bare "Ready": an
  // agent binds its own credential via adapterConfig.env, so the company key can
  // authenticate while that agent's revoked key still 401s.
  const badge = deriveProviderBadge(row);
  const keyState = keyInputState(row);
  const install =
    outcome === "not_installed" ? installHintFor(descriptor.installHint, platform) : null;
  // A save rejection belongs to the key input and must not be clobbered by, or
  // clobber, a probe error the surface passed down.
  const shownError = providerActionError(saveError ?? error);
  const canSignIn = descriptor.credential.selfCompletingLogin && Boolean(onStartLogin);
  /*
    Codex is `selfCompletingLogin: true` and therefore renders a button HERE —
    but a surface that passes no `onStartLogin` (the agent-config badge) would
    otherwise show "Needs sign-in" with no remediation whatsoever. The catalog
    now carries `codex login` for exactly that fallback.
  */
  const manualCommand = descriptor.credential.manualLoginCommand;
  /*
    Don't offer sign-in on a card that is already verified — a green Claude card
    telling the founder to "sign in from a terminal, then run the check again" is
    instructing them to fix something that isn't broken.
  */
  const showLoginSection = outcome !== "verified" && (canSignIn || Boolean(manualCommand));

  /*
    The probe's REASONS. Without these a `failed` card is a verdict with no
    evidence — "Check failed" and nothing else — which is the mirror image of the
    false-green: a claim the founder can neither verify nor act on. Suppressed on
    a clean verified card, where per-check noise adds nothing.
  */
  const checksToShow = canClaimReady ? [] : companyDefault.checks;

  const saveKey = async () => {
    const value = draft.trim();
    if (!value) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSaveKey(value);
      // Clear only on success. Leaving the live secret in the input under a
      // now-"Replace API key" label invites a duplicate write of the same value.
      setDraft("");
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3" data-testid="provider-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{descriptor.label}</div>
          {companyDefault.testedAt && (
            <div
              className="text-[11px] text-muted-foreground"
              data-testid="provider-checked-at"
              // Relative reads as freshness ("is this verdict current?"), which
              // is the only question this line answers; the exact instant stays
              // available on hover for anyone correlating with a log.
              title={new Date(companyDefault.testedAt).toLocaleString()}
            >
              checked {relativeTime(companyDefault.testedAt)}
            </div>
          )}
        </div>
        {/*
          role="status" + aria-live: pressing Test swaps this badge in place. On
          the one surface whose entire purpose is announcing status, a
          screen-reader user would otherwise get silence. Matches the convention
          in AgentSaveWarnings / ComposerSendFailedBanner.
        */}
        <span
          data-testid="provider-status-badge"
          role="status"
          aria-live="polite"
          className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium ${TONE_CLASS[badge.tone]}`}
        >
          {badge.label}
        </span>
      </div>

      {failingAgents.length > 0 && (
        <div
          data-testid="provider-failing-agents"
          className={`rounded-md border px-3 py-2 text-xs space-y-1 ${TONE_CLASS.warn}`}
        >
          <p className="font-medium">These agents can't run on this provider</p>
          <ul className="space-y-0.5">
            {failingAgents.map((a) => (
              <li key={a.scopeId ?? a.agentName}>
                {agentName(a)} — {outcomeLabel(a.outcome)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        NEVER-PROBED agents. Its own neutral block, and the heading follows the
        BUCKET rather than the other way round: these agents were previously
        listed under "These agents can't run on this provider", which asserted
        breakage on the strength of not having looked. On a fresh company every
        agent lands here, so that heading was the first thing a new founder read.

        No remediation promise is made, because this card cannot keep one: the
        Test button probes the COMPANY DEFAULT scope only. Agent scopes are
        probed from the agent's own surface, so "press Test to check them" would
        be false.
      */}
      {uncheckedAgents.length > 0 && (
        <div
          data-testid="provider-unchecked-agents"
          className={`rounded-md border px-3 py-2 text-xs space-y-1 ${TONE_CLASS.neutral}`}
        >
          <p className="font-medium">Not checked yet</p>
          <ul className="space-y-0.5">
            {uncheckedAgents.map((a) => (
              <li key={a.scopeId ?? a.agentName}>{agentName(a)}</li>
            ))}
          </ul>
        </div>
      )}

      {/*
        Deliberately a SEPARATE, neutral block. These agents run a custom command
        we cannot probe — nothing is known to be wrong. They are never described
        as "waived": a waiver is a recorded human decision, and the only place one
        exists is onboarding. Calling an unprobed agent "waived" here would invent
        consent nobody gave.
      */}
      {unverifiableAgents.length > 0 && (
        <div
          data-testid="provider-unverifiable-agents"
          className={`rounded-md border px-3 py-2 text-xs space-y-1 ${TONE_CLASS.neutral}`}
        >
          <p className="font-medium">Can't be checked (custom command)</p>
          <ul className="space-y-0.5">
            {unverifiableAgents.map((a) => (
              <li key={a.scopeId ?? a.agentName}>{agentName(a)}</li>
            ))}
          </ul>
        </div>
      )}

      {install && (
        <div
          data-testid="provider-install-hint"
          className={`rounded-md border px-3 py-2 text-xs space-y-1 ${TONE_CLASS.warn}`}
        >
          {install.kind === "command" ? (
            <>
              <p>Install it, then run the check again:</p>
              <span data-testid="provider-install-command">
                <CopyText
                  text={install.text}
                  className="block break-all font-mono text-[11px] text-left"
                />
              </span>
            </>
          ) : (
            /*
              Prose, NOT a command — rendering it in a monospace "run this" block
              would invite pasting an English sentence into a terminal. The link
              is the action here.
            */
            <p data-testid="provider-install-docs">{install.text}</p>
          )}
          {install.docsUrl && (
            <a
              href={install.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="block break-all underline"
            >
              {install.kind === "docs" ? "Open the install docs" : install.docsUrl}
            </a>
          )}
        </div>
      )}

      {keyState.kind === "owned_elsewhere" ? (
        <div className="text-xs text-muted-foreground" data-testid="provider-key-owned-elsewhere">
          {/*
            A real control when the surface can navigate, plain prose when it
            can't. The previous version always rendered a "→" with no href and no
            handler: the founder was told where to go and given nothing to click.
          */}
          {onOpenProvider ? (
            <button
              type="button"
              data-testid="provider-key-owner-link"
              className="underline hover:text-foreground"
              onClick={() => onOpenProvider(keyState.ownerId)}
            >
              Managed on the {ownerLabel(keyState.ownerId)} card →
            </button>
          ) : (
            <span>Managed on the {ownerLabel(keyState.ownerId)} card.</span>
          )}
        </div>
      ) : keyState.kind === "hidden" ? null : (
        <div className="space-y-1.5" data-testid="provider-key-section">
          <label className="block text-xs font-medium" htmlFor={`provider-key-${descriptor.id}`}>
            {keyState.kind === "replace" ? "Replace API key" : "Add an API key"}
          </label>
          <Input
            id={`provider-key-${descriptor.id}`}
            data-testid="provider-key-input"
            type="password"
            autoComplete="off"
            placeholder={descriptor.credential.apiKey?.placeholder ?? ""}
            value={draft}
            disabled={keyBusy}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="provider-key-save"
            disabled={keyBusy || draft.trim().length === 0}
            onClick={() => {
              void saveKey();
            }}
          >
            {saving ? "Saving…" : "Save key"}
          </Button>
          {/*
            D5 scope honesty. A pasted key is stored per-company; the interactive
            login below writes a HOST-SHARED credential home. Same button row,
            very different blast radius — label them differently or the founder
            reasonably assumes one undoes the other.
          */}
          <p className="text-[11px] text-muted-foreground">
            Saving a key here applies to this company only.
          </p>
        </div>
      )}

      {showLoginSection && (
        <div className="space-y-1.5" data-testid="provider-login-section">
          {canSignIn ? (
            <>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="provider-signin"
                disabled={busyFlags.login || login?.status === "pending"}
                onClick={() => onStartLogin?.()}
              >
                {login?.status === "pending" ? "Waiting for sign-in…" : "Sign in"}
              </Button>
              {login?.status === "pending" && (
                <div className="space-y-1" data-testid="provider-login-progress">
                  {login.loginUrl && (
                    <a
                      href={login.loginUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block break-all text-xs underline"
                    >
                      Finish sign-in in your browser
                    </a>
                  )}
                  {login.mode === "device_code" && login.userCode && (
                    <div
                      className="space-y-2 rounded-md border border-border bg-muted/30 p-3"
                      data-testid="provider-device-code"
                    >
                      <p className="text-xs text-muted-foreground">Codex device code</p>
                      <code
                        aria-label="Codex device code"
                        className="block select-all font-mono text-base font-semibold tracking-wider"
                      >
                        {login.userCode}
                      </code>
                      <CopyText
                        text={login.userCode}
                        className="min-h-11 rounded-md border border-border px-3 text-xs font-medium"
                        copiedLabel="Code copied"
                      >
                        Copy code
                      </CopyText>
                    </div>
                  )}
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="provider-login-expiry"
                  >
                    Expires {new Date(login.expiresAt).toLocaleString()}
                  </p>
                  {onCancelLogin && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid="provider-login-cancel"
                      onClick={onCancelLogin}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              )}
            </>
          ) : (
            /*
              No Sign in button: either this provider's login cannot finish in-app
              (Claude's blocks on a paste-code stdin prompt) or this surface passed
              no handler. Either way the terminal command is the remediation, so
              the card is never a dead end.
            */
            <>
              <p className="text-xs text-muted-foreground">
                Sign in from a terminal, then run the check again:
              </p>
              <span data-testid="provider-manual-login">
                <CopyText
                  text={manualCommand ?? ""}
                  className="block break-all font-mono text-[11px] text-left"
                />
              </span>
            </>
          )}
          {/*
            D5 scope honesty, phrased as SCOPE rather than STATE. The old copy read
            "Signed in on this machine (…)" unconditionally — a present-tense claim
            of being signed in, rendered inches beneath a badge saying you are not.
          */}
          <p className="text-[11px] text-muted-foreground">
            Signing in here applies to this whole machine — every company on this host shares it.
          </p>
        </div>
      )}

      {checksToShow.length > 0 && (
        <ul className="space-y-1" data-testid="provider-checks">
          {checksToShow.map((check, idx) => (
            <li
              key={`${check.code}-${idx}`}
              data-testid="provider-check"
              className="text-[11px] leading-relaxed break-words"
            >
              <span
                className={`font-medium uppercase tracking-wide ${CHECK_LEVEL_CLASS[check.level]}`}
              >
                {check.level}
              </span>
              <span className="mx-1 opacity-60">·</span>
              <span>{check.message}</span>
              {check.detail && <span className="block opacity-75 break-all">({check.detail})</span>}
              {check.hint && <span className="block opacity-90 break-words">Hint: {check.hint}</span>}
            </li>
          ))}
        </ul>
      )}

      {shownError && (
        <p
          role="alert"
          className={`text-xs ${shownError.transient ? "text-muted-foreground" : "text-destructive"}`}
          data-testid="provider-error"
        >
          {shownError.text}
        </p>
      )}

      <Button
        type="button"
        size="sm"
        data-testid="provider-test"
        disabled={busyFlags.test}
        onClick={onTest}
      >
        {busyFlags.test ? "Checking…" : "Test"}
      </Button>
    </div>
  );
}

function agentName(a: ScopedReadiness): string {
  return a.agentName ?? a.scopeId ?? "Unnamed agent";
}

/** Owner's display label, falling back to its id if the catalog ever loses it. */
function ownerLabel(ownerId: ProviderId): string {
  return getProviderById(ownerId)?.label ?? ownerId;
}

/**
 * The one badge computation, shared by the card (its status pill) and the
 * Providers list (its status dot). Both call THIS, so a list dot cannot drift
 * from the card badge for the same row — the drift this initiative exists to
 * prevent, applied to the list surface.
 */
export function deriveProviderBadge(
  row: ProviderStatusRow,
): { label: string; tone: OutcomeTone } {
  const { outcome, failingAgents, unverifiableAgents, uncheckedAgents, canClaimReady } =
    deriveCardStatus(row);
  return badgeFor(outcome, canClaimReady, failingAgents, unverifiableAgents, uncheckedAgents);
}

/**
 * The badge. When the company default is verified but `canClaimReady` is false,
 * the label MUST carry the exception — a bare "Ready" would hide a failing
 * agent behind a green pill, which is the precise bug this feature removes.
 */
function badgeFor(
  outcome: ProbeOutcome,
  canClaimReady: boolean,
  failingAgents: ScopedReadiness[],
  unverifiableAgents: ScopedReadiness[],
  uncheckedAgents: ScopedReadiness[],
): { label: string; tone: OutcomeTone } {
  if (outcome !== "verified" || canClaimReady) {
    return { label: outcomeLabel(outcome), tone: outcomeTone(outcome) };
  }
  /*
    PRECEDENCE, most to least actionable. The pill fits one clause, so when
    several buckets are non-empty the badge names exactly one and the others are
    still listed in full in their own blocks below — deprioritised, never hidden.

      1. FAILING dominates. An agent that cannot run is actionable right now.
      2. UNVERIFIABLE next. A custom command we can never probe is a permanent
         property of the setup, so it is the more durable thing to surface.
      3. UNCHECKED last. The weakest statement of the three and the easiest to
         resolve — and on a fresh company it is simply everything, so leading
         with it would make every new tab shout about its own ignorance.

    TONE — only FAILING is a warning (amber). UNVERIFIABLE stays NEUTRAL: a
    custom command we can never probe is genuinely unknowable, so any colour
    would over-claim. UNCHECKED is READY (green): the company key is verified
    and nothing is failing, so the provider itself works — "not checked yet" is
    a caveat carried in the LABEL and the detail block, not a reason to grey out
    a working provider. A failing agent still forces amber, so a green dot never
    hides a broken agent (the false-green this feature removed is untouched).
  */
  if (failingAgents.length > 0) {
    return {
      label: `Ready, ${failingAgents.length} ${plural(failingAgents.length, "agent")} failing`,
      tone: "warn",
    };
  }
  if (unverifiableAgents.length > 0) {
    const n = unverifiableAgents.length;
    return { label: `Ready, ${n} ${plural(n, "agent")} can't be checked`, tone: "neutral" };
  }
  const n = uncheckedAgents.length;
  return { label: `Ready, ${n} ${plural(n, "agent")} not checked yet`, tone: "ready" };
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
