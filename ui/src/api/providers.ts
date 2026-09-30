/**
 * Settings -> Providers API client.
 *
 * The typed mirror of `server/src/routes/providers.ts`. That file's
 * `RESPONSE CONTRACT` block is authoritative — when this module and the plan's
 * sketch disagree, the route wins, and every divergence is called out inline
 * below.
 *
 * Two rules govern the shapes here:
 *
 *  1. NOTHING IS RETYPED. `ProbeOutcome` / `PROBE_OUTCOMES` and
 *     `ProviderDescriptor` / `ProviderId` are imported from
 *     `@armyofagents/shared` and re-exported, never re-declared. A local copy
 *     that drifts from the classifier is the exact class of bug this feature
 *     exists to remove — the readiness pinning test in
 *     `__tests__/providers-api.test.ts` asserts the re-export by identity.
 *
 *  2. NO SCOPE FALLBACK. A provider carries a `companyDefault` scope AND one
 *     scope per in-use agent. An agent with no entry means "never probed" and
 *     must read as absent — `readinessForScope` deliberately has no
 *     `?? row.companyDefault` branch. An agent's own `adapterConfig.env`
 *     binding wins over the company key at runtime, so "the company default
 *     authenticates" does not imply "this agent can run".
 */
import {
  ADAPTER_PROBE_BUSY_ERROR,
  ADAPTER_PROBE_RETRY_AFTER_SECONDS,
  PROBE_OUTCOMES,
  type AdapterEnvironmentCheckLevel,
  type ProbeOutcome,
  type ProviderDescriptor,
  type ProviderId,
} from "@armyofagents/shared";
import { ApiError, api } from "./client";

export { ADAPTER_PROBE_BUSY_ERROR, ADAPTER_PROBE_RETRY_AFTER_SECONDS, PROBE_OUTCOMES };
export type {
  AdapterEnvironmentCheckLevel,
  ProbeOutcome,
  ProviderDescriptor,
  ProviderId,
};

/* ── wire shapes ───────────────────────────────────────────────────────── */

/**
 * One redacted probe check. `detail` is present on the wire (`redactChecks`
 * preserves it) even though the plan's sketch omitted it.
 *
 * `level` is the SHARED union, not `string`. `redactChecks` passes `c.level`
 * straight through from `AdapterEnvironmentCheck`, so the wire value is always
 * one of three — and the card switches on it for icon/colour. Typing it as
 * `string` would remove the exhaustiveness check, so a future fourth level
 * would ship as a silently unstyled row.
 */
export interface ReadinessCheck {
  code: string;
  level: AdapterEnvironmentCheckLevel;
  message: string;
  detail?: string | null;
  hint?: string | null;
}

/** `ScopedReadinessDto` — one scope of one provider. */
export interface ScopedReadiness {
  scopeType: "company_default" | "agent";
  /** Agent id for an agent scope; `null` for the company default. */
  scopeId: string | null;
  /** Agent scope only, for UI labelling. */
  agentName?: string;
  /** `"unknown"` when THIS scope specifically was never probed. */
  outcome: ProbeOutcome;
  /** ISO timestamp; `null` when never probed. */
  testedAt: string | null;
  checks: ReadinessCheck[];
}

/**
 * `ExistingKeyDto` — whether a key already exists and under WHICH binding.
 * Never the value.
 *
 * NOT in the plan's sketch. `source: "external"` means the key lives outside
 * the `provider:*` namespace (Settings -> Memory's `llm:*`, the bare env-var
 * name, or Commander onboarding's `Commander <p> API key`), so a founder who
 * pasted one during Commander onboarding is not shown an empty input inviting a
 * duplicate paste. All three of `source` / `secretName` / `envVar` are nullable:
 * `envVar: null` means the provider has no key input at all (OpenCode brokers
 * its own credentials).
 */
export interface ExistingKey {
  configured: boolean;
  source: "provider" | "external" | null;
  secretName: string | null;
  envVar: string | null;
}

/** One row of `GET /companies/:cid/providers`. */
export interface ProviderStatusRow {
  /** Verbatim `PROVIDER_CATALOG` entry. */
  descriptor: ProviderDescriptor;
  /** Company key / host login only. ALWAYS present. */
  companyDefault: ScopedReadiness;
  /** In-use agents on this provider, each probed with its OWN config. May be []. */
  agents: ScopedReadiness[];
  /** ADDITION over the plan's sketch — see `ExistingKey`. */
  existingKey: ExistingKey;
}

export interface ProviderListResponse {
  providers: ProviderStatusRow[];
}

/**
 * The scope to probe. A discriminated union so an agent probe cannot be
 * requested without an `agentId`: probing the company default and labelling the
 * result as an agent's status is the false-green this surface removes.
 */
export type ProbeScope =
  | { scopeType: "company_default" }
  | { scopeType: "agent"; agentId: string };

/**
 * Compile-time pin: the agent arm's `agentId` must stay REQUIRED.
 *
 * `providersApi.test` also guards at runtime, but that guard narrows the type
 * inside its own branch — so relaxing `agentId` to optional would compile
 * silently and merely downgrade a build error into a rejected promise at the
 * call site. This assertion is what makes the union's guarantee load-bearing.
 */
type Assert<T extends true> = T;
type _AgentScopeRequiresAgentId = Assert<
  Extract<ProbeScope, { scopeType: "agent" }> extends { agentId: string } ? true : false
>;

/**
 * Compile-time pin: `ReadinessCheck["level"]` must stay the shared union.
 *
 * Widening it back to `string` breaks no consumer in this module, so nothing
 * else would catch it — the damage lands later, in the card that switches on
 * `level` and loses its exhaustiveness check.
 */
type _CheckLevelIsSharedUnion = Assert<
  ReadinessCheck["level"] extends AdapterEnvironmentCheckLevel ? true : false
>;

/**
 * `POST /:providerId/test` response.
 *
 * DIVERGENCE: the plan's sketch typed this as the full `ScopedReadiness`. The
 * route returns `probeAndRecord`'s result, which carries no `scopeType` /
 * `scopeId` — the caller already knows the scope it asked for. `testedAt` is
 * non-null here because a probe just ran.
 */
export interface ProbeResult {
  outcome: ProbeOutcome;
  checks: ReadinessCheck[];
  testedAt: string;
}

/**
 * `POST /:providerId/key` response.
 *
 * `reprobed` / `invalidated` are ADDITIONS over the plan's sketch. Saving a key
 * changes the credential for every provider resolving to the same secret
 * (Cursor + Cursor Cloud share `provider:cursor`; Pi + Claude share
 * `provider:anthropic`), so the whole group is refreshed. Each group member
 * lands in exactly one array; `invalidated` means the cached row was dropped
 * without a fresh verdict, so that card renders `unknown` until tested.
 */
export interface SaveKeyResult {
  ok: boolean;
  secretId: string;
  reprobed: ProviderId[];
  invalidated: ProviderId[];
}

export type ProviderLoginStatus = "pending" | "completed" | "failed" | "timeout";
export type ProviderLoginMode = "device_code" | "paste_code";

export interface StartLoginResult {
  challengeId: string;
  loginUrl: string;
  mode: ProviderLoginMode;
  userCode: string | null;
  expiresAt: string;
}

/**
 * `GET /:providerId/login/:challengeId` response.
 *
 * `readiness` is an ADDITION over the plan's sketch: it is non-null only on the
 * poll that first observes `completed`, because a finished login changes what
 * the host authenticates as and the cached company_default row is stale that
 * instant. Best-effort — a failed or slot-blocked re-probe still reports the
 * completion with `readiness: null`.
 */
export interface LoginStatusResult {
  status: ProviderLoginStatus;
  loginUrl: string | null;
  readiness: ScopedReadiness | null;
}

/**
 * The body of a 400 from `login/start`. Claude's CLI login blocks on a stdin
 * paste-code prompt after a remote callback, so an in-app button could never
 * finish; the UI renders `manualCommand` as copyable text instead. Its absence
 * means the provider documents no login command at all.
 */
export interface LoginUnavailable {
  error: string;
  canLogin: false;
  manualCommand?: string;
}

/* ── helpers ───────────────────────────────────────────────────────────── */

/**
 * Read the readiness for one scope, or `undefined` when THAT scope was never
 * probed.
 *
 * There is deliberately no fallback to `row.companyDefault`. Callers must
 * render an absent agent scope as unchecked.
 */
export function readinessForScope(
  row: ProviderStatusRow,
  scope: ProbeScope,
): ScopedReadiness | undefined {
  if (scope.scopeType === "company_default") return row.companyDefault;
  return row.agents.find((a) => a.scopeId === scope.agentId);
}

/** What the card should offer in place of an API-key input. */
export type KeyInputState =
  /** The provider has no key binding at all (OpenCode brokers its own). */
  | { kind: "hidden" }
  /** No key configured yet — first paste. */
  | { kind: "add" }
  /** A key already exists under some known binding — this is a rotation. */
  | { kind: "replace" }
  /**
   * This provider READS a credential another provider OWNS. The card must link
   * to the owner instead of rendering a second input.
   */
  | { kind: "owned_elsewhere"; ownerId: ProviderId };

/**
 * What the card should offer for the API-key input.
 *
 * `credentialOwnerId` is checked FIRST and is decisive. A borrower declares its
 * own `apiKey` spec, and the server resolves `existingKey` through
 * `getCredentialOwner`, so a borrower's `envVar` is the OWNER's and is non-null
 * — keying off `existingKey` alone would render a second input on the borrower's
 * card. Two inputs writing one secret means saving either silently overwrites
 * the other (`provider-catalog.ts`, `credentialOwnerId`).
 *
 * Two of eight providers are affected: `cursor_cloud` -> `cursor`, and
 * `pi` -> `anthropic`. Pi is the dangerous one: `provider:anthropic` is where a
 * stored key overrides subscription auth for `claude_local`, so a founder
 * pasting an xAI key into the Pi card would silently repoint Claude.
 */
export function keyInputState(row: ProviderStatusRow): KeyInputState {
  const ownerId = row.descriptor.credential.credentialOwnerId;
  if (ownerId) return { kind: "owned_elsewhere", ownerId };
  if (row.existingKey.envVar === null) return { kind: "hidden" };
  return { kind: row.existingKey.configured ? "replace" : "add" };
}

/**
 * Narrow a `login/start` rejection to the "cannot self-complete" body, or
 * `null` for every other failure (404 unknown provider, 409 host slot held,
 * 502 no verification URL, network errors).
 *
 * `ApiError` retains the parsed body, so this is a real narrowing rather than a
 * cast at the call site.
 */
export function loginUnavailableFrom(err: unknown): LoginUnavailable | null {
  if (!(err instanceof ApiError) || err.status !== 400) return null;
  const body = err.body;
  if (!body || typeof body !== "object") return null;
  const { canLogin, manualCommand, error } = body as {
    canLogin?: unknown;
    manualCommand?: unknown;
    error?: unknown;
  };
  if (canLogin !== false) return null;
  return {
    error: typeof error === "string" ? error : err.message,
    canLogin: false,
    ...(typeof manualCommand === "string" ? { manualCommand } : {}),
  };
}

/**
 * A card may only claim plain "Ready" when the company default is verified AND
 * no in-use agent is failing. Otherwise the tab would show green while an
 * agent's own (revoked) binding still 401s — the false-green this feature
 * exists to remove.
 *
 * THREE non-verified buckets, not one. The distinction is the entire point of
 * this surface, and collapsing any two of them produces a lie:
 *
 *   - `failingAgents` — `needs_auth` / `not_installed` / `failed`. We probed and
 *     it did not work. Only these may be described as unable to run.
 *   - `unverifiableAgents` — `unverifiable`. A custom command we cannot probe by
 *     design. Nothing is known to be wrong and nothing ever will be knowable
 *     from here.
 *   - `uncheckedAgents` — `unknown`. We have not looked, or we looked and
 *     learned nothing (`probe-outcome.ts` documents both readings). This is the
 *     DEFAULT STATE OF A FRESH COMPANY: every agent starts `unknown` with a null
 *     `testedAt`.
 *
 * Folding `unknown` into `failingAgents` — which this function did until live
 * driving caught it — made a brand-new company's first view of the tab announce
 * "9 agents failing" and "these agents can't run on this provider" purely on the
 * strength of never having looked. That is the same false claim of certainty the
 * feature exists to remove, merely pointed at red instead of green.
 *
 * All three still block a bare "Ready" — `canClaimReady` is a claim about what
 * we KNOW, and two of these buckets are statements of ignorance. But blocking a
 * green claim and asserting breakage are different things, and only the first is
 * warranted by ignorance.
 *
 * Do NOT call any of these "waived": a waiver is a recorded human decision, and
 * the only place one exists is the onboarding step. Labelling an unprobed agent
 * "waived" would fabricate consent nobody gave.
 */
export function deriveCardStatus(row: ProviderStatusRow): {
  outcome: ProbeOutcome;
  failingAgents: ScopedReadiness[];
  unverifiableAgents: ScopedReadiness[];
  uncheckedAgents: ScopedReadiness[];
  canClaimReady: boolean;
} {
  const failingAgents = row.agents.filter(
    (a) =>
      a.outcome !== "verified" && a.outcome !== "unverifiable" && a.outcome !== "unknown",
  );
  const unverifiableAgents = row.agents.filter((a) => a.outcome === "unverifiable");
  const uncheckedAgents = row.agents.filter((a) => a.outcome === "unknown");
  return {
    outcome: row.companyDefault.outcome,
    failingAgents,
    unverifiableAgents,
    uncheckedAgents,
    canClaimReady:
      row.companyDefault.outcome === "verified" &&
      failingAgents.length === 0 &&
      unverifiableAgents.length === 0 &&
      uncheckedAgents.length === 0,
  };
}

/* ── client ────────────────────────────────────────────────────────────── */

export const providersApi = {
  list: (companyId: string) =>
    api.get<ProviderListResponse>(`/companies/${companyId}/providers`),

  /**
   * Probe a specific SCOPE. The default probes the company key / host login;
   * an agent scope probes that agent with its own persisted `adapterConfig`.
   * The agent readiness badge cannot work without these parameters.
   */
  test: (
    companyId: string,
    providerId: ProviderId,
    scope: ProbeScope = { scopeType: "company_default" },
  ): Promise<ProbeResult> => {
    const qs = new URLSearchParams({ scope: scope.scopeType });
    if (scope.scopeType === "agent") {
      // Runtime backstop for callers that lost the union guarantee (untyped
      // JS, an `any` boundary). Falling through would send
      // `agentId=undefined` and get back a COMPANY-DEFAULT verdict that the
      // caller would then render against the agent.
      if (!scope.agentId) {
        return Promise.reject(new Error("agentId is required for an agent-scoped probe"));
      }
      qs.set("agentId", scope.agentId);
    }
    return api.post<ProbeResult>(
      `/companies/${companyId}/providers/${providerId}/test?${qs.toString()}`,
      {},
    );
  },

  /** Founder-only. The raw value is never echoed back in any shape. */
  saveKey: (companyId: string, providerId: ProviderId, value: string) =>
    api.post<SaveKeyResult>(`/companies/${companyId}/providers/${providerId}/key`, { value }),

  /**
   * Founder-only. Rejects with a 400 whose body narrows via
   * `loginUnavailableFrom` when the provider's CLI login needs a terminal.
   */
  startLogin: (companyId: string, providerId: ProviderId) =>
    api.post<StartLoginResult>(
      `/companies/${companyId}/providers/${providerId}/login/start`,
      {},
    ),

  /** Poll. Callers SHOULD stop on a terminal status. */
  loginStatus: (companyId: string, providerId: ProviderId, challengeId: string) =>
    api.get<LoginStatusResult>(
      `/companies/${companyId}/providers/${providerId}/login/${challengeId}`,
    ),

  cancelLogin: (companyId: string, providerId: ProviderId, challengeId: string) =>
    api.post<{ ok: boolean }>(
      `/companies/${companyId}/providers/${providerId}/login/${challengeId}/cancel`,
      {},
    ),
};
