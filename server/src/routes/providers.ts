/**
 * Settings -> Providers HTTP surface.
 *
 * Mounted under `/api/companies/:companyId/providers`:
 *
 *   GET  /                  — catalog x cached readiness, BOTH scopes
 *   POST /:providerId/test  — run a real probe and cache the result
 *   POST /:providerId/key   — store the company-level API key (founder only)
 *   POST /:providerId/login/start            — drive an interactive CLI login
 *   GET  /:providerId/login/:challengeId     — poll it
 *   POST /:providerId/login/:challengeId/cancel
 *
 * ─── The invariants this file exists to hold ──────────────────────────────
 *
 * 1. SCOPED READS, NO FALLBACK. Every provider is reported as a
 *    `company_default` scope PLUS one scope per in-use agent. An agent scope
 *    with no cached row reports `unknown` — it must NEVER inherit the
 *    company_default row. That fallback is the false-green this whole feature
 *    exists to remove: an agent's own `adapterConfig.env` binding WINS over the
 *    company key, so "the company default authenticates" does not imply "this
 *    agent can run". The rule is enforced structurally by
 *    `readReadinessForScope`, which has no fallback branch to disable.
 *
 * 2. REDACTION BEFORE PERSIST **AND** BEFORE TRANSMIT. `recordReadiness`
 *    enforces the persist half at the insert boundary (branded `RedactedCheck`).
 *    That does not cover the wire: probe output is returned to the client on the
 *    same request that produced it, before anything is read back. So every
 *    check leaving this router goes through `redactChecks` too — including
 *    cached checks on GET, which are re-redacted defensively rather than
 *    trusted. Precedent: routes/agents.ts applies the same redactor to probe
 *    check messages.
 *
 * 3. CREDENTIAL-GROUP INVALIDATION. Cursor + Cursor Cloud share
 *    `provider:cursor`; Pi + Claude share `provider:anthropic`. Saving a key
 *    therefore changes the credential for EVERY provider resolving to that
 *    secret name, so all of them are re-probed. Re-probing only the requested
 *    provider leaves the sibling card rendering a status derived from the old
 *    key. Group membership is computed through `getCredentialOwner`, never by
 *    hardcoding the pairs.
 *
 * ─── RBAC: why /test is not founder-gated ─────────────────────────────────
 *
 * `/test` spawns a subprocess AND writes the readiness cache, so it is not a
 * pure read — which reads as a contradiction with the design's "writes are
 * founder-gated" rule. The contradiction is resolved in favour of
 * `assertCanReadConfigurations`, deliberately:
 *
 *   - That rule governs CREDENTIAL MUTATIONS (storing a key, driving a login).
 *     Those are the actions that change what the company can do and that carry
 *     real blast radius; `/key` below applies the full founder sequence
 *     (explicit board-actor check -> assertCompanyAccess -> assertRole
 *     "founder"), matching routes/commander-key.ts.
 *   - The readiness cache is DISPOSABLE, per-company observation state. Writing
 *     it grants no capability, exposes nothing a config-reader cannot already
 *     see, and is bounded by the shared per-company probe slot.
 *   - Founder-gating the probe would break the agent-page readiness badge for
 *     team leads, who can already read agent configurations. A badge a team lead
 *     cannot refresh goes permanently stale — reintroducing the stale-status bug
 *     one level up.
 *
 * So: the cache write is treated as a side effect of an authorised read.
 *
 * ─── RESPONSE CONTRACT ────────────────────────────────────────────────────
 *
 * Authoritative for the UI (Task 10 `ProviderStatusRow` must match THIS, not
 * the plan's abridged sketch — two fields below are additions the plan's shape
 * does not carry, noted inline).
 *
 *   GET /
 *   {
 *     providers: [{
 *       descriptor:     ProviderDescriptor,   // verbatim PROVIDER_CATALOG entry
 *       companyDefault: ScopedReadinessDto,   // ALWAYS present
 *       agents:         ScopedReadinessDto[], // one per in-use agent; may be []
 *       existingKey:    ExistingKeyDto,       // ADDITION — pre-existing-key
 *                                             //   detection (design §6.1)
 *     }]
 *   }
 *
 *   ScopedReadinessDto {
 *     scopeType: "company_default" | "agent"
 *     scopeId:   string | null      // agent id for agent scope, else null
 *     agentName?: string            // agent scope only, for UI labelling
 *     outcome:   ProbeOutcome       // "unknown" when THIS scope was never probed
 *     testedAt:  string | null      // ISO; null when never probed
 *     checks:    { code, level, message, detail?, hint? }[]   // redacted
 *   }
 *
 *   ExistingKeyDto {
 *     configured: boolean
 *     source:     "provider" | "external" | null   // provider:* vs a KNOWN_
 *                                                  //   EXTERNAL_SECRET_BINDING
 *     secretName: string | null     // WHICH binding holds it — never the value
 *     envVar:     string | null     // null for providers with no key input
 *   }
 *
 *   POST /:providerId/test  -> { outcome, checks, testedAt }
 *   POST /:providerId/key   -> { ok: true, secretId,
 *                                reprobed:    ProviderId[],   // ADDITION
 *                                invalidated: ProviderId[] }  // ADDITION
 *
 * `reprobed` / `invalidated` report what happened to the CREDENTIAL GROUP (see
 * invariant 3): a provider lands in exactly one of them. `invalidated` means the
 * cached row was dropped without a fresh verdict, so that card will render
 * `unknown` until it is tested. The key itself is never echoed in any shape.
 *
 *   ── Interactive login (Task 9b) ──────────────────────────────────────
 *
 *   POST /:providerId/login/start
 *     200 -> { challengeId: string, loginUrl: string,
 *              mode: "device_code" | "paste_code",
 *              userCode: string | null, expiresAt: string }
 *     400 -> { error, canLogin: false, manualCommand?: string }
 *            The provider's CLI login cannot finish without a terminal. The UI
 *            renders `manualCommand` as copyable text INSTEAD of a button. Its
 *            absence means the provider documents no login command at all.
 *     404 -> { error }   unknown provider id
 *     409 -> { error }   the HOST login slot is held (see below)
 *     502 -> { error }   the CLI started but produced no verification URL
 *
 *   GET  /:providerId/login/:challengeId
 *     200 -> { status: "pending" | "completed" | "failed" | "timeout",
 *              loginUrl: string | null,
 *              readiness: ScopedReadinessDto | null }   // ADDITION
 *     404 -> { error }   no such challenge FOR THIS company AND THIS provider
 *
 *   POST /:providerId/login/:challengeId/cancel  -> { ok: true }
 *
 * `readiness` is non-null only on the poll that first observes `completed`: a
 * finished login changes what the host authenticates as, so the cached
 * company_default row is stale that instant. Re-probing there is the same
 * reasoning as the credential-group invalidation on `/key` — without it the card
 * keeps rendering the pre-login verdict. It is BEST-EFFORT: a failed or
 * slot-blocked probe still reports the completion, with `readiness: null`.
 *
 * "First observes" is enforced server-side by a per-challenge memo, because
 * `completed` is a durable row state rather than an edge: without it a client
 * that keeps polling past the terminal status would spawn one CLI per interval.
 * A client SHOULD still stop polling on a terminal status; the memo means a
 * client that doesn't is merely wasteful, not harmful. Only SUCCESSFUL probes
 * are memoized, so a failed or slot-blocked one retries on the next poll.
 *
 * WHY 409 IS A FIRST-CLASS OUTCOME. Login challenges are keyed
 * `(provider, authHome)`, and authHome resolves from ENV ONLY
 * (`CODEX_HOME ?? ~/.codex`, `CLAUDE_CONFIG_DIR ?? ~/.claude`) — there is no
 * companyId in it. So the slot is HOST-shared: on a multi-company instance a
 * pending challenge owned by ANOTHER company blocks this one. That is a real,
 * routine state, not an internal error, so it gets founder-readable copy rather
 * than the lifecycle's raw message (which names the filesystem authHome).
 */
import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import { agents, commanderLoginChallenges, companySecrets } from "@armyofagents/db";
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import {
  KNOWN_EXTERNAL_SECRET_BINDINGS,
  PROVIDER_CATALOG,
  getCredentialOwner,
  getProviderById,
  type AdapterEnvironmentCheck,
  type AdapterEnvironmentCheckLevel,
  type AdapterEnvironmentTestResult,
  type ProbeOutcome,
  type ProviderDescriptor,
  type ProviderId,
} from "@armyofagents/shared";
import { accessService } from "../services/access.js";
import { logActivity } from "../services/activity-log.js";
import { secretService } from "../services/secrets.js";
import { classifyProbeOutcome } from "../services/providers/classify-probe.js";
import {
  deleteReadinessForScope,
  deleteAgentReadinessForProvider,
  readReadiness,
  recordReadiness,
  redactChecks,
  type ReadinessScope,
} from "../services/providers/readiness.js";
import { resolveProviderKeyTarget, saveProviderKey } from "../services/providers/provider-key.js";
import { resolveLoginCapability } from "../services/providers/provider-login.js";
import {
  buildCommanderLoginService,
  hasLoginRunner,
} from "../services/commander-login-runtime.js";
import { loadConfig } from "../config.js";
import {
  providerSubscriptionCapability,
  resolveCliAuthTopology,
  resolveScopedCliAuthHome,
  scopedCliAuthEnv,
} from "../services/cli-auth-topology.js";
import { verifyAndBindCommanderSubscriptionCredential } from "../services/provider-credentials.js";
import {
  LoginChallengeConflictError,
  type CommanderLoginProvider,
} from "../services/commander-login.js";
import { findServerAdapter } from "../adapters/index.js";
import {
  ADAPTER_PROBE_BUSY_ERROR,
  ADAPTER_PROBE_RETRY_AFTER_SECONDS,
  tryAcquireAdapterProbeSlot,
} from "../services/adapter-probe-concurrency.js";
import { assertCompanyAccess } from "./authz.js";
import { assertRole } from "../middleware/rbac.js";
import { assertUnsandboxedMultitenantAllowed } from "../services/unsandboxed-multitenant-guard.js";
import { tenantIsolationEnforced } from "../config/deployment-mode.js";
import {
  cliToolForSandboxReadinessProbe,
  probeReadinessInSandbox,
} from "../services/sandbox-readiness-probe.js";
import { mapCloudProviderKeyError } from "../services/internal-agent/require-cloud-provider-key.js";
import { HttpError, forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ route: "providers" });

/** Wire shape for one scope of one provider. Mirrors `ScopedReadiness` in the UI. */
interface ScopedReadinessDto {
  scopeType: "company_default" | "agent";
  scopeId: string | null;
  agentName?: string;
  outcome: ProbeOutcome;
  testedAt: string | null;
  // `level` is the shared union, not `string`: `redactChecks` passes it through
  // from AdapterEnvironmentCheck unchanged, and the UI switches on it. A widened
  // copy here would let a fourth level reach a card that cannot style it.
  checks: {
    code: string;
    level: AdapterEnvironmentCheckLevel;
    message: string;
    detail?: string;
    hint?: string;
  }[];
}

/**
 * Whether a key for this provider already exists — and under WHICH binding.
 * Never the value.
 *
 * `source: "external"` means the key lives outside the `provider:*` namespace
 * (Settings -> Memory's `llm:*`, the legacy bare env-var name, or Commander
 * onboarding's `Commander <p> API key`). A founder who pasted a key during
 * Commander onboarding must not be shown an empty input inviting a duplicate
 * paste — after rotation one of the two would be silently stale.
 */
interface ExistingKeyDto {
  configured: boolean;
  source: "provider" | "external" | null;
  secretName: string | null;
  envVar: string | null;
}

type CachedRow = {
  outcome: string;
  checks: unknown;
  testedAt: Date | string | null;
} | undefined;

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Project a cached row onto the wire.
 *
 * `undefined` (never probed for THIS scope) becomes `unknown` + `testedAt: null`
 * — see invariant 1. There is deliberately no `?? companyDefaultRow` here.
 */
function toScopedDto(
  row: CachedRow,
  scope: ReadinessScope,
  agentName?: string,
): ScopedReadinessDto {
  const rawChecks = Array.isArray(row?.checks) ? (row.checks as AdapterEnvironmentCheck[]) : [];
  return {
    scopeType: scope.type,
    scopeId: scope.type === "agent" ? scope.agentId : null,
    ...(agentName === undefined ? {} : { agentName }),
    outcome: (row?.outcome as ProbeOutcome | undefined) ?? "unknown",
    testedAt: toIso(row?.testedAt),
    // Re-redacted on the way out: the persisted row SHOULD already be clean, but
    // "should" is not an invariant and the wire is the boundary that matters.
    checks: redactChecks(rawChecks),
  };
}

/**
 * Index key for one cached readiness row.
 *
 * All three scope components are in the key, so a lookup for an agent scope can
 * only ever hit that agent's own row. `scopeId` is normalised to `""` for
 * company_default (the column is NULL there), which cannot collide with a uuid.
 */
function scopeCacheKey(
  providerId: string,
  scopeType: string,
  scopeId: string | null,
): string {
  return `${providerId}|${scopeType}|${scopeId ?? ""}`;
}

/** The secret name a saved key for this descriptor actually lands in, if any. */
function secretNameForDescriptor(descriptor: ProviderDescriptor): string | null {
  return getCredentialOwner(descriptor).credential.apiKey?.secretName ?? null;
}

/** Every catalog provider whose stored credential IS this secret. */
function credentialGroupFor(secretName: string): ProviderDescriptor[] {
  return PROVIDER_CATALOG.filter((p) => secretNameForDescriptor(p) === secretName);
}

/** Every secret name that could hold a key for any catalog provider. */
function allCandidateSecretNames(): string[] {
  const names = new Set<string>();
  for (const descriptor of PROVIDER_CATALOG) {
    const spec = getCredentialOwner(descriptor).credential.apiKey;
    if (!spec) continue;
    names.add(spec.secretName);
    for (const external of KNOWN_EXTERNAL_SECRET_BINDINGS[spec.envVar] ?? []) names.add(external);
  }
  return [...names];
}

function detectExistingKey(
  descriptor: ProviderDescriptor,
  activeSecretNames: ReadonlySet<string>,
): ExistingKeyDto {
  const spec = getCredentialOwner(descriptor).credential.apiKey;
  // OpenCode brokers per-provider credentials through its own auth store — no
  // key input exists for it at all.
  if (!spec) return { configured: false, source: null, secretName: null, envVar: null };

  // `alternativeEnvVars` are deliberately NOT consulted. They are READ-ONLY
  // (nothing is ever written under them) and they are SHARED: Cursor lists
  // OPENAI_API_KEY, so a Codex key would otherwise report Cursor as configured.
  // That is exactly the false-green this feature removes. Only bindings that
  // hold THIS provider's own credential count.

  // The `provider:*` name is checked FIRST so the canonical binding wins when
  // several coexist; the externals are reported only when they are the only one.
  if (activeSecretNames.has(spec.secretName)) {
    return {
      configured: true,
      source: "provider",
      secretName: spec.secretName,
      envVar: spec.envVar,
    };
  }
  for (const external of KNOWN_EXTERNAL_SECRET_BINDINGS[spec.envVar] ?? []) {
    if (activeSecretNames.has(external)) {
      return { configured: true, source: "external", secretName: external, envVar: spec.envVar };
    }
  }
  return { configured: false, source: null, secretName: null, envVar: spec.envVar };
}

const SECRET_NAME_CONSTRAINT = "company_secrets_company_name_uq";

/**
 * Postgres unique-violation on the ONE constraint concurrent key saves can hit.
 *
 * Deliberately narrow: a bare `code === "23505"` check would also swallow a
 * unique violation raised anywhere else in the save transaction (the activity
 * log, a secret-version row) and answer it with a 409 whose message names the
 * wrong cause. Those are genuine 500s and should surface as such.
 */
function isSecretNameUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown; message?: unknown };
  if (e.code !== "23505") return false;
  // `constraint` is populated by node-postgres; `message` is the fallback for
  // drivers/wrappers that only carry the text.
  return [e.constraint, e.message].some(
    (field) => typeof field === "string" && field.includes(SECRET_NAME_CONSTRAINT),
  );
}

export function providerRoutes(db: Db): Router {
  // mergeParams: mounted under a path that owns `:companyId`.
  const router = Router({ mergeParams: true });
  const access = accessService(db);
  const secrets = secretService(db);
  const loginService = buildCommanderLoginService(db);

  /**
   * Challenge ids whose post-login re-probe already SUCCEEDED (review M-4).
   *
   * The status route re-probes when it observes `completed`, but `completed` is
   * a durable row state, not an edge — a client that keeps polling after the
   * terminal status would otherwise serialize one CLI spawn per interval.
   * Founder-only and bounded by the shared probe slot, so never a DoS, but
   * pointless work and pointless subprocesses.
   *
   * Only SUCCESSES are recorded, so a probe that failed or could not acquire
   * the slot is still retried on the next poll — the memo must not be able to
   * strand a card on a stale verdict, which is the bug the re-probe exists to
   * prevent. In-memory and per-router: a restart simply re-probes once more,
   * which is harmless. Capped so a long-lived process cannot grow it without
   * bound; eviction at worst costs one extra probe.
   */
  const reprobedChallenges = new Set<string>();
  const REPROBED_CHALLENGES_MAX = 500;

  /**
   * The founder sequence for a CREDENTIAL MUTATION, matching commander-key.ts.
   *
   * The explicit board-actor check comes FIRST because `assertRole` is a no-op
   * for agent actors — without it an agent key could drive a company login or
   * write a company credential.
   *
   * Returns the founder's user id, or `null` once the 401 response is sent.
   * Returning the id rather than a boolean is what lets callers use it without
   * a second narrowing check that TypeScript cannot connect to this one.
   */
  async function assertFounderActor(
    req: Request,
    res: Response,
    companyId: string,
  ): Promise<string | null> {
    const actor = req.actor;
    if (actor.type !== "board" || !actor.userId) {
      res.status(401).json({ error: "authentication required" });
      return null;
    }
    await assertCompanyAccess(db, req, companyId);
    await assertRole(db, req, companyId, "founder");
    return actor.userId;
  }

  /**
   * "Can this actor read agent/provider configuration?" — the same bar
   * routes/agents.ts uses for its configuration reads (`agents:create`), so the
   * Providers tab and the agent page cannot disagree about who sees a badge.
   */
  async function assertCanReadConfigurations(req: Request, companyId: string): Promise<void> {
    await assertCompanyAccess(db, req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      if (await access.canUser(companyId, req.actor.userId, "agents:create")) return;
      throw forbidden("Missing permission: agents:create");
    }
    if (req.actor.type === "agent" && req.actor.agentId) {
      if (await access.hasPermission(companyId, "agent", req.actor.agentId, "agents:create")) return;
      // Honour the legacy `permissions.canCreateAgents` flag too, exactly as
      // routes/agents.ts's configuration-read gate does (`allowedByGrant ||
      // canCreateAgents`). Without this, an agent key that CAN read agent
      // configuration there is 403'd here — the two surfaces would disagree about
      // who sees a readiness badge, which this shared bar exists to prevent.
      const [actorAgent] = await db
        .select({ permissions: agents.permissions })
        .from(agents)
        .where(and(eq(agents.id, req.actor.agentId), eq(agents.companyId, companyId)))
        .limit(1);
      if (Boolean((actorAgent?.permissions as Record<string, unknown> | undefined)?.canCreateAgents)) {
        return;
      }
      throw forbidden("Missing permission: agents:create");
    }
    throw forbidden("Board access required");
  }

  /**
   * Consumer context for a probe's secret resolution.
   *
   * Agent-scoped probes MUST resolve the agent's persisted secret_refs through
   * the SAME authorization path a real run uses (`consumerType: "agent"`, the
   * agent's id) so `shouldEnforceSecretBinding` applies. Resolving as a `system`
   * consumer skips the binding check (secrets.ts) and would cache `verified` for
   * a secret the heartbeat/AoA runner rejects as unbound — the exact false-green
   * the agent scope exists to catch ("an agent whose own env binding is revoked
   * must go red", see scope=agent handler). With this, a missing binding throws
   * `unprocessable`, just as the real run does, so the probe never records Ready.
   *
   * company_default probes carry an EMPTY config (no agent secret_refs to bind);
   * their only secret is the company-level provider key, which
   * `resolveCompanyProviderKeys` narrows to `system` by design. So `system` is
   * correct there.
   */
  function probeContext(req: Request, scope: ReadinessScope, descriptor: ProviderDescriptor) {
    const actorId = req.actor.type === "board" ? (req.actor.userId ?? "board") : "system";
    if (scope.type === "agent") {
      return {
        consumerType: "agent" as const,
        consumerId: scope.agentId,
        actorType: "user" as const,
        actorId,
      };
    }
    return {
      consumerType: "system" as const,
      consumerId: `provider-readiness:${descriptor.id}`,
      actorType: "user" as const,
      actorId,
    };
  }

  /**
   * Run one probe and cache it.
   *
   * Returns `null` when no probe could START — the adapter has no
   * `testEnvironment`, or the shared probe slot is taken. Callers treat that as
   * "leave the cache alone" rather than writing a fabricated outcome. An adapter
   * that starts and then THROWS propagates: that is a real failure, and the
   * caller decides whether it is fatal (`/test` -> 500) or best-effort
   * (`/key` re-probe -> logged and skipped).
   */
  async function probeAndRecord(input: {
    req: Request;
    companyId: string;
    descriptor: ProviderDescriptor;
    scope: ReadinessScope;
    adapterConfig: Record<string, unknown>;
  }): Promise<{ outcome: ProbeOutcome; checks: AdapterEnvironmentCheck[]; testedAt: string } | null> {
    const { req, companyId, descriptor, scope, adapterConfig } = input;
    const adapter = findServerAdapter(descriptor.adapterType);
    if (!adapter?.testEnvironment) return null;

    // Shared per-company slot. This is STRICTER than the spec's per-(company,
    // provider, scope) rule on purpose: the slot is shared with the agent
    // test-connection and Commander verify routes, so honouring it means we
    // never spawn a second CLI while any probe is in flight. The required
    // behaviour — a second probe for the SAME scope gets 429 instead of a second
    // subprocess — is a subset of that.
    const releaseProbeSlot = tryAcquireAdapterProbeSlot(companyId);
    if (!releaseProbeSlot) return null;

    try {
      let resolved: Record<string, unknown>;
      try {
        resolved = await secrets.resolveAdapterConfigForRuntime(
          companyId,
          descriptor.adapterType,
          adapterConfig,
          probeContext(req, scope, descriptor),
        );
      } catch (err) {
        // Config resolution failed BEFORE the CLI could run — e.g. an agent's
        // own `secret_ref` was revoked/unbound, so resolveAdapterConfigForRuntime
        // throws for the `agent` consumer (exactly what the agent scope exists to
        // surface). If we let this propagate untouched, a previously recorded
        // `verified` row would survive and keep rendering the agent as Ready even
        // though its runtime config now fails before spawn. Overwrite THIS scope's
        // cached readiness with `failed` (recordReadiness redacts at the insert
        // boundary), then re-throw so the caller still gets the error.
        await recordReadiness(db, {
          companyId,
          providerId: descriptor.id,
          scope,
          outcome: "failed",
          checks: [
            {
              code: `${descriptor.adapterType}_runtime_config_unresolved`,
              level: "error",
              message:
                err instanceof Error ? err.message : "Runtime configuration could not be resolved.",
            },
          ],
          testedByUserId: req.actor.type === "board" ? (req.actor.userId ?? null) : null,
        });
        throw err;
      }
      // D1 (cloud isolation): the probe spawns a REAL `claude --print` / `codex
      // exec` generation. This sink has NO execution target — it always runs on
      // the local, unsandboxed control-plane host — so on `cloud_auth` it would
      // run under the OPERATOR's login on the shared host. Refuse before spawning
      // (no-op on every self-hosted deployment). Record `failed` so a prior
      // `verified` row cannot survive and keep rendering the provider Ready.
      const recordCloudBlocked = async (message: string) => {
        const cloudChecks: AdapterEnvironmentCheck[] = [
          { code: "readiness_unavailable_on_cloud", level: "error", message },
        ];
        await recordReadiness(db, {
          companyId,
          providerId: descriptor.id,
          scope,
          outcome: "failed",
          checks: cloudChecks,
          testedByUserId: req.actor.type === "board" ? (req.actor.userId ?? null) : null,
        });
        return { outcome: "failed" as const, checks: cloudChecks, testedAt: new Date().toISOString() };
      };
      if (tenantIsolationEnforced()) {
        try {
          assertUnsandboxedMultitenantAllowed(null, {
            tenantIsolationEnforced: true,
            sink: "adapter readiness probe",
          });
        } catch {
          // U13.7: the guard refused the direct on-host probe. Restore BYO-key
          // verify for the two adapter types with a company-key mapping
          // (`resolveCompanyProviderCredential`: codex_local -> openai,
          // claude_local -> anthropic) by routing the hello-probe through an
          // ephemeral sandbox instead of failing closed outright. Every other
          // adapter type keeps the unconditional blocking result.
          const cliTool = cliToolForSandboxReadinessProbe(descriptor.adapterType);
          if (!cliTool) {
            return await recordCloudBlocked(
              "Provider readiness testing is unavailable on AoA Cloud (a local probe would run on the shared host).",
            );
          }
          try {
            const sandboxResult = await probeReadinessInSandbox({
              db,
              companyId,
              cliTool,
              adapterType: descriptor.adapterType,
            });
            const classified = classifyProbeOutcome(sandboxResult);
            const recorded = await recordReadiness(db, {
              companyId,
              providerId: descriptor.id,
              scope,
              outcome: classified.outcome,
              checks: sandboxResult.checks,
              testedByUserId: req.actor.type === "board" ? (req.actor.userId ?? null) : null,
            });
            return {
              outcome: classified.outcome,
              checks: redactChecks(sandboxResult.checks) as unknown as AdapterEnvironmentCheck[],
              testedAt:
                toIso((recorded as { testedAt?: Date | string } | undefined)?.testedAt) ??
                new Date().toISOString(),
            };
          } catch (err) {
            const mapped = mapCloudProviderKeyError(err, {
              tenantIsolationEnforced: true,
              provider: cliTool === "codex" ? "openai" : "anthropic",
              sink: "adapter readiness probe",
            });
            if (!mapped) throw err;
            return await recordCloudBlocked(mapped.message);
          }
        }
      }
      let result: AdapterEnvironmentTestResult;
      try {
        result = await adapter.testEnvironment({
          companyId,
          adapterType: descriptor.adapterType,
          config: resolved,
        });
      } catch (err) {
        // The probe STARTED and threw (e.g. an unexpected spawn error) instead of
        // returning status:"fail". Symmetric with the resolution throw above: a
        // crash must not leave a prior `verified` row intact. Overwrite THIS scope
        // with `failed`, then re-throw so /test still surfaces the error.
        await recordReadiness(db, {
          companyId,
          providerId: descriptor.id,
          scope,
          outcome: "failed",
          checks: [
            {
              code: `${descriptor.adapterType}_probe_threw`,
              level: "error",
              message: err instanceof Error ? err.message : "The environment probe failed to run.",
            },
          ],
          testedByUserId: req.actor.type === "board" ? (req.actor.userId ?? null) : null,
        });
        throw err;
      }
      const classified = classifyProbeOutcome(result);
      // recordReadiness redacts at the insert boundary (branded RedactedCheck).
      const recorded = await recordReadiness(db, {
        companyId,
        providerId: descriptor.id,
        scope,
        outcome: classified.outcome,
        checks: result.checks,
        testedByUserId: req.actor.type === "board" ? (req.actor.userId ?? null) : null,
      });
      return {
        outcome: classified.outcome,
        // Redacted independently for the wire — see invariant 2.
        checks: redactChecks(result.checks) as unknown as AdapterEnvironmentCheck[],
        testedAt:
          toIso((recorded as { testedAt?: Date | string } | undefined)?.testedAt) ??
          new Date().toISOString(),
      };
    } finally {
      releaseProbeSlot();
    }
  }

  /* ── GET / ───────────────────────────────────────────────────────────── */

  router.get("/", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCanReadConfigurations(req, companyId);

    // In use = any LIVE agent. Both `archived` and `terminated` are dead states:
    // a terminated agent cannot run, so counting it would make the tab probe a
    // dead adapter, auto-refresh it, and let its "not checked"/failing scope
    // qualify an otherwise-verified provider. Fetched BEFORE secrets and never in
    // parallel, so the query order is deterministic.
    const agentRows = (await db
      .select({ id: agents.id, name: agents.name, adapterType: agents.adapterType })
      .from(agents)
      .where(
        and(eq(agents.companyId, companyId), notInArray(agents.status, ["archived", "terminated"])),
      )) as {
      id: string;
      name: string;
      adapterType: string;
    }[];

    const candidateNames = allCandidateSecretNames();
    const secretRows = (await db
      .select({ name: companySecrets.name, status: companySecrets.status })
      .from(companySecrets)
      .where(
        and(
          eq(companySecrets.companyId, companyId),
          inArray(companySecrets.name, candidateNames),
          isNull(companySecrets.deletedAt),
        ),
      )) as { name: string; status: string }[];
    // Only an ACTIVE secret counts: a disabled/archived row resolves to "not
    // active" at runtime, so reporting it as configured would tell the founder
    // they are set up when nothing can authenticate.
    const activeSecretNames = new Set(
      secretRows.filter((s) => s.status === "active").map((s) => s.name),
    );

    // ONE company-scoped query for the whole page, indexed by exact scope key.
    // Per-scope reads here would be 8 + N sequential round-trips (58 for a
    // 50-agent company) on the surface whose entire design goal is to render
    // instantly from cache. `readReadinessForScope` remains the reader for the
    // single-scope paths below.
    //
    // The index is EXACT: the key carries providerId, scopeType and scopeId, so
    // a miss is a miss. There is deliberately no widening lookup that could let
    // an agent scope resolve to the company_default row — see invariant 1. A
    // missing entry yields `undefined`, which `toScopedDto` renders as
    // `unknown`, exactly as an unprobed scope did before.
    const cache = new Map<string, CachedRow>();
    for (const row of (await readReadiness(db, companyId)) as unknown as {
      providerId: string;
      scopeType: string;
      scopeId: string | null;
      outcome: string;
      checks: unknown;
      testedAt: Date | string | null;
    }[]) {
      cache.set(scopeCacheKey(row.providerId, row.scopeType, row.scopeId), row);
    }
    const cached = (providerId: string, scope: ReadinessScope): CachedRow =>
      cache.get(
        scopeCacheKey(providerId, scope.type, scope.type === "agent" ? scope.agentId : null),
      );

    const providers = [];
    for (const descriptor of PROVIDER_CATALOG) {
      const companyDefault = toScopedDto(cached(descriptor.id, { type: "company_default" }), {
        type: "company_default",
      });

      const scoped: ScopedReadinessDto[] = [];
      for (const agent of agentRows) {
        if (agent.adapterType !== descriptor.adapterType) continue;
        const scope: ReadinessScope = { type: "agent", agentId: agent.id };
        scoped.push(toScopedDto(cached(descriptor.id, scope), scope, agent.name));
      }

      providers.push({
        descriptor,
        companyDefault,
        agents: scoped,
        existingKey: detectExistingKey(descriptor, activeSecretNames),
      });
    }

    res.json({ providers });
  });

  /* ── POST /:providerId/test ──────────────────────────────────────────── */

  router.post("/:providerId/test", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    // Guarded as a configuration READ — see the RBAC note in the file header.
    await assertCanReadConfigurations(req, companyId);

    const descriptor = getProviderById(req.params.providerId as string);
    if (!descriptor) {
      res.status(404).json({ error: `Unknown provider: ${req.params.providerId}` });
      return;
    }

    const scopeParam = typeof req.query.scope === "string" ? req.query.scope : "company_default";
    if (scopeParam !== "company_default" && scopeParam !== "agent") {
      res.status(400).json({ error: "scope must be 'company_default' or 'agent'" });
      return;
    }

    let scope: ReadinessScope = { type: "company_default" };
    // company_default probes with an EMPTY config: the company key fallback and
    // the host CLI's own login are exactly what resolveAdapterConfigForRuntime
    // layers on, and nothing agent-specific may leak in.
    let adapterConfig: Record<string, unknown> = {};

    if (scopeParam === "agent") {
      const agentId = typeof req.query.agentId === "string" ? req.query.agentId.trim() : "";
      if (!agentId) {
        res.status(400).json({ error: "agentId is required for scope=agent" });
        return;
      }
      const [agent] = (await db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          adapterType: agents.adapterType,
          adapterConfig: agents.adapterConfig,
          status: agents.status,
        })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1)) as {
        id: string;
        companyId: string;
        adapterType: string;
        adapterConfig: Record<string, unknown> | null;
        status: string;
      }[];
      if (!agent || agent.companyId !== companyId) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      // GET / lists only live agents; probing a dead one would spawn a CLI and
      // mint an agent-scope row that GET can never surface (orphaned). Reject for
      // symmetry with the list view.
      if (agent.status === "archived" || agent.status === "terminated") {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      if (agent.adapterType !== descriptor.adapterType) {
        // The (provider, agent) row would be meaningless: this agent does not
        // run on this provider.
        res
          .status(400)
          .json({ error: `Agent does not use provider ${descriptor.id}` });
        return;
      }
      scope = { type: "agent", agentId: agent.id };
      // The agent's ACTUAL persisted config — this is what makes the badge
      // honest. An agent whose own env binding is revoked must go red even when
      // the company default authenticates.
      adapterConfig = agent.adapterConfig ?? {};
    }

    const adapter = findServerAdapter(descriptor.adapterType);
    if (!adapter?.testEnvironment) {
      res.status(404).json({ error: `No probe available for ${descriptor.adapterType}` });
      return;
    }
    // The slot is acquired INSIDE probeAndRecord. Do not pre-check it here: a
    // pre-acquire that is never released deadlocks every probe.
    const probed = await probeAndRecord({ req, companyId, descriptor, scope, adapterConfig });
    // The adapter/testEnvironment case is handled above, so `null` here means
    // the shared probe slot was taken. Reject rather than queue: a probe spawns
    // a CLI for tens of seconds.
    if (!probed) {
      res
        .status(429)
        .set("Retry-After", String(ADAPTER_PROBE_RETRY_AFTER_SECONDS))
        .json({ error: ADAPTER_PROBE_BUSY_ERROR });
      return;
    }
    res.json(probed);
  });

  /* ── POST /:providerId/key ───────────────────────────────────────────── */

  router.post("/:providerId/key", async (req: Request, res: Response) => {
    // Credential mutation: the full founder sequence, matching commander-key.ts.
    const companyId = req.params.companyId as string;
    const founderUserId = await assertFounderActor(req, res, companyId);
    if (!founderUserId) return;

    const providerId = req.params.providerId as string;
    const descriptor = getProviderById(providerId);
    if (!descriptor) {
      res.status(404).json({ error: `Unknown provider: ${providerId}` });
      return;
    }
    const value = typeof req.body?.value === "string" ? req.body.value.trim() : "";
    if (!value) {
      res.status(400).json({ error: "value is required" });
      return;
    }

    let saved;
    try {
      saved = await saveProviderKey(db, {
        companyId,
        providerId,
        value,
        actorUserId: founderUserId,
      });
    } catch (err) {
      // A keyless provider (opencode) raises badRequest from the service.
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      // Two founders saving the same provider concurrently can race the create
      // branch into the partial unique index. That is a conflict, not a 500.
      if (isSecretNameUniqueViolation(err)) {
        res.status(409).json({ error: "This provider key was just saved by another request." });
        return;
      }
      throw err;
    }

    // The key is committed — record WHO changed this company's credential before
    // the (best-effort) re-probe work below.
    await auditProvider(companyId, founderUserId, "provider.key.saved", providerId, {
      secretId: saved.secretId,
    });

    // Credential-group invalidation (invariant 3). The saved secret is shared,
    // so every provider that resolves to it is re-probed — otherwise the
    // sibling card keeps a status derived from the old key.
    //
    // ONLY company_default scopes are touched. An agent carrying its own
    // revoked binding must stay red; the company key did not fix it.
    const writtenSecretName = resolveProviderKeyTarget(providerId).secretName;
    const group = credentialGroupFor(writtenSecretName);
    const reprobed: ProviderId[] = [];
    const invalidated: ProviderId[] = [];

    /**
     * Drop a group member's cached verdict when we could not mint a fresh one.
     *
     * Re-probing is best-effort — the shared probe slot may be held by a
     * concurrent agent or Commander probe, and the CLI may fail. But "no fresh
     * verdict" must NOT mean "keep the old one": the credential underneath it
     * just changed, so the cached row is answering a question about a key that
     * no longer exists. Leaving it is precisely the false-green this feature
     * removes, and it is reachable through ordinary concurrency.
     */
    const invalidate = async (member: ProviderDescriptor) => {
      try {
        await deleteReadinessForScope(db, companyId, member.id, { type: "company_default" });
        invalidated.push(member.id);
      } catch (err) {
        log.warn(
          { err, companyId, providerId: member.id },
          "provider readiness invalidation failed",
        );
      }
    };

    for (const member of group) {
      // The company key just changed, so every agent scope that resolves through
      // the company fallback (agents with no env binding of their own) now holds a
      // verdict about the OLD key. Clear all agent scopes for this provider (→
      // unknown) so a rotated/bad key can't leave a stale `verified` agent badge.
      // Best-effort: never fail the (already-committed) key save on this.
      try {
        await deleteAgentReadinessForProvider(db, companyId, member.id);
      } catch (err) {
        log.warn(
          { err, companyId, providerId: member.id },
          "provider readiness agent-scope invalidation failed",
        );
      }
      try {
        const result = await probeAndRecord({
          req,
          companyId,
          descriptor: member,
          scope: { type: "company_default" },
          adapterConfig: {},
        });
        if (result) {
          reprobed.push(member.id);
          continue;
        }
        // The probe could not START (shared slot held; every catalog adapter
        // does implement testEnvironment). Nothing was written — invalidate.
        await invalidate(member);
      } catch (err) {
        // The probe started and threw. The key IS saved and committed, so
        // failing the response would tell the founder the paste failed and
        // invite a duplicate; invalidate instead and report 200.
        log.warn({ err, companyId, providerId: member.id }, "provider key re-probe failed");
        await invalidate(member);
      }
    }

    // The raw key is never echoed — only the durable secret id.
    res.json({ ok: true, secretId: saved.secretId, reprobed, invalidated });
  });

  /**
   * Does this challenge belong to THIS provider?
   *
   * The login service is COMPANY-scoped by design (it is shared with Commander,
   * whose contract documents cross-TENANT isolation only). The provider dimension
   * is this router's — the id is in the URL — so without this check a challengeId
   * for another provider in the SAME company would be accepted: polling or
   * cancelling `/providers/openai/login/<claude-challenge>` would act on the
   * Claude sign-in. A mismatch is reported as ABSENT (404), matching the
   * service's own non-leaking "report as absent" convention.
   */
  async function challengeBelongsToProvider(
    companyId: string,
    challengeId: string,
    providerId: string,
  ): Promise<boolean> {
    const [row] = (await db
      .select({ provider: commanderLoginChallenges.provider })
      .from(commanderLoginChallenges)
      .where(
        and(
          eq(commanderLoginChallenges.id, challengeId),
          eq(commanderLoginChallenges.companyId, companyId),
        ),
      )
      .limit(1)) as { provider: string }[];
    return Boolean(row) && row.provider === providerId;
  }

  /**
   * Audit a credential-grade provider mutation.
   *
   * Saving a company key and starting a host-shared OAuth sign-in both change
   * credentials for the whole company (and, for login, the machine), so the
   * Activity feed must record WHO did it — the same bar `commander-key` and
   * `secrets` already meet. Best-effort: the key is already committed and the
   * sign-in is already live by the time we log, so a logging failure must never
   * fail the request.
   */
  async function auditProvider(
    companyId: string,
    actorUserId: string,
    action: string,
    providerId: string,
    details: Record<string, unknown>,
  ) {
    try {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId,
        action,
        entityType: "provider",
        entityId: providerId,
        details: { providerId, ...details },
      });
    } catch (err) {
      log.warn({ err, companyId, action, providerId }, "provider activity log failed");
    }
  }

  /* ── Interactive login (Task 9b) ─────────────────────────────────────── */

  /**
   * RBAC: all three login routes take the SAME founder gate as `/key`, including
   * the read-shaped status poll.
   *
   * Status polling could defensibly have used `assertCanReadConfigurations` (it
   * writes nothing but the best-effort readiness cache, which `/test` already
   * lets a config-reader write). Founder was chosen because the poll returns
   * `loginUrl` — a live OAuth verification URL. Anyone holding it can complete
   * the sign-in and bind THIS HOST's credential home to their own account. That
   * is a credential-grade secret, not observation state, so it does not belong
   * behind the weaker read gate. The cost is nil: only a founder can start a
   * login, so only a founder ever holds a challengeId to poll.
   */

  router.post("/:providerId/login/start", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const founderUserId = await assertFounderActor(req, res, companyId);
    if (!founderUserId) return;

    const providerId = req.params.providerId as string;
    const descriptor = getProviderById(providerId);
    if (!descriptor) {
      res.status(404).json({ error: `Unknown provider: ${providerId}` });
      return;
    }

    // The gate that keeps us from rendering a button that cannot finish. Claude
    // blocks on a stdin "Paste code here" prompt after a REMOTE callback, so an
    // in-app start would spin until the 5-minute deadline reports `timeout`.
    const capability = resolveLoginCapability(providerId);
    if (!capability.canLogin || !hasLoginRunner(providerId)) {
      res.status(400).json({
        error: capability.manualCommand
          ? `${descriptor.label} sign-in must be completed in a terminal.`
          : `${descriptor.label} does not support in-app sign-in.`,
        canLogin: false,
        ...(capability.manualCommand ? { manualCommand: capability.manualCommand } : {}),
      });
      return;
    }
    const loginProvider = providerId as CommanderLoginProvider;

    let subscriptionCapability;
    try {
      const config = loadConfig();
      const topology = resolveCliAuthTopology({
        deploymentMode: config.deploymentMode,
        deploymentExposure: config.deploymentExposure,
      });
      subscriptionCapability = providerSubscriptionCapability(loginProvider, topology);
    } catch (error) {
      res.status(503).json({
        code: "invalid_cli_auth_topology",
        error:
          error instanceof Error ? error.message : "CLI authentication topology is invalid.",
      });
      return;
    }
    if (!subscriptionCapability.enabled) {
      res.status(403).json({
        code: "subscription_auth_disabled",
        error: subscriptionCapability.reason,
        capability: subscriptionCapability,
      });
      return;
    }

    try {
      const executionTargetId =
        process.env.AOA_EXECUTION_TARGET_ID?.trim() || "control-plane";
      const { challengeId, loginUrl, userCode, expiresAt } = await loginService.startChallenge({
        companyId,
        provider: loginProvider,
        startedByUserId: founderUserId,
        executionTargetId,
      });
      await auditProvider(companyId, founderUserId, "provider.login.started", providerId, {
        challengeId,
        executionTargetId,
      });
      res.json({
        challengeId,
        loginUrl,
        mode: loginProvider === "openai" ? "device_code" : "paste_code",
        userCode,
        expiresAt,
      });
    } catch (err) {
      if (err instanceof LoginChallengeConflictError) {
        // Deliberately NOT `err.message`: the lifecycle's copy names the
        // filesystem authHome and the owning company's existence. Founder-facing
        // copy explains the host-shared slot and what to do about it.
        res.status(409).json({
          error: `Another sign-in for ${descriptor.label} is already in progress on this machine. Finish or cancel it, then try again.`,
        });
        return;
      }
      log.warn({ err, companyId, providerId }, "provider login start failed");
      res.status(502).json({ error: "sign-in could not start (no verification URL)" });
    }
  });

  router.get("/:providerId/login/:challengeId", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const founderUserId = await assertFounderActor(req, res, companyId);
    if (!founderUserId) return;

    const providerId = req.params.providerId as string;
    const descriptor = getProviderById(providerId);
    if (!descriptor) {
      res.status(404).json({ error: `Unknown provider: ${providerId}` });
      return;
    }

    // Scoped by company AND provider: a challenge started under another provider
    // must read as absent here, never surface its status/loginUrl on this card.
    // The service enforces only the company dimension, so the provider check is
    // ours (see `challengeBelongsToProvider`).
    const challengeId = req.params.challengeId as string;
    if (
      !hasLoginRunner(providerId) ||
      !(await challengeBelongsToProvider(companyId, challengeId, providerId))
    ) {
      res.status(404).json({ error: "challenge not found" });
      return;
    }
    const status = await loginService.getStatus(
      companyId,
      challengeId,
      providerId as CommanderLoginProvider,
      founderUserId,
    );
    if (!status) {
      res.status(404).json({ error: "challenge not found" });
      return;
    }

    // Re-probe once the login lands, so the card stops showing the pre-login
    // verdict. Best-effort — see the contract note in the file header.
    let readiness: ScopedReadinessDto | null = null;
    if (status.status === "completed" && !reprobedChallenges.has(challengeId)) {
      // The sign-in changed what this machine authenticates as — record it once,
      // on the same first-observe edge the re-probe uses.
      await auditProvider(companyId, founderUserId, "provider.login.completed", providerId, {
        challengeId,
      });
      // A completed host-CLI login changes what agents WITHOUT their own env
      // binding authenticate as (they resolve through the host login), so their
      // cached agent-scope verdicts now answer a stale question. Clear them (→
      // unknown) — the conservative direction (a just-succeeded login can only
      // make a stale verdict falsely RED, never green). Twin of the /key clear.
      try {
        await deleteAgentReadinessForProvider(db, companyId, descriptor.id);
      } catch (err) {
        log.warn({ err, companyId, providerId }, "post-login agent-scope invalidation failed");
      }
      try {
        const executionTargetId =
          process.env.AOA_EXECUTION_TARGET_ID?.trim() || "control-plane";
        const loginProvider = providerId as CommanderLoginProvider;
        const authHome = resolveScopedCliAuthHome({
          executionTargetId,
          companyId,
          userId: founderUserId,
          provider: loginProvider,
        });
        const scopedEnv = scopedCliAuthEnv({}, authHome, loginProvider);
        const probed = await probeAndRecord({
          req,
          companyId,
          descriptor,
          scope: { type: "company_default" },
          adapterConfig: {
            env:
              loginProvider === "openai"
                ? { HOME: scopedEnv.HOME, CODEX_HOME: scopedEnv.CODEX_HOME }
                : {
                    HOME: scopedEnv.HOME,
                    CLAUDE_CONFIG_DIR: scopedEnv.CLAUDE_CONFIG_DIR,
                  },
          },
        });
        if (probed) {
          if (probed.outcome === "verified") {
            await verifyAndBindCommanderSubscriptionCredential(db, {
              companyId,
              userId: founderUserId,
              provider: loginProvider,
              executionTargetId,
              actorUserId: founderUserId,
            });
          }
          if (reprobedChallenges.size >= REPROBED_CHALLENGES_MAX) reprobedChallenges.clear();
          reprobedChallenges.add(challengeId);
          readiness = {
            scopeType: "company_default",
            scopeId: null,
            outcome: probed.outcome,
            testedAt: probed.testedAt,
            checks: probed.checks as unknown as ScopedReadinessDto["checks"],
          };
        }
      } catch (err) {
        // The sign-in genuinely succeeded; failing the poll would tell the
        // founder otherwise and invite a pointless retry.
        log.warn({ err, companyId, providerId }, "post-login re-probe failed");
      }
    }

    res.json({ ...status, readiness });
  });

  router.post("/:providerId/login/:challengeId/cancel", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const founderUserId = await assertFounderActor(req, res, companyId);
    if (!founderUserId) return;

    const providerId = req.params.providerId as string;
    if (!getProviderById(providerId)) {
      res.status(404).json({ error: `Unknown provider: ${providerId}` });
      return;
    }
    // Company- AND provider-scoped. The service enforces only the company
    // dimension, so without the provider check below a challengeId belonging to
    // ANOTHER provider in this company would terminate that provider's login
    // child. A mismatch reads as absent, exactly like an unknown challengeId.
    const challengeId = req.params.challengeId as string;
    if (
      !hasLoginRunner(providerId) ||
      !(await challengeBelongsToProvider(companyId, challengeId, providerId))
    ) {
      res.status(404).json({ error: "challenge not found" });
      return;
    }
    await loginService.cancel(
      companyId,
      challengeId,
      providerId as CommanderLoginProvider,
      founderUserId,
    );
    await auditProvider(companyId, founderUserId, "provider.login.cancelled", providerId, {
      challengeId,
    });
    res.json({ ok: true });
  });

  return router;
}
