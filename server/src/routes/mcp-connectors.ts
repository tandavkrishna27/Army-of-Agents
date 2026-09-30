import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@armyofagents/db";
import { companyMcpConnectors, mcpConnectorOauthFlows } from "@armyofagents/db";
import type { McpConnectorCatalogEntry } from "@armyofagents/shared";
import { RESERVED_MCP_SERVER_NAMES } from "@armyofagents/adapter-utils";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  approvalService,
  insertActivity,
  logActivity,
  mcpConnectorService,
  prepareMcpOAuthSecretVersion,
  publishActivity,
  secretService,
} from "../services/index.js";
import { badRequest, conflict, forbidden, unauthorized } from "../errors.js";
import {
  resolveConnectorCatalogService,
  type ConnectorCatalogService,
} from "../services/mcp-connector-catalog.js";
import {
  CONSENT_TOKEN_TTL_MS,
  mintConsentToken,
  resolveConsentSecret,
  verifyConsentToken,
} from "../services/mcp-connector-consent.js";
import {
  createConnector,
  type CreateConnectorDeps,
  type CreateConnectorInput,
} from "../services/mcp-connector-create.js";
import { resolveConnectorStatus } from "../services/mcp-connector-status.js";
import { assertTransportAllowed } from "../services/mcp-connector-transport-gate.js";
import {
  ConnectorCommandUnsafeError,
  assertStdioCommandSafe,
} from "../services/mcp-connector-command-safety.js";
import {
  buildAuthorizeUrl,
  discoverOAuthServer,
  exchangeAuthorizationCode,
  generatePkce,
  OAuthRequestError,
  registerOAuthClient,
  signOAuthState,
  verifyOAuthState,
} from "../services/mcp-connector-oauth.js";
import {
  decodeOAuthBundle,
  deriveOAuthBundleKey,
  encodeOAuthBundle,
  type OAuthTokenBundle,
} from "../services/mcp-connector-oauth-bundle.js";
import {
  assertCatalogEntryMatchesOAuthPolicy,
  assertDiscoveredOAuthMatchesPolicy,
  isOAuthCatalogEntrySupported,
  OAuthProviderPolicyError,
  requireOAuthProviderPolicy,
} from "../services/mcp-connector-oauth-policy.js";
import { isMcpConnectorBlocked } from "../services/mcp-connector-emergency-policy.js";
import { assertNotMcpOAuthManaged } from "../services/secrets.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { resolveInviteBaseUrl } from "./access-helpers.js";
import { assertRole } from "../middleware/rbac.js";
import { loadConfig } from "../config.js";

/**
 * Founder-facing CRUD for external MCP connectors. This is the WRITE PATH —
 * the first point where untrusted founder input enters the connector system —
 * so the validation below is load-bearing for security properties proven in
 * earlier tasks, NOT hygiene:
 *
 *  - serverName charset `/^[a-z0-9-]+$/` (A21): `envVarNameFor` maps every
 *    non-alphanumeric char to `_` and uppercases, so permitting `_` or
 *    uppercase would make that mapping non-injective and let two connectors
 *    collide on ONE secret env var — the wrong credential reaching the wrong
 *    server. The charset also structurally excludes `__proto__` (has `_`).
 *  - transport/url/command coherence (A20).
 *  - args/headerTemplate/envTemplate structural shape (A26): the runtime
 *    `buildConnectorSpecs` only guarantees "won't throw", not "well-formed".
 *
 * The DB deliberately enforces none of these (a CHECK on transport would be an
 * enum in disguise, A2), so THIS route is the single enforcement point for the
 * SHAPE of founder input.
 *
 * WHAT IS NOT HERE (I2): everything downstream of shape — the
 * (companyId, serverName) 409, the secretRef-existence check (A19/A20), status
 * derivation, the `install_mcp_connector` approval, and the activity log — lives
 * in the shared `createConnector` service (services/mcp-connector-create.ts).
 * That extraction is deliberate: the catalog install route creates connectors
 * too, and a second inline copy of that governance would drift, with the
 * marketplace copy being the untested one.
 *
 * GOVERNANCE (close the stdio→host-exec chain on a multi-tenant host):
 *  - D7/C1 (`assertTransportAllowed`, services/mcp-connector-transport-gate.ts):
 *    a `stdio` connector runs a command on the AoA host, so it is refused in
 *    `authenticated` mode for founder (BYO) input.
 *  - C2 (PATCH, governance axis): in `authenticated` mode PATCH may only set
 *    status to "disabled" — activation must flow through connector approval,
 *    never PATCH (which would otherwise be a one- or two-hop activation bypass).
 *  - FU-15 (PATCH, credential axis): in EVERY mode, PATCH refuses "active" while
 *    the connector requires a secret it does not have. `local_trusted`'s PATCH
 *    freedom is a decision about governance only; an uncredentialed connector
 *    cannot authenticate regardless of who flipped it.
 *  - C3: client-supplied `source` is stripped; every connector created here is
 *    forced to "byo", so the D7 catalog exemption is unreachable from this route.
 *  - C3 (POST …/:id/credentials): binding a secret re-derives the status through
 *    `resolveConnectorStatus` instead of accepting one. It cannot activate a
 *    connector still awaiting approval and cannot resurrect a disabled one, so it
 *    is not a second activation surface.
 *
 * RBAC (A20/D6): create/update/delete/agent-assignment are founder-only — team
 * leads may not add external network access unilaterally. List is any board
 * member.
 */

// LOAD-BEARING: lowercase letters, digits, hyphen only. Do not widen.
const SERVER_NAME_RE = /^[a-z0-9-]+$/;

// FU-20 / FINDING 1 — the ONLY credential form a connector may carry ANYWHERE is
// its OWN `${TOKEN}` indirection. Everything else — a literal secret VALUE, or ANY
// OTHER `${VAR}` — is refused at the door.
//
// Why this is security, not hygiene: `header_template` / `env_template` are plain
// jsonb columns, NOT the encrypted `company_secrets` store. A real token pasted
// here is persisted verbatim, written verbatim into the agent's on-disk CLI config
// (a git repo the agent can commit and push), returned in full by the board-wide
// list route, and echoed by the error handler on any 5xx. The D5 model is: config
// holds a placeholder, the credential lives in `company_secrets` and rides in the
// process env. `${TOKEN}` is the placeholder `buildConnectorSpecs` rewrites to the
// connector's real env var — and it rewrites ONLY `${TOKEN}`. So two distinct
// leaks were possible when the check was "value CONTAINS a `${...}`":
//   - `"Bearer ${TOKEN} sk-live-REAL"` — only `${TOKEN}` is rewritten; the literal
//     `sk-live-REAL` is copied verbatim into config. A real secret on disk.
//   - `"Bearer ${ANTHROPIC_API_KEY}"` — `${ANTHROPIC_API_KEY}` is NOT `${TOKEN}`, so
//     it is copied verbatim and the CLI expands it to AoA's ambient credential and
//     ships it in the third-party request. Ambient-credential exfiltration.
const OWN_TOKEN_PLACEHOLDER = "${TOKEN}";

// FU-2 still refuses ANY placeholder in `command` (the executable is not
// secret-substituted); `[^}]+` (non-empty inner) is enough for that check.
const SECRET_PLACEHOLDER_RE = /\$\{[^}]+\}/;

// A template VALUE is EMPTY, or an optional auth-scheme prefix + EXACTLY the
// connector's own `${TOKEN}` (`${TOKEN}`, `Bearer ${TOKEN}`, `Sentry-Bearer
// ${TOKEN}`). The `^…$` anchors reject a literal riding alongside the placeholder
// and a foreign `${VAR}`. FU-20 keeps this placeholder-or-empty: a non-secret
// CONSTANT header value is deliberately NOT a supported case — store the value in
// `company_secrets` and reference it.
const TEMPLATE_VALUE_RE = /^([A-Za-z][A-Za-z0-9-]* )?\$\{TOKEN\}$/;

// True when `v` contains any `${...}` occurrence that is NOT the connector's own
// `${TOKEN}`. Used for `args`, where a bare literal (a path/flag with no
// placeholder — `-y`, `fs-mcp`, `--token=${TOKEN}`) is legitimate, but a foreign
// `${VAR}` the CLI would expand to an ambient AoA process-env credential is not.
// `[^}]*` also catches the empty `${}`.
const FOREIGN_PLACEHOLDER_RE = /\$\{[^}]*\}/g;
function referencesForeignPlaceholder(v: string): boolean {
  const matches = v.match(FOREIGN_PLACEHOLDER_RE);
  return matches !== null && matches.some((m) => m !== OWN_TOKEN_PLACEHOLDER);
}

// FINDING 2 — does this BYO connector reference its own `${TOKEN}` anywhere
// (header/env template value or an arg)? If it does, `${TOKEN}` has to resolve to
// a bound secret at delivery, so the connector REQUIRES a secret. A connector that
// references `${TOKEN}` with no `secretRef` would otherwise derive to `active` yet
// authenticate as no-one — a silently-broken active connector. (`command` cannot
// carry a placeholder; FU-2 rejects that separately.)
function referencesOwnToken(body: {
  headerTemplate?: Record<string, string>;
  envTemplate?: Record<string, string>;
  args?: string[];
}): boolean {
  const anyValue = (rec?: Record<string, string>) =>
    Object.values(rec ?? {}).some((v) => v.includes(OWN_TOKEN_PLACEHOLDER));
  return (
    anyValue(body.headerTemplate) ||
    anyValue(body.envTemplate) ||
    (body.args ?? []).some((a) => a.includes(OWN_TOKEN_PLACEHOLDER))
  );
}

const templateValue = z
  .string()
  .refine((v) => v === "" || TEMPLATE_VALUE_RE.test(v), {
    message:
      "A connector template value must be empty or reference the connector's own secret as " +
      '"${TOKEN}" (optionally after an auth scheme, e.g. "Bearer ${TOKEN}"). Do not paste a real ' +
      "credential or any other ${VAR} here — store the secret as a company secret and bind it via " +
      "POST /companies/:companyId/mcp-connectors/:id/credentials.",
  });
const templateRecord = z.record(z.string(), templateValue);

// C3: `source` is DELIBERATELY absent from the schema and stripped from the body
// before validation, so a client can never set it (a spoofed `source:"catalog"`
// would otherwise walk past the D7 catalog exemption). Every connector created
// here is forced to `"byo"` server-side. Other unknown keys are still rejected
// by `.strict()`.
const stripClientSource = (val: unknown): unknown => {
  if (
    val &&
    typeof val === "object" &&
    !Array.isArray(val) &&
    "source" in val
  ) {
    const { source: _source, ...rest } = val as Record<string, unknown>;
    return rest;
  }
  return val;
};

const createConnectorSchema = z.preprocess(
  stripClientSource,
  z
    .object({
      serverName: z.string().regex(SERVER_NAME_RE, {
        message:
          "serverName must match /^[a-z0-9-]+$/ (lowercase letters, digits, hyphen)",
      }),
      displayName: z.string().min(1).max(200),
      transport: z.enum(["http", "stdio"]),
      url: z.string().url().optional(),
      command: z.string().min(1).optional(),
      args: z.array(z.string()).optional().default([]),
      headerTemplate: templateRecord.optional().default({}),
      envTemplate: templateRecord.optional().default({}),
      secretRef: z.string().min(1).optional(),
    })
    .strict()
    .superRefine((val, ctx) => {
      // FU-28 — reject a serverName that collides with an AoA-owned reserved/bridge
      // name (`aoa`, `playwright`, …). Such a connector is silently stripped at
      // delivery (`stripReservedMcpServerNames`) and never auto-allowed (the FU-25
      // parser rejects reserved names), so it would be a dead, confusing connector.
      // Refuse it up front with a clear reason instead. Charset is already lowercase
      // (`SERVER_NAME_RE`), matching the reserved list's casing exactly.
      if (
        (RESERVED_MCP_SERVER_NAMES as readonly string[]).includes(
          val.serverName
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["serverName"],
          message: `"${val.serverName}" is a reserved AoA server name and cannot be used for a connector`,
        });
      }

      if (val.transport === "http") {
        if (!val.url) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["url"],
            message: "http transport requires url",
          });
        }
        if (val.command !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["command"],
            message: "http transport forbids command",
          });
        }
      } else if (val.transport === "stdio") {
        if (!val.command) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["command"],
            message: "stdio transport requires command",
          });
        }
        if (val.url !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["url"],
            message: "stdio transport forbids url",
          });
        }
      }

      // FU-2 — a `${...}` placeholder in `command` is REFUSED, not substituted.
      //
      // DECISION (reject, not substitute): unlike `args`, `envTemplate` and
      // `headerTemplate` — which `buildConnectorSpecs` rewrites `${TOKEN}` ->
      // `${AOA_MCP_<name>_TOKEN}` — the executable `command` is copied verbatim,
      // so a placeholder there reaches the CLI as a literal `${...}` and spawns
      // as nothing. Two reasons to reject rather than close the substitution hole:
      //  1. `command` is the host-exec surface the whole D7 gate exists to guard.
      //     A secret belongs in an env var (or an arg the CLI expands), never
      //     baked into an executable path/name where it lands on a process command
      //     line (visible in `ps`/process listings) — the opposite of D5's
      //     "credential rides in the env, never in config/argv" model.
      //  2. Whether `${VAR}` even expands in the COMMAND position (vs args) is
      //     unverified across the four connector-capable CLIs; substituting on a
      //     guess risks shipping a literal `${VAR}` that authenticates as no-one
      //     (FU-21's failure mode in a new place). Rejecting is loud and early.
      // A secret in an executable path is almost always a mistake; the clean 400
      // here points the founder at args/env instead of failing silently at spawn.
      if (
        val.command !== undefined &&
        SECRET_PLACEHOLDER_RE.test(val.command)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["command"],
          message:
            "command must not contain a ${...} placeholder. The executable command is not " +
            "secret-substituted (only args and header/env templates are), so a placeholder here " +
            "would be spawned literally. Reference the binary by its real path and put any secret " +
            "in an arg or env template instead.",
        });
      }

      // FINDING 1 — an arg may carry the connector's OWN `${TOKEN}` (rewritten by
      // `buildConnectorSpecs`) but no other `${...}`. A bare literal arg is fine; a
      // foreign `${VAR}` would be expanded by the CLI to an ambient AoA credential.
      (val.args ?? []).forEach((arg, i) => {
        if (referencesForeignPlaceholder(arg)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["args", i],
            message:
              'A connector arg may reference only the connector\'s own "${TOKEN}"; any other ' +
              "${...} would be expanded to an AoA credential and leaked to the connector. Store the " +
              "secret as a company secret and reference it as ${TOKEN}.",
          });
        }
      });

      // FINDING 1 — a credential belongs in a header (as `${TOKEN}`), never in the
      // URL. Refuse userinfo in the authority (`user:pass@host`, or a `${...}`
      // there, which parses as the username). `z.string().url()` has already run,
      // so a present url parses.
      if (val.url) {
        try {
          const parsed = new URL(val.url);
          if (parsed.username !== "" || parsed.password !== "") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["url"],
              message:
                "url must not embed credentials in its authority (user:pass@host). Put any token in " +
                "a header template as ${TOKEN} and bind the secret via the credentials endpoint.",
            });
          }
        } catch {
          // Unreachable: z.string().url() already validated a present url.
        }
      }
    })
);

// PATCH is intentionally narrow: displayName + status only. Transport-relevant
// fields (transport/url/command/args/templates/serverName) cannot be edited —
// `.strict()` makes any such key a 400. Recreate the connector to change them.
//
// `secretRef` is NOT here on purpose, even though `ConnectorPatch` now carries it:
// changing the bound credential without re-deriving `status` in the same write is
// how a connector ends up `active` pointing at a dangling ref. Binding goes
// through POST …/:id/credentials, which validates the secret and re-derives.
//
// C2: the schema still accepts all three status values because `local_trusted`
// (which has no governance gate) may set any of them. The `authenticated`-mode
// restriction — status may ONLY be set to "disabled" — is enforced in the
// handler, because PATCH is currently the only activation path (the approval
// handler is deferred). Without it, `pending_approval → disabled → active`
// activates in two hops and reaches host-exec (for stdio) with no approval.
const updateConnectorSchema = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    status: z.enum(["active", "pending_approval", "disabled"]).optional(),
  })
  .strict()
  .refine((v) => v.displayName !== undefined || v.status !== undefined, {
    message: "Provide displayName and/or status",
  });

// C3 — the secret-binding body. `secretRef` and NOTHING else.
//
// The resulting status is DERIVED from `resolveConnectorStatus`, never accepted
// from the caller. `.strict()` (rather than quietly dropping unknown keys) is the
// load-bearing part: a request carrying `status: "active"` must be a 400. If it
// were silently ignored the caller would believe they had activated the
// connector, and the endpoint would read as a second activation surface next to
// the PATCH one the handler above works to close.
export const bindCredentialsSchema = z
  .object({ secretRef: z.string().min(1) })
  .strict();

const replaceAgentsSchema = z
  .object({
    agentIds: z.array(z.string().uuid()),
  })
  .strict();

// Empty body — the connector id in the path fully determines what is started.
// `.strict()` still rejects an unexpected payload rather than silently ignoring it.
export const oauthStartSchema = z.object({}).strict();
const MCP_OAUTH_MAINTENANCE_LOCK = "aoa:mcp-oauth-v2-maintenance";

// The callback is a browser redirect target, not a caller of `validate()` (the
// route is company-agnostic and unauthenticated by the usual actor helpers), so
// this is parsed inline with `.safeParse` rather than the `validate` middleware.
const oauthCallbackQuerySchema = z
  .object({
    code: z.string().min(1).optional(),
    state: z.string().min(1),
    error: z.string().min(1).optional(),
    error_description: z.string().max(1000).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.code) !== Boolean(value.error), {
    message: "OAuth callback must contain exactly one of code or error",
  });

/**
 * Catalog install body. `entryId` selects one of the server-fetched curated
 * entries; NOTHING else about the connector is client-controlled.
 *
 * `.strict()` is load-bearing twice over:
 *  1. A bare `z.object()` STRIPS unknown keys. If `consentToken` were ever
 *     dropped from this schema, the field would silently vanish from `req.body`
 *     and the consent gate would evaluate "no token supplied" — the gate would
 *     disappear rather than fail. Declaring it AND rejecting unknowns means a
 *     mistake here is a 400, never a silent downgrade.
 *  2. It REJECTS (rather than ignores) an injected `source` / `status` /
 *     `requiresSecret` / `trust` / `transport` / `command` / `args`. The BYO
 *     route strips a client `source` because it also accepts real connector
 *     fields; here every one of those axes comes from the catalog entry, so the
 *     honest answer to a client that sends one is "no", not "ignored".
 */
export const installFromCatalogSchema = z
  .object({
    entryId: z.string().min(1),
    consentToken: z.string().min(1).optional(),
  })
  .strict();

/**
 * Only an UNVERIFIED `stdio` entry needs command-bound consent.
 *
 * `stdio` because that is the transport that spawns a process on the AoA host;
 * `http` only makes a network call, so there is no command to consent to.
 * `!== "verified"` (rather than `=== "community"`) fails CLOSED: an unrecognised
 * or absent tier demands consent instead of skipping it.
 */
function requiresInstallConsent(entry: McpConnectorCatalogEntry): boolean {
  return entry.transport === "stdio" && entry.trust?.tier !== "verified";
}

/**
 * The exact argv a consent token binds to. Deliberately ONE definition shared by
 * the minting side and the verifying side — if the two ever constructed this
 * shape differently (say one passed `args: undefined` and the other `[]`) every
 * minted token would silently fail to verify, or worse, a token could verify
 * against argv it was not minted for.
 */
function consentSpecFor(entry: McpConnectorCatalogEntry) {
  return { command: entry.command ?? "", args: entry.args };
}

/**
 * The `redirect_uri` registered with the OAuth authorization server and echoed
 * back on callback. MUST be the operator-configured public origin, never a
 * spoofable `Host`/`X-Forwarded-Host` header, in any multi-human deployment —
 * a client-controlled redirect_uri would let an attacker steal the auth code.
 *
 * Fix 13: fail CLOSED. `local_trusted` is a loopback trust boundary (no header
 * spoofing threat model) and may fall back to a loopback origin; every other
 * deployment mode must have `authPublicBaseUrl` configured or this throws.
 */
function oauthRedirectUri(req: Request): string {
  const cfg = loadConfig();
  if (cfg.deploymentMode !== "local_trusted" && !cfg.authPublicBaseUrl) {
    throw badRequest(
      "Set AOA_AUTH_PUBLIC_BASE_URL before using OAuth connectors in this deployment mode"
    );
  }
  const origin = resolveInviteBaseUrl(req) || `http://127.0.0.1:${cfg.port}`; // local_trusted loopback fallback
  return `${origin.replace(/\/$/, "")}/api/mcp-connectors/oauth/callback`;
}

/**
 * Catalog entry -> `createConnector` input.
 *
 * D5 — template KEYS become EMPTY-VALUED entries. The catalog never carries a
 * credential (the shared schema constrains the key charsets precisely so a key
 * cannot smuggle a `Name: value` pair), so the connector is installed
 * credential-UNBOUND and the founder binds a real secret afterwards via
 * POST …/:id/credentials. `secretRef` is therefore always null here.
 *
 * `source` is the literal `"catalog"` — the vocabulary in
 * `company_mcp_connectors.ts` and in `assertTransportAllowed`. Any other string
 * (notably `"marketplace"`) would silently make the D7 catalog branch dead code
 * and route every catalog install through the BYO refusal instead.
 *
 * Pure and exported so the mapping is unit-tested without a route, a DB, or a
 * request.
 */
export function entryToCreateInput(
  entry: McpConnectorCatalogEntry,
  companyId: string,
  deploymentMode: string,
  actor: CreateConnectorInput["actor"]
): CreateConnectorInput {
  // Plain assignment onto a fresh `{}` is deliberate. Both the header and env
  // name charsets admit `__proto__`, and `obj["__proto__"] = ""` is a no-op
  // (assigning a non-object to [[Prototype]] is ignored) — so such a key is
  // DROPPED rather than propagated into a downstream header/env writer, and
  // `Object.prototype` is never touched. `Object.fromEntries` would instead
  // define it as a real own property and carry it downstream.
  // P1 (Codex): a declared credential key must carry the literal `${TOKEN}`
  // placeholder — buildConnectorSpecs rewrites it to the connector's
  // `${AOA_MCP_*_TOKEN}` ref and the CLI expands the real value at spawn. Empty
  // values meant a custom header (X-Api-Key) or stdio env key installed "active"
  // but ran UNAUTHENTICATED. `${TOKEN}` is a placeholder, never a value (D5-safe).
  //   - `Authorization` is owned by the Bearer synthesizer
  //     (withSynthesizedBearerHeader): leave it EMPTY so it fills `Bearer <token>`.
  //     A raw `${TOKEN}` there would make the synth back off AND send an
  //     unprefixed token.
  //   - Secretless entries (requiresSecret:false) keep empty values — there is no
  //     credential to wire, and an unresolved placeholder would break them.
  const tokenPlaceholder = entry.requiresSecret ? "${TOKEN}" : "";
  const headerTemplate: Record<string, string> = {};
  for (const key of entry.headerTemplateKeys) {
    headerTemplate[key] =
      key.toLowerCase() === "authorization" ? "" : tokenPlaceholder;
  }
  const envTemplate: Record<string, string> = {};
  for (const key of entry.envTemplateKeys) envTemplate[key] = tokenPlaceholder;
  const oauthPolicy = entry.requiresOAuth
    ? requireOAuthProviderPolicy(entry.id)
    : null;
  if (oauthPolicy) assertCatalogEntryMatchesOAuthPolicy(entry, oauthPolicy);

  return {
    companyId,
    serverName: entry.serverName,
    displayName: entry.displayName,
    transport: entry.transport,
    url: entry.url ?? null,
    command: entry.command ?? null,
    args: entry.args,
    headerTemplate,
    envTemplate,
    secretRef: null,
    // OAuth entries ALWAYS need a credential (the broker-issued access token),
    // even when the catalog's independent `requiresSecret` flag is unset — the
    // two booleans both default `false` and are not mutually implied. Without
    // this override a `requiresOAuth` entry with `requiresSecret:false` would
    // resolve `status: "active"` with no secret bound, and buildConnectorSpecs
    // only sets `authTokenEnvVar` when a secret value is present — so the
    // connector would go live and authenticate as no-one (silent 401 against the
    // provider). Do not rely on the producer publishing `requiresSecret:true`.
    requiresSecret: entry.requiresOAuth || entry.requiresSecret,
    source: "catalog",
    catalogEntryId: entry.id,
    oauthPolicyVersion: oauthPolicy?.version ?? null,
    // Persist the entry's trust tier so the FU-19 delivery-time D7 re-check can
    // honor the `catalog + verified` exemption after a mode conversion, exactly
    // like the create-time gate does. `entry.trust.tier` is always set (the
    // shared schema defaults it to "community" fail-closed); `?.` is defensive.
    trustTier: entry.trust?.tier ?? null,
    deploymentMode,
    actor,
  };
}

export interface McpConnectorRouteOptions {
  /** Injectable so route tests never touch the network. */
  catalog?: ConnectorCatalogService;
  /** Explicit test seam; production omits this and uses connection-pinned HTTPS. */
  oauthFetch?: typeof fetch;
}

export function mcpConnectorRoutes(
  db: Db,
  opts: McpConnectorRouteOptions = {}
) {
  const router = Router();
  const svc = mcpConnectorService(db);
  const secretsSvc = secretService(db);
  const approvalsSvc = approvalService(db);
  // Constructing this performs no I/O — the fetch happens on the first `load()`,
  // i.e. only when a founder actually opens the shelf.
  const connectorCatalog = opts.catalog ?? resolveConnectorCatalogService();

  // FINDING 4 — the atomic connector-insert + approval-insert runner both create
  // paths share. Rebinds `svc` + `approvalsSvc` to the transaction (the same
  // `tx as unknown as Db` pattern as routes/approvals.ts) so a failure in either
  // insert rolls back both, and a stranded `pending_approval`-without-approval
  // connector becomes impossible.
  const withInsertTransaction: CreateConnectorDeps["withInsertTransaction"] = (
    run
  ) =>
    db.transaction((tx) =>
      run({
        svc: mcpConnectorService(tx as unknown as Db),
        approvalsSvc: approvalService(tx as unknown as Db),
      })
    );

  // List — any board member with access to the company.
  router.get("/companies/:companyId/mcp-connectors", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    await assertCompanyAccess(db, req, companyId);
    const rows = await svc.list(companyId);
    res.json(
      rows.map((row) => {
        if (!row.catalogEntryId || !row.oauthPolicyVersion) {
          return { ...row, oauthEligibility: "not_oauth" as const };
        }
        const supported =
          isOAuthCatalogEntrySupported(
            row.catalogEntryId,
            row.oauthPolicyVersion
          ) && !isMcpConnectorBlocked(row.serverName);
        return supported
          ? { ...row, oauthEligibility: "supported" as const }
          : {
              ...row,
              oauthEligibility: "policy_blocked" as const,
              oauthUnavailableReason:
                "OAuth sign-in is disabled or unsupported by this server policy.",
            };
      })
    );
  });

  // The curated shelf — founder only, and THE way the UI obtains a consent token.
  //
  // WHY THE TOKEN IS MINTED HERE, in the same response that carries the command:
  // the token's whole job is to bind consent to the exact `(entryId, command,
  // args)` the founder was shown, because `connectors.json` re-syncs on a 6h TTL
  // and the entry rendered in a dialog is a DIFFERENT read of a mutable remote
  // file from the entry read at install time. Minting from the same read that is
  // serialised into this response makes "the bytes displayed" and "the bytes
  // signed" the same bytes BY CONSTRUCTION — there is no window in which a client
  // could render entry X's command while holding a token bound to entry Y.
  //
  // A separate `POST …/consent` mint endpoint would give the same binding but
  // costs a second round trip and a second catalog read that can disagree with
  // this one. It is NOT more secure: the server cannot prove a human read a
  // dialog either way, and an attacker holding a founder session could call
  // either endpoint. The token is a TOCTOU binding, not an anti-automation
  // device — so the cheaper shape with the stronger same-read invariant wins.
  //
  // Founder-only (not board-wide like the list above) because this endpoint mints
  // signed install material and only a founder can act on it. Loosening later is
  // safe; tightening later would be a breaking change.
  //
  // ⚠ Task 14 (UI): `consentExpiresAt` is present so the shelf can REFETCH before
  // opening the install dialog. Tokens live 15 minutes; rendering a dialog from a
  // shelf loaded an hour ago will 400 with `expired`.
  router.get("/companies/:companyId/mcp-connectors/catalog", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    await assertCompanyAccess(db, req, companyId);
    await assertRole(db, req, companyId, "founder");

      const nowMs = Date.now();
      const { entries, stale } = await connectorCatalog.load(nowMs);
      const deploymentMode = loadConfig().deploymentMode;

      // Resolved once, and only if some entry actually needs it. A missing signing
      // secret must degrade to "no tokens" (installs then fail loudly) rather than
      // 500 the whole shelf.
      let secret: string | null = null;
      if (entries.some(requiresInstallConsent)) {
        try {
          secret = resolveConsentSecret();
        } catch (err) {
          logger.warn(
            { err },
            "connector shelf: no signing secret available — consent tokens omitted"
          );
        }
      }

      const shelf = entries.map((entry) => {
        // A PROJECTION of the real gate, not a second implementation of it — same
        // function, same arguments the install handler will pass, so the shelf can
        // never disagree with what install will do.
        //
        // `unavailableReason` carries the GATE'S OWN message rather than letting the
        // client derive one. Today the gate has a single refusal branch, so a
        // client-side constant happens to be exact — but that is an accident of the
        // current implementation, and a second branch would turn it into a confident
        // lie about why a capability disappeared. Sourcing the copy from the thrown
        // error means the refusal the founder reads is always the refusal that
        // actually happened.
        let installable = true;
        let unavailableReason: string | undefined;
        // `entry.requiresOAuth` = declared in catalog; `oauthRequired` = the OAuth
        // path is actually available on THIS card (reset to false if D7 refuses).
        let oauthRequired = false;
        // OAuth-only entries are installable — the broker (Plan 4) handles the
        // authorize step post-install — so this branch just flags the entry and
        // still runs the D7 transport gate (same call, same arguments the install
        // handler will pass). The try/catch mirrors the non-OAuth branch below so a
        // D7 refusal degrades THIS card (installable:false, oauthRequired reset to
        // false) instead of throwing out of `entries.map` and 500-ing the whole
        // shelf.
        if (entry.requiresOAuth) {
          oauthRequired = isOAuthCatalogEntrySupported(entry.id);
          if (!oauthRequired) {
            installable = false;
            unavailableReason =
              "OAuth sign-in for this connector is not supported by this server version.";
          } else if (isMcpConnectorBlocked(entry.serverName)) {
            oauthRequired = false;
            installable = false;
            unavailableReason =
              "OAuth sign-in for this connector is disabled by the operator policy.";
          }
          try {
            if (installable) {
              const policy = requireOAuthProviderPolicy(entry.id);
              assertCatalogEntryMatchesOAuthPolicy(entry, policy);
              assertTransportAllowed(
                entry.transport,
                deploymentMode,
                "catalog",
                entry.trust?.tier
              );
            }
          } catch (err) {
            oauthRequired = false;
            installable = false;
            unavailableReason =
              err instanceof Error && err.message ? err.message : "Not allowed";
          }
        } else {
          try {
            assertTransportAllowed(
              entry.transport,
              deploymentMode,
              "catalog",
              entry.trust?.tier
            );
          } catch (err) {
            installable = false;
            unavailableReason =
              err instanceof Error && err.message
                ? err.message
                : "This connector cannot be installed in this deployment.";
          }
          // WS2: mirror the create-time command-safety gate (assertStdioCommandSafe,
          // which the install POST runs via createConnector). Without this, a stdio
          // entry whose command the create gate will reject — an unpinned package, a
          // non-npx/uvx launcher — is projected `installable: true`, rendering an
          // enabled Install button that always 400s. Same predicate + the gate's OWN
          // message, ordered after D7 and only when D7 still permits (so a D7 refusal
          // message is never clobbered). http entries have no command → skipped.
          if (installable && entry.transport === "stdio") {
            try {
              assertStdioCommandSafe(entry.command, entry.args);
            } catch (err) {
              installable = false;
              unavailableReason =
                err instanceof ConnectorCommandUnsafeError && err.message
                  ? err.message
                  : "This connector's command is not an allowed, version-pinned launcher.";
            }
          }
        }

        const consentRequired = requiresInstallConsent(entry);

        // FU-24 — a consent-gated stdio entry is installable ONLY if a consent
        // token can be minted, and a token cannot be minted without the server
        // signing secret. When the secret is unavailable the install POST would
        // reject on the missing token, so presenting the entry as `installable`
        // renders a dead Install button + consent dialog that always 400s. Mark it
        // unavailable with the real reason instead — the same shape D7-refused
        // entries already use, so "why can't I install this?" is always answered on
        // the shelf rather than buried in a log line. `installable` is only cleared
        // here when D7 already permitted it (still true), so this never clobbers the
        // D7 refusal message.
        if (installable && consentRequired && !secret) {
          installable = false;
          unavailableReason =
            "This connector runs a command on the AoA host and needs an install " +
            "confirmation the server cannot sign: no signing secret " +
            "(BETTER_AUTH_SECRET or AOA_AGENT_JWT_SECRET) is configured. Set one to " +
            "enable consent-gated connector installs.";
        }

        const base = {
          ...entry,
          installable,
          consentRequired,
          oauthRequired,
          ...(unavailableReason ? { unavailableReason } : {}),
        };

        // No token for an entry D7 will refuse, nor for one we could not sign
        // (installable was just cleared above). Handing one out would suggest
        // consent is the thing standing in the way, when the deployment simply may
        // not run host code at all. The `!secret` guard is retained so a token is
        // never minted against a null secret even if the branches above change.
        if (!consentRequired || !installable || !secret) return base;

        return {
          ...base,
          consentToken: mintConsentToken(
            secret,
            entry.id,
            consentSpecFor(entry),
            nowMs
          ),
          consentExpiresAt: nowMs + CONSENT_TOKEN_TTL_MS,
        };
      });

      res.json({ entries: shelf, stale });
    }
  );

  // Install from the curated catalog — founder only.
  //
  // C5 — RBAC IS DELIBERATELY *NOT* `canInstallType` from
  // routes/marketplace-installs.ts. That helper returns true for `team_lead` on
  // anything that is not a plugin, so routing through it would make the
  // marketplace a WEAKER door onto an object whose own CRUD (create/update/
  // delete/agent-assignment, above) is founder-only. Connectors are not catalog
  // items and do not go through marketplace-install/orchestrator.ts at all.
  //
  // ORDER OF OPERATIONS IS THE SECURITY PROPERTY. authz, then entry resolution,
  // then D7, then consent, then the shared create. In particular:
  //
  //  - D7 (`assertTransportAllowed`) is AUTHORIZATION: may this deployment cause
  //    a command to execute on the AoA host at all? It runs first, before any
  //    write, and its answer is final.
  //  - The consent token is a UX/TOCTOU binding: were these the exact bytes the
  //    founder was shown? It runs second, and ONLY for unverified stdio.
  //
  // NEITHER SUBSTITUTES FOR THE OTHER. A perfectly valid consent token does not
  // rescue an unverified stdio entry from D7 in `authenticated` mode — the gate
  // has already thrown by the time the consent branch is reached. There is a test
  // pinning exactly that; it is the most important assertion in this file's suite.
  router.post(
    "/companies/:companyId/mcp-connectors/install",
    validate(installFromCatalogSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      await assertCompanyAccess(db, req, companyId);
      await assertRole(db, req, companyId, "founder");

      const { entryId, consentToken } = req.body as z.infer<
        typeof installFromCatalogSchema
      >;

      // Linear scan over the fetched array on purpose: a keyed object lookup
      // would make `entryId: "__proto__"` resolve to something that is not an
      // entry. The client picks WHICH curated entry, never what is in it.
      const { entries } = await connectorCatalog.load(Date.now());
      const entry = entries.find((e) => e.id === entryId);
      if (!entry) {
        res.status(404).json({ error: "Connector not found in catalog" });
        return;
      }

      const deploymentMode = loadConfig().deploymentMode;

      if (entry.requiresOAuth) {
        if (isMcpConnectorBlocked(entry.serverName)) {
          throw badRequest(
            "OAuth sign-in for this connector is disabled by the operator policy."
          );
        }
        try {
          const policy = requireOAuthProviderPolicy(entry.id);
          assertCatalogEntryMatchesOAuthPolicy(entry, policy);
        } catch (error) {
          if (error instanceof OAuthProviderPolicyError) {
            throw badRequest(
              "OAuth sign-in for this connector is not supported by this server version."
            );
          }
          throw error;
        }
      }

      // (1) D7 — authorization. Before any write, independent of consent.
      assertTransportAllowed(
        entry.transport,
        deploymentMode,
        "catalog",
        entry.trust?.tier
      );

      // (2) Consent — UX/TOCTOU binding, unverified stdio only.
      if (requiresInstallConsent(entry)) {
        if (!consentToken) {
          throw badRequest(
            "This connector runs a command on the AoA host and its publisher is not verified. " +
              "Review the exact command on the connector shelf and confirm it to continue."
          );
        }
        // `resolveConsentSecret()` throwing here is a server misconfiguration and
        // is allowed to surface as a 500: failing the install closed is correct,
        // and silently treating "no secret" as "consent satisfied" would be the
        // one outcome worse than an error page.
        const verdict = verifyConsentToken(
          resolveConsentSecret(),
          entry.id,
          consentSpecFor(entry),
          consentToken,
          Date.now()
        );
        if (!verdict.ok) {
          // The reason is named because the fixes differ: `expired` means reload
          // the shelf, `signature_mismatch` means the command changed under you.
          throw badRequest(
            `Install confirmation is not valid for this connector (${verdict.reason}). ` +
              "Reload the connector shelf, review the command, and confirm again."
          );
        }
      }

      const actor = getActorInfo(req);

      // (3) The SHARED create service — same 409, secretRef check, status
      // derivation, approval and activity log as the BYO route. Nothing about
      // governance is re-implemented here.
      const { connector: created, approvalId } = await createConnector(
        {
          svc,
          secretsSvc,
          approvalsSvc,
          withInsertTransaction,
          logActivity: (logEntry) => logActivity(db, logEntry),
        },
        entryToCreateInput(entry, companyId, deploymentMode, actor)
      );

      res.status(201).json({ ...created, approvalId });
    }
  );

  // Create — founder only.
  router.post(
    "/companies/:companyId/mcp-connectors",
    validate(createConnectorSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      await assertCompanyAccess(db, req, companyId);
      await assertRole(db, req, companyId, "founder");

      const body = req.body as z.infer<typeof createConnectorSchema>;

      // C3: this route only ever creates BYO connectors. Any client `source` was
      // already stripped in the schema; the value is fixed server-side.
      const source = "byo";

      // FINDING 2 — a BYO connector that references `${TOKEN}` REQUIRES a secret.
      // Rejecting the placeholder-without-secretRef case here (rather than creating
      // it and letting it derive to `active`) is the cleanest option: it never
      // manufactures a broken-active connector, and it matches D5 (the secret is
      // bound up front for BYO). A connector with NO `${TOKEN}` (e.g. an
      // unauthenticated filesystem server) stays requiresSecret=false → active.
      const requiresSecret = referencesOwnToken(body);
      if (requiresSecret && !body.secretRef) {
        throw badRequest(
          "This connector references ${TOKEN} but binds no secret. Pass a secretRef so ${TOKEN} " +
            "resolves — otherwise the connector would activate yet authenticate as no-one. Store the " +
            "credential as a company secret and reference it here."
        );
      }

      const deploymentMode = loadConfig().deploymentMode;

      // C1/D7: reject a host-executing stdio connector in a shared deployment
      // BEFORE any write. `source` is the server-forced "byo" here, so the
      // catalog exemption is unreachable from this route by construction; the
      // trust tier is passed as an explicit `undefined` because a BYO connector
      // has no catalog provenance and therefore no tier to vouch for it (C4).
      assertTransportAllowed(body.transport, deploymentMode, source, undefined);

      const actor = getActorInfo(req);

      // Everything past the D7 gate — the (companyId, serverName) 409, the
      // secretRef-existence check, status derivation, the approval, and the
      // activity log — lives in the SHARED create service so the catalog install
      // route cannot fork it into an untested copy.
      const { connector: created, approvalId } = await createConnector(
        {
          svc,
          secretsSvc,
          approvalsSvc,
          withInsertTransaction,
          logActivity: (entry) => logActivity(db, entry),
        },
        {
          companyId,
          serverName: body.serverName,
          displayName: body.displayName,
          transport: body.transport,
          url: body.url ?? null,
          command: body.command ?? null,
          args: body.args,
          headerTemplate: body.headerTemplate,
          envTemplate: body.envTemplate,
          secretRef: body.secretRef ?? null,
          // FINDING 2: derived from whether the connector references `${TOKEN}`. A
          // BYO connector supplies its secret up front, so requiresSecret+secretRef
          // are bound together here (the placeholder-without-secretRef case was
          // already rejected above); a placeholder-free connector needs no secret.
          requiresSecret,
          source,
          // BYO has no catalog provenance, so no trust tier can vouch for it. Null
          // means the FU-19 delivery re-check treats it as non-exempt (correctly
          // dropped in `authenticated` — the very case D7 exists to prevent).
          trustTier: null,
          deploymentMode,
          actor,
        }
      );

      res.status(201).json({ ...created, approvalId });
    }
  );

  // Update displayName / status — founder only.
  router.patch(
    "/companies/:companyId/mcp-connectors/:id",
    validate(updateConnectorSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      assertBoard(req);
      await assertCompanyAccess(db, req, companyId);
      await assertRole(db, req, companyId, "founder");

      const existing = await svc.getById(id);
      if (!existing || existing.companyId !== companyId) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }

      const deploymentMode = loadConfig().deploymentMode;
      const nextStatus = (req.body as z.infer<typeof updateConnectorSchema>)
        .status;

      // FU-15 — CREDENTIAL precondition on activation. Applies in EVERY deployment
      // mode, and is checked before the governance gate below so it is not shadowed
      // in `authenticated` (where governance would refuse first).
      //
      // Governance and credentials are orthogonal, and `local_trusted`'s PATCH
      // freedom is a decision about GOVERNANCE only. A connector with
      // `requiresSecret` and no bound secret cannot authenticate no matter who
      // flips it, so permitting `active` there just manufactures a broken connector
      // that `selectConnectorRowsForAgent` then delivers to agents. The old
      // exemption was written when the two axes were still one.
      //
      // Routed through `resolveConnectorStatus` rather than hand-written as
      // `requiresSecret && !secretRef`, so the credential rule keeps living in
      // exactly one place (plan invariant #3) and this gate inherits any future
      // change to it. `approved: true` deliberately NEUTRALISES the governance axis
      // — that axis is the next block's job — which leaves the credential axis as
      // the only thing that can make the answer anything other than "active".
      if (nextStatus === "active") {
        const credentialsPermitActive =
          resolveConnectorStatus({
            deploymentMode,
            approved: true,
            // `!== false` fails CLOSED: anything that is not explicitly false is
            // treated as "needs a secret". `=== true` would let a malformed value
            // ("true", 1) read as "no secret needed" and activate. The column is
            // `notNull().default(false)`, so this is defensive only.
            requiresSecret: existing.requiresSecret !== false,
            // Empty string names no secret, so it is not a bound credential.
            hasSecret: Boolean(existing.secretRef),
          }) === "active";
        if (!credentialsPermitActive) {
          throw badRequest(
            "This connector requires a credential and none is bound, so it cannot be " +
              "activated. Bind one first with POST /companies/:companyId/mcp-connectors/:id/" +
              "credentials."
          );
        }
      }

      // C2: in a shared deployment, PATCH may only DEACTIVATE. Activation
      // (active) and re-arming for approval (pending_approval) must not be
      // reachable through PATCH — they would bypass the approval gate, including
      // the two-hop pending→disabled→active path. Deactivation is always safe.
      // local_trusted has no governance gate, so it is unrestricted — on the
      // governance axis only; the credential precondition above still applies.
      if (
        deploymentMode !== "local_trusted" &&
        nextStatus !== undefined &&
        nextStatus !== "disabled"
      ) {
        throw badRequest(
          "In this deployment a connector can only be disabled via update; activation flows " +
            "through connector approval, not this endpoint."
        );
      }

      const updated = await svc.update(id, req.body);
      if (!updated) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "mcp_connector.updated",
        entityType: "mcp_connector",
        entityId: id,
        details: req.body,
      });

      res.json(updated);
    }
  );

  // Bind a company secret to a connector, then RE-DERIVE its status — founder only.
  //
  // C3: this is the missing middle of the central journey. A catalog connector is
  // installed unconfigured (`needs_credentials`) and must never reach an agent
  // until a credential is bound; before this route there was no way to set
  // `secretRef` after create, so `needs_credentials → active` was unreachable.
  router.post(
    "/companies/:companyId/mcp-connectors/:id/credentials",
    validate(bindCredentialsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      assertBoard(req);
      await assertCompanyAccess(db, req, companyId);
      await assertRole(db, req, companyId, "founder");

      const existing = await svc.getById(id);
      if (!existing || existing.companyId !== companyId) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }

      const { secretRef } = req.body as z.infer<typeof bindCredentialsSchema>;

      // Same A19/A20 rule as create: a secretRef must name an EXISTING company
      // secret. Rejecting the dangling ref here beats letting the delivery path
      // silently drop the connector at run time. Scoped to this company, so a
      // founder cannot bind another tenant's secret.
      const secret = await secretsSvc.getByName(companyId, secretRef);
      if (!secret) {
        throw badRequest(
          `secretRef "${secretRef}" does not reference an existing secret`
        );
      }
      assertNotMcpOAuthManaged(secret.providerMetadata);

      // HOW `approved` IS INFERRED, and why the current status is a sound signal.
      //
      // There is no approval pointer on the connector row, so the status itself is
      // the only governance evidence available. It is sufficient because status is
      // the OUTPUT of the governance axis, and only two writers produce it:
      //   - create  (mcp-connector-create.ts): in a non-local_trusted deployment a
      //     new connector is ALWAYS `pending_approval`, whatever its credentials.
      //   - approve/reject (applyConnectorApproval / applyConnectorRejection).
      // So in a shared deployment a connector can reach `needs_credentials` or
      // `active` ONLY by having been approved, and `pending_approval` means it has
      // not been. That makes the mapping below a reading of governance state, not a
      // guess:
      //   pending_approval → not yet approved  → binding leaves it pending (no bypass)
      //   disabled         → rejected/deactivated
      //   needs_credentials / active → governance already satisfied
      //
      // `disabled` is short-circuited rather than fed to the resolver: with
      // approved=true the resolver would answer `active`, i.e. binding a secret
      // would RESURRECT a connector the board rejected.
      //
      // In `authenticated`, `disabled` is effectively TERMINAL. Nothing re-enables
      // it: PATCH → active is refused by the C2 governance gate, `applyConnectorApproval`
      // short-circuits `disabled` too, and an `install_mcp_connector` approval is only
      // ever created inside `createConnector` — no route re-requests approval for an
      // existing connector. Recreating the connector is the way back. In
      // `local_trusted`, PATCH → active re-enables it (no governance gate there).
      //
      // Nothing here decides `active` on its own — `resolveConnectorStatus` does,
      // and it is unconditionally incapable of returning `active` while the
      // connector requires a secret it does not have.
      const approved =
        existing.status !== "pending_approval" &&
        existing.status !== "disabled";
      const nextStatus =
        existing.status === "disabled"
          ? "disabled"
          : resolveConnectorStatus({
              deploymentMode: loadConfig().deploymentMode,
              approved,
              // `!== false` fails closed; see applyConnectorApproval for the rationale.
              requiresSecret: existing.requiresSecret !== false,
              // A non-empty secretRef was just validated to exist, so it IS bound.
              hasSecret: true,
            });

      // Guarded on the status we READ: `nextStatus` was derived from that snapshot,
      // so if the board approved (or the founder disabled) between the read and here,
      // this matches 0 rows rather than overwriting the newer state with a stale
      // derivation. The damaging interleave is exactly this one — bind landing last
      // in `authenticated` would park the connector at `pending_approval` with the
      // approval already closed and no way back. A 409 tells the founder to retry,
      // which then derives from the current row.
      const updated = await svc.updateIfStatus(id, existing.status, {
        secretRef,
        status: nextStatus,
      });
      if (!updated) {
        throw conflict(
          "This connector changed while the credential was being bound. Retry the request."
        );
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "mcp_connector.credentials_bound",
        entityType: "mcp_connector",
        entityId: id,
        // `secretRef` is a secret NAME, never a secret value — safe to log, and it
        // is what makes a later "which credential was bound?" audit answerable.
        details: { secretRef, status: nextStatus },
      });

      res.json(updated);
    }
  );

  // Delete — founder only.
  router.delete("/companies/:companyId/mcp-connectors/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertBoard(req);
    await assertCompanyAccess(db, req, companyId);
    await assertRole(db, req, companyId, "founder");

      const existing = await svc.getById(id);
      if (!existing || existing.companyId !== companyId) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }

      const removed = await svc.remove(id);
      if (!removed) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "mcp_connector.deleted",
        entityType: "mcp_connector",
        entityId: id,
        details: { serverName: removed.serverName },
      });

      res.json(removed);
    }
  );

  // Replace the enabled-agent set — founder only.
  router.put(
    "/companies/:companyId/mcp-connectors/:id/agents",
    validate(replaceAgentsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      assertBoard(req);
      await assertCompanyAccess(db, req, companyId);
      await assertRole(db, req, companyId, "founder");

      const existing = await svc.getById(id);
      if (!existing || existing.companyId !== companyId) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }

      const { agentIds } = req.body as z.infer<typeof replaceAgentsSchema>;

      // Every agent must belong to THIS company — a connector must never be
      // granted to an agent from another tenant.
      const owned = await svc.agentIdsInCompany(companyId, agentIds);
      const ownedSet = new Set(owned);
      const foreign = [...new Set(agentIds)].filter(
        (agentId) => !ownedSet.has(agentId)
      );
      if (foreign.length > 0) {
        throw forbidden(
          `Agents do not belong to this company: ${foreign.join(", ")}`
        );
      }

      await svc.replaceAgents(companyId, id, agentIds);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "mcp_connector.agents_replaced",
        entityType: "mcp_connector",
        entityId: id,
        details: { agentIds: [...new Set(agentIds)] },
      });

      res.json({ connectorId: id, agentIds: [...new Set(agentIds)] });
    }
  );

  // Start an OAuth authorization flow for a connector — founder only.
  router.post(
    "/companies/:companyId/mcp-connectors/:id/oauth/start",
    validate(oauthStartSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      assertBoard(req);
      await assertCompanyAccess(db, req, companyId);
      await assertRole(db, req, companyId, "founder");

      const deploymentMode = loadConfig().deploymentMode;
      const actor = getActorInfo(req);
      if (
        deploymentMode !== "local_trusted" &&
        (req.actor.type !== "board" ||
          req.actor.source !== "session" ||
          !req.actor.userId)
      ) {
        throw forbidden(
          "OAuth sign-in must be started from an authenticated browser session"
        );
      }

      const connector = await mcpConnectorService(db).getById(id);
      if (!connector || connector.companyId !== companyId) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }
      if (isMcpConnectorBlocked(connector.serverName)) {
        throw forbidden(
          "OAuth sign-in is disabled by the operator's connector policy"
        );
      }
      if (connector.transport !== "http" || !connector.url) {
        throw badRequest("OAuth is only available for HTTP connectors");
      }
      // A disabled connector must not be re-authorized back to life through this
      // side door — re-enabling flows through create/approve, never oauth/start.
      if (connector.status === "disabled") {
        throw badRequest("This connector is disabled");
      }
      // OAuth authority comes only from immutable install identity and current
      // server policy. The remote catalog is mutable display/distribution data;
      // an authorization restart must not depend on it being live or unchanged.
      if (
        connector.source !== "catalog" ||
        !connector.catalogEntryId ||
        !connector.oauthPolicyVersion
      ) {
        throw badRequest("This connector does not use OAuth sign-in");
      }
      const policy = requireOAuthProviderPolicy(
        connector.catalogEntryId,
        connector.oauthPolicyVersion
      );
      if (
        connector.transport !== "http" ||
        connector.url !== policy.resourceUrl
      ) {
        throw new OAuthProviderPolicyError(
          "Stored OAuth connector does not match server policy"
        );
      }

      // Fail fast + clearly rather than 500 deep in signOAuthState when no signing
      // secret is configured (mirrors the shelf's graceful handling).
      try {
        resolveConsentSecret();
      } catch {
        throw badRequest(
          "OAuth connectors need a signing secret to secure the sign-in flow, and none is configured " +
            "(BETTER_AUTH_SECRET or AOA_AGENT_JWT_SECRET). Run `aoa onboard` or set one before authorizing OAuth connectors."
        );
      }

      // Better Auth user IDs are opaque text. Preserve the exact authenticated
      // session identity; null is reserved for the synthetic local operator.
      const startedByUserId =
        deploymentMode === "local_trusted" ? null : req.actor.userId!;

      // Fix 4: hoisted ahead of the discovery network call so a misconfigured
      // deployment (no AOA_AUTH_PUBLIC_BASE_URL outside local_trusted) fails
      // closed before any outbound request is made, not after.
      const redirectUri = oauthRedirectUri(req);

      const discovered = await discoverOAuthServer(
        connector.url,
        opts.oauthFetch
      );
      assertDiscoveredOAuthMatchesPolicy(discovered, policy);
      if (
        !policy.allowDynamicClientRegistration ||
        !policy.registrationEndpoint
      ) {
        throw badRequest(
          "This connector's authorization server does not support dynamic client registration"
        );
      }

      // Fix 12: on re-authorize the connector already has a stored bundle carrying a DCR clientId —
      // reuse it instead of orphaning a fresh client on the provider. First-auth registers a client.
      const secretName = `mcp:oauth:${connector.id}`;
      const bundleKey = deriveOAuthBundleKey(resolveConsentSecret());
      const bundleContext = {
        companyId,
        connectorId: connector.id,
        catalogEntryId: policy.entryId,
        oauthPolicyVersion: policy.version,
        secretName,
      };
      const priorBundle =
        connector.secretRef === secretName
          ? decodeOAuthBundle(
              await secretService(db)
                .resolveByName(companyId, secretName, {
                  consumerType: "system",
                  consumerId: "oauth-broker",
                   actorType: "system",
                   configPath: `mcp.connector.${connector.serverName}`,
                   mcpOAuthOwner: {
                     connectorId: connector.id,
                     catalogEntryId: policy.entryId,
                     oauthPolicyVersion: policy.version,
                   },
                 })
                .catch(() => ""),
              bundleKey,
              bundleContext
            )
          : null;
      const clientId =
        priorBundle?.redirectUri === redirectUri
          ? priorBundle.clientId
          : (
              await registerOAuthClient(
                policy.registrationEndpoint,
                redirectUri,
                opts.oauthFetch
              )
            ).clientId;

      const { verifier, challenge } = generatePkce();
      const nowMs = Date.now();
      const nonce = randomUUID();
      const state = signOAuthState({
        connectorId: id,
        companyId,
        nonce,
        exp: nowMs + 10 * 60_000,
      });
      const resource = policy.resourceUrl;
      // Least privilege (review I2): request the connector's DECLARED scopes when
      // the catalog entry names them, and only fall back to the AS-advertised set
      // for connectors that declare none (discovery-first providers like Notion
      // advertise a minimal default). Requesting the AS's entire scopes_supported
      // for a declaring connector would over-grant the broker.
      const scopes = [...policy.scopes];

      const authorizeUrl = buildAuthorizeUrl({
        authorizationEndpoint: policy.authorizationEndpoint,
        clientId,
        redirectUri,
        scopes,
        resource,
        state,
        codeChallenge: challenge,
      });

      const activityEvent = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        // Rollback takes the exclusive form of this transaction-scoped lock.
        // New OAuth work must not appear after rollback has taken its snapshot.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock_shared(hashtext(${MCP_OAUTH_MAINTENANCE_LOCK}))`
        );
        const currentConnector = await txDb
          .select()
          .from(companyMcpConnectors)
          .where(eq(companyMcpConnectors.id, connector.id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !currentConnector ||
          currentConnector.companyId !== companyId ||
          currentConnector.status === "disabled" ||
          currentConnector.source !== "catalog" ||
          currentConnector.catalogEntryId !== policy.entryId ||
          currentConnector.oauthPolicyVersion !== policy.version ||
          currentConnector.transport !== "http" ||
          currentConnector.url !== policy.resourceUrl
        ) {
          throw conflict("Connector changed while OAuth sign-in was starting");
        }
        await tx.insert(mcpConnectorOauthFlows).values({
          companyId,
          connectorId: id,
          catalogEntryId: policy.entryId,
          oauthPolicyVersion: policy.version,
          state,
          pkceVerifier: verifier,
          clientId,
          redirectUri,
          authorizationEndpoint: policy.authorizationEndpoint,
          tokenEndpoint: policy.tokenEndpoint,
          resource,
          scopes,
          status: "pending",
          startedByUserId,
          expiresAt: new Date(nowMs + 10 * 60_000),
        });
        return insertActivity(txDb, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "mcp_connector.oauth_started",
          entityType: "mcp_connector",
          entityId: id,
          details: { serverName: connector.serverName },
        });
      });
      try {
        publishActivity(activityEvent);
      } catch (publishErr) {
        logger.warn(
          { err: publishErr, connectorId: connector.id },
          "OAuth start activity publication failed after commit"
        );
      }
      res.json({ authorizeUrl });
    }
  );

  // OAuth authorization callback. Signed state authenticates the flow identity;
  // outside local_trusted the current browser session must additionally match
  // both the persisted starter user and company before any provider request.
  router.get("/mcp-connectors/oauth/callback", async (req, res) => {
    const parsed = oauthCallbackQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).send("Invalid OAuth callback");
      return;
    }
    const { code, state, error: providerError } = parsed.data;

    const payload = verifyOAuthState(state, Date.now());
    if (!payload) {
      res.status(400).send("Invalid or expired OAuth state");
      return;
    }

    const flows = await db
      .select()
      .from(mcpConnectorOauthFlows)
      .where(eq(mcpConnectorOauthFlows.state, state))
      .limit(1);
    const flow = flows[0];
    if (
      !flow ||
      flow.connectorId !== payload.connectorId ||
      flow.companyId !== payload.companyId
    ) {
      res.status(400).send("OAuth flow not found");
      return;
    }
    if (new Date() > new Date(flow.expiresAt)) {
      res.status(400).send("OAuth flow expired");
      return;
    }

    const deploymentMode = loadConfig().deploymentMode;
    if (deploymentMode !== "local_trusted") {
      if (
        req.actor.type !== "board" ||
        req.actor.source !== "session" ||
        !req.actor.userId
      ) {
        throw unauthorized(
          "Sign in with the browser session that started OAuth"
        );
      }
      const sameUser = req.actor.userId === flow.startedByUserId;
      const sameCompany =
        req.actor.isInstanceAdmin === true ||
        (req.actor.companyIds ?? []).includes(flow.companyId);
      if (!sameUser || !sameCompany) {
        res
          .status(403)
          .send("OAuth callback session does not match the flow owner");
        return;
      }
    }

    // Fix 6: atomically CLAIM the flow BEFORE touching the code. Only one concurrent callback can
    // move pending -> claimed, so the state/code is single-use (no replay within the 10-min TTL).
    const claimed = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock_shared(hashtext(${MCP_OAUTH_MAINTENANCE_LOCK}))`
      );
      return tx
        .update(mcpConnectorOauthFlows)
        .set({ status: "claimed", updatedAt: new Date() })
        .where(
          and(
            eq(mcpConnectorOauthFlows.id, flow.id),
            eq(mcpConnectorOauthFlows.status, "pending")
          )
        )
        .returning();
    });
    if (claimed.length === 0) {
      res.status(400).send("OAuth flow already used");
      return;
    }

    const callbackRedirect = (
      result: "completed" | "failed",
      reason?: string
    ) => {
      const query = new URLSearchParams({
        connectorId: flow.connectorId,
        oauthResult: result,
      });
      if (reason) query.set("reason", reason);
      return `/marketplace/connectors?${query.toString()}`;
    };
    const failFlow = () =>
      db
        .transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock_shared(hashtext(${MCP_OAUTH_MAINTENANCE_LOCK}))`
          );
          await tx
            .update(mcpConnectorOauthFlows)
            .set({ status: "failed", updatedAt: new Date() })
            .where(
              and(
                eq(mcpConnectorOauthFlows.id, flow.id),
                eq(mcpConnectorOauthFlows.status, "claimed")
              )
            );
        })
        .catch(() => {});

    if (providerError) {
      await failFlow();
      res.redirect(
        302,
        callbackRedirect(
          "failed",
          providerError === "access_denied" ? "access_denied" : "provider_error"
        )
      );
      return;
    }

    const connector = await mcpConnectorService(db).getById(flow.connectorId);
    if (!connector || connector.companyId !== flow.companyId) {
      // The flow was already claimed above — a connector-not-found reject must
      // still revert it to failed, or the row is stuck "claimed" forever (not
      // replayable, but not honestly reporting what happened either).
      await failFlow();
      res.redirect(302, callbackRedirect("failed", "connector_changed"));
      return;
    }

    try {
      if (
        connector.status === "disabled" ||
        isMcpConnectorBlocked(connector.serverName) ||
        !connector.catalogEntryId ||
        !connector.oauthPolicyVersion ||
        connector.catalogEntryId !== flow.catalogEntryId ||
        connector.oauthPolicyVersion !== flow.oauthPolicyVersion
      ) {
        throw new OAuthProviderPolicyError(
          "Connector is no longer eligible for OAuth"
        );
      }
      const policy = requireOAuthProviderPolicy(
        connector.catalogEntryId,
        connector.oauthPolicyVersion
      );
      if (
        flow.resource !== policy.resourceUrl ||
        flow.authorizationEndpoint !== policy.authorizationEndpoint ||
        flow.tokenEndpoint !== policy.tokenEndpoint ||
        JSON.stringify(flow.scopes) !== JSON.stringify([...policy.scopes])
      ) {
        throw new OAuthProviderPolicyError(
          "OAuth flow no longer matches provider policy"
        );
      }

      const token = await exchangeAuthorizationCode(
        {
          tokenEndpoint: policy.tokenEndpoint,
          code: code!,
          codeVerifier: flow.pkceVerifier,
          clientId: flow.clientId,
          redirectUri: flow.redirectUri,
          resource: flow.resource,
        },
        opts.oauthFetch
      );
      const secretName = `mcp:oauth:${connector.id}`;
      const bundleKey = deriveOAuthBundleKey(resolveConsentSecret());
      const bundle: OAuthTokenBundle = {
        companyId: flow.companyId,
        connectorId: connector.id,
        catalogEntryId: policy.entryId,
        oauthPolicyVersion: policy.version,
        secretName,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: Date.now() + token.expiresIn * 1000,
        issuer: policy.issuer,
        tokenEndpoint: policy.tokenEndpoint,
        clientId: flow.clientId,
        redirectUri: flow.redirectUri,
        scopes: [...policy.scopes],
        resource: policy.resourceUrl,
      };
      const secrets = secretService(db);
      const existing = await secrets.getByName(flow.companyId, secretName);
      const prepared = await prepareMcpOAuthSecretVersion({
        companyId: flow.companyId,
        value: encodeOAuthBundle(bundle, bundleKey),
        owner: {
          connectorId: connector.id,
          catalogEntryId: policy.entryId,
          oauthPolicyVersion: policy.version,
        },
        expectedLatestVersion: existing?.latestVersion ?? 0,
      });
      // Final-review Fix 3: capture whether the guarded bind actually matched a
      // row. `updateIfStatus` is guarded on the `connector.status` snapshot read
      // above — if a concurrent write (board approval/rejection, disable) moved
      // the row between that read and here, this matches 0 rows. The secret was
      // already created/rotated at that point, but it was never bound to the
      // connector — completing the flow and logging an "authorized" activity
      // regardless would be a lying audit trail (the log says success, the
      // connector row disagrees). Revert the flow to failed and 409 instead of
      // falling through to "completed" + success logging + redirect.
      const activityEvent = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock_shared(hashtext(${MCP_OAUTH_MAINTENANCE_LOCK}))`
        );
        // The provider exchange intentionally runs without a DB transaction.
        // Lock and re-read every durable trust input now, immediately before the
        // first credential write, so a disable or emergency-policy change during
        // the browser/provider round trip cannot be committed afterward.
        const lockedFlow = await txDb
          .select()
          .from(mcpConnectorOauthFlows)
          .where(eq(mcpConnectorOauthFlows.id, flow.id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !lockedFlow ||
          lockedFlow.status !== "claimed" ||
          lockedFlow.companyId !== flow.companyId ||
          lockedFlow.connectorId !== flow.connectorId ||
          lockedFlow.catalogEntryId !== flow.catalogEntryId ||
          lockedFlow.oauthPolicyVersion !== flow.oauthPolicyVersion
        ) {
          throw conflict("OAuth flow changed during authorization");
        }

        const lockedConnector = await txDb
          .select()
          .from(companyMcpConnectors)
          .where(eq(companyMcpConnectors.id, flow.connectorId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !lockedConnector ||
          lockedConnector.companyId !== flow.companyId ||
          lockedConnector.source !== "catalog" ||
          lockedConnector.status === "disabled" ||
          !["active", "needs_credentials", "pending_approval"].includes(
            lockedConnector.status
          ) ||
          lockedConnector.catalogEntryId !== lockedFlow.catalogEntryId ||
          lockedConnector.oauthPolicyVersion !== lockedFlow.oauthPolicyVersion
        ) {
          throw conflict("Connector changed during authorization");
        }
        if (isMcpConnectorBlocked(lockedConnector.serverName)) {
          throw new OAuthProviderPolicyError(
            "Connector is blocked by emergency policy"
          );
        }
        const currentPolicy = requireOAuthProviderPolicy(
          lockedConnector.catalogEntryId!,
          lockedConnector.oauthPolicyVersion!
        );
        if (
          lockedConnector.transport !== "http" ||
          lockedConnector.url !== currentPolicy.resourceUrl ||
          lockedFlow.resource !== currentPolicy.resourceUrl ||
          lockedFlow.authorizationEndpoint !==
            currentPolicy.authorizationEndpoint ||
          lockedFlow.tokenEndpoint !== currentPolicy.tokenEndpoint ||
          JSON.stringify(lockedFlow.scopes) !==
            JSON.stringify([...currentPolicy.scopes])
        ) {
          throw new OAuthProviderPolicyError(
            "OAuth flow no longer matches provider policy"
          );
        }

        await secretService(txDb).commitPreparedMcpOAuthSecret(prepared, {
          userId: flow.startedByUserId ?? null,
        });
        const bound = await mcpConnectorService(txDb).updateIfStatus(
          lockedConnector.id,
          lockedConnector.status,
          {
            secretRef: secretName,
            status: resolveConnectorStatus({
              deploymentMode,
              approved: lockedConnector.status !== "pending_approval",
              requiresSecret: true,
              hasSecret: true,
            }),
          }
        );
        if (!bound) throw conflict("Connector changed during authorization");
        const completed = await txDb
          .update(mcpConnectorOauthFlows)
          .set({
            status: "completed",
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(mcpConnectorOauthFlows.id, flow.id),
              eq(mcpConnectorOauthFlows.status, "claimed")
            )
          )
          .returning();
        if (completed.length === 0)
          throw conflict("OAuth flow changed during authorization");
        return insertActivity(txDb, {
          companyId: flow.companyId,
          actorType: "system",
          actorId: "oauth-broker",
          agentId: null,
          action: "mcp_connector.oauth_authorized",
          entityType: "mcp_connector",
          entityId: connector.id,
          details: { serverName: connector.serverName, secretRef: secretName },
        });
      });
      try {
        publishActivity(activityEvent);
      } catch (publishErr) {
        // The durable activity row and connector state are authoritative. A
        // broken in-memory listener must not turn a committed authorization into
        // a failure redirect that encourages a destructive retry.
        logger.warn(
          { err: publishErr, connectorId: connector.id },
          "OAuth callback activity publication failed after commit"
        );
      }
    } catch (err) {
      // Fix 6: a failed exchange/store must not leave the flow replayable — revert to failed.
      await failFlow();
      logger.warn({ err, connectorId: connector.id }, "OAuth callback failed");
      const message = err instanceof Error ? err.message : "";
      const reason =
        err instanceof OAuthProviderPolicyError ||
        (err instanceof OAuthRequestError && err.kind === "policy")
          ? "policy_blocked"
          : (err as { status?: number })?.status === 409 &&
            message.includes("owned")
          ? "secret_collision"
          : (err as { status?: number })?.status === 409
          ? "connector_changed"
          : "token_exchange_failed";
      res.redirect(302, callbackRedirect("failed", reason));
      return;
    }

    res.redirect(302, callbackRedirect("completed"));
  });

  return router;
}
