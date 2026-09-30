import type { McpServerSpec } from "@armyofagents/adapter-utils";
import {
  RESERVED_MCP_SERVER_NAMES,
  isStdioServerSpec,
  stdioSpecCarriesSecretPlaceholder,
} from "@armyofagents/adapter-utils";
import { isTransportAllowed } from "./mcp-connector-transport-gate.js";
import { isStdioCommandSafe } from "./mcp-connector-command-safety.js";

/**
 * Server-name charset a connector is allowed to use — the SAME regex the
 * catalog + BYO write paths enforce (`packages/shared` SERVER_NAME_RE and
 * `server/src/routes/mcp-connectors.ts`). Duplicated as a literal here (not
 * imported) because those live in @armyofagents/shared and the server route
 * respectively; keeping a local copy avoids a new cross-package import for one
 * regex while the value stays greppable. No underscores — that is what lets us
 * split an MCP tool name on `__` unambiguously.
 */
const CONNECTOR_SERVER_NAME_RE = /^[a-z0-9-]+$/;

/**
 * Parse the `serverName` out of an MCP tool name of the form
 * `mcp__<serverName>__<tool>` and return it IFF it is a plausible founder
 * connector server name — i.e. it matches the connector charset AND is not one
 * of the reserved/bridge names AoA owns (`aoa`, `playwright`, …). Returns null
 * for anything that is not a well-formed, non-reserved connector tool name.
 *
 * This is the security-critical parser for the runtime auto-allow path: a tool
 * whose name does not resolve to a non-reserved connector serverName here can
 * NEVER be auto-allowed as "the assigned connector's own tool".
 *
 * Format contract (verified against the catalog SERVER_NAME_RE): a serverName
 * never contains `__` (no underscores at all), so `serverName` is exactly the
 * segment at index 1 after splitting on `__`. The tool portion (everything
 * after the second `__`) may itself contain `__`; it does not affect which
 * connector this belongs to, so it is only required to be non-empty.
 *
 * Rejected (→ null): a null/empty/non-string input; a name not prefixed with
 * `mcp__`; `mcp__` (no serverName); `mcp__x` (no tool separator); `mcp__srv__`
 * (empty tool); a serverName outside the connector charset; and any reserved
 * name (`mcp__aoa__*`, `mcp__playwright__*`).
 */
export function parseConnectorServerName(toolName: string | null | undefined): string | null {
  if (typeof toolName !== "string") return null;
  if (!toolName.startsWith("mcp__")) return null;
  const segments = toolName.split("__");
  // ["mcp", serverName, ...toolParts]. Fewer than 3 segments means there is no
  // tool portion at all (e.g. "mcp__" → ["mcp",""], "mcp__x" → ["mcp","x"]).
  if (segments.length < 3) return null;
  const serverName = segments[1];
  if (!serverName || !CONNECTOR_SERVER_NAME_RE.test(serverName)) return null;
  // Require a NON-BLANK tool portion. A join+length check is not enough (FINDING 8):
  // "mcp__notion__ " splits to [...," "] and "mcp__notion____" to [...,"",""], whose
  // joins (" " and "__") are non-empty strings and would slip through, resolving to
  // a grantable serverName with no real tool. Test the underlying segments for any
  // non-whitespace content instead, which rejects empty, whitespace-only, and
  // separator-only tool portions alike.
  const toolSegments = segments.slice(2);
  if (!toolSegments.some((s) => s.trim().length > 0)) return null;
  // Reserved/bridge names are AoA-owned, not founder connectors — they have
  // their own handling and must never be treated as a connector grant.
  if ((RESERVED_MCP_SERVER_NAMES as readonly string[]).includes(serverName)) return null;
  return serverName;
}

/**
 * A connector row joined with its resolved secret value. Source table:
 * `company_mcp_connectors` (packages/db/src/schema/company_mcp_connectors.ts) —
 * keep the field names identical so drift is greppable.
 *
 * PRECONDITION: `args`/`headerTemplate`/`envTemplate` arrive non-null (the
 * columns are NOT NULL with defaults). These are jsonb, so `$type<string[]>()`
 * is a compile-time assertion with no runtime guarantee (A5) — buildConnectorSpecs
 * defends against a violation rather than trusting it.
 */
export interface ResolvedConnectorRow {
  serverName: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: string[];
  headerTemplate: Record<string, string>;
  envTemplate: Record<string, string>;
  /** Real secret. NEVER placed into a spec — only into the returned env map. */
  secretValue: string | null;
}

/**
 * A resolved connector row PLUS the audit metadata the delivery-audit needs
 * (`mcp_connector.delivered`, Decision #116 clause 7). The loader returns these;
 * `buildConnectorSpecs` consumes only the {@link ResolvedConnectorRow} subset
 * (the extra fields are ignored), so its many unit-test fixtures stay minimal.
 */
export interface LoadedConnectorRow extends ResolvedConnectorRow {
  connectorId: string;
  /** Catalog trust tier, or null for BYO. */
  trustTier: string | null;
}

/** Why a connector row produced no spec. */
export type ConnectorSkipReason =
  | "missing_url"
  | "missing_command"
  | "unknown_transport"
  | "malformed_row"
  /**
   * D7 (FU-19): the connector was admissible when it was CREATED but the host's
   * CURRENT deployment mode would refuse to create it now — e.g. a stdio/byo
   * connector registered under `local_trusted`, then the instance converted to
   * `authenticated`, where that command is remote code execution on shared
   * infrastructure. The admission gate is create-time only; this is the
   * delivery-time re-assertion. Named so it can later surface in the UI (FU-1
   * already references a "D7 block" reason that did not previously exist).
   */
  | "d7_blocked"
  /**
   * WS2 (Decision #116 clause 7): a stdio connector whose command is not a
   * pinned launcher package. The create chokepoint refuses such a command, but
   * legacy/imported/direct-DB rows can still carry one, so delivery re-checks the
   * same predicate (`isStdioCommandSafe`) and fails closed. UNLIKE `d7_blocked`,
   * this is MODE-INDEPENDENT — the pinning policy is universal. Only fires for a
   * row that HAS a command; a stdio row with no command is `missing_command`
   * (reported by `buildConnectorSpecs`), the pre-existing reason.
   */
  | "unsafe_command";

export interface ConnectorBuildResult {
  specs: Record<string, McpServerSpec>;
  env: Record<string, string>;
  /**
   * Connectors that were dropped, and why. A silently vanishing connector is
   * the worst failure mode for a security-adjacent feature (A8), and a pure
   * function cannot log — so it reports instead. Callers are expected to
   * surface this.
   */
  skipped: Array<{ serverName: string; reason: ConnectorSkipReason }>;
}

/**
 * Deterministic env var name for a connector's secret. The config file
 * references this name; the real value is injected into the spawned process
 * env (design decision D5, empirically verified in Task 4).
 *
 * Each non-alphanumeric character maps to ONE underscore — deliberately not
 * `[^a-zA-Z0-9]+`, which would collapse runs and lose information (`a-b` and
 * `a--b` would share an env var). This mapping is still not injective (`a-b`
 * and `a_b` both yield `A_B`), so it does NOT by itself guarantee that two
 * connectors get distinct env vars; uniqueness must come from validating
 * serverName's charset at write time.
 */
export function envVarNameFor(serverName: string): string {
  const slug = serverName.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return `AOA_MCP_${slug}_TOKEN`;
}

/**
 * Adapter types whose runtime can actually host external MCP servers, and are
 * therefore worth a connector DB read before a run.
 *
 * SINGLE SOURCE OF TRUTH for the connector gate — both delivery call sites
 * (`heartbeat.ts` and the crew `aoa-agents/runner.ts`) import
 * `adapterSupportsConnectors` from here rather than repeating the list. Lives
 * in this pure module (no drizzle, no `@armyofagents/db`) so the two callers
 * share it without either importing the other, and so tests that mock
 * `mcp-connectors-loader.js` wholesale still get the real predicate.
 *
 * Everything NOT listed here (`process`, `http`, `cursor`, `hermes_local`, the
 * test adapters) has no MCP client at all: resolving connectors for them would
 * be wasted I/O plus a needless per-run failure surface, so they must never
 * trigger the lookup.
 */
export const CONNECTOR_CAPABLE_ADAPTERS: ReadonlySet<string> = new Set([
  "claude_local",
  "codex_local",
  "gemini_local",
  "opencode_local",
]);

/** True when `adapterType` can consume external MCP connectors. */
export function adapterSupportsConnectors(adapterType: string | null | undefined): boolean {
  return typeof adapterType === "string" && CONNECTOR_CAPABLE_ADAPTERS.has(adapterType);
}

/**
 * The D7-relevant fields a connector row carries at delivery. `trustTier` IS a
 * stored column (`company_mcp_connectors.trust_tier`), set at install from the
 * catalog entry's trust tier and null for BYO (FU-19 follow-up). Persisting it
 * lets the delivery re-gate honor the `catalog + verified` exemption after a
 * `local_trusted -> authenticated` conversion — exactly as the create-time gate
 * does — so a previously-verified catalog stdio connector keeps working while a
 * null (BYO) or non-verified tier still fails closed. That is the correct reading
 * of a gate whose justification is "may this host execute this command": it must
 * evaluate against the SAME provenance the create-time gate approved.
 */
interface D7RelevantRow {
  transport?: string;
  source?: string;
  trustTier?: string | null;
  /** WS2: the stdio command + args the delivery-time command-safety re-check reads. */
  command?: string | null;
  args?: string[];
}

export interface ConnectorSelectionInput<T extends { id: string; status: string }> {
  connectors: T[];
  enabledConnectorIds: Set<string>;
  /** Commander receives every ACTIVE connector, exempt from per-agent opt-in (D3). */
  isCommander: boolean;
  /**
   * The host's CURRENT deployment mode. When provided, D7 is re-asserted at
   * delivery (FU-19) and a connector the current host would refuse to CREATE is
   * dropped rather than delivered. Omitting it preserves the pre-FU-19
   * behaviour (no re-gate) — callers on the real delivery path always pass it.
   */
  deploymentMode?: string;
  /**
   * U11: true when THIS run resolved a per-run E2B sandbox execution target
   * (`acquisition.environment.driver === "sandbox"`, S5). Passed straight
   * through to `isTransportAllowed` as the sandbox axis — it relaxes ONLY the
   * stdio-transport admissibility check, never the command-pinning check
   * below. Additive: omitted/`false` is byte-identical to pre-U11 behaviour.
   */
  sandboxTarget?: boolean;
  /** Sink for connectors dropped by the delivery-time D7 re-gate, so the drop is nameable, not silent. */
  onSkip?: (connector: T, reason: ConnectorSkipReason) => void;
}

/**
 * Single source of truth for which connectors an agent run receives.
 *
 * Status is checked FIRST and applies to Commander too — the D3 exemption is
 * from the per-agent opt-in ONLY, never from approval status. A
 * `pending_approval` connector has not been approved by anyone; handing it to
 * Commander would make the approval gate bypassable by asking Commander
 * instead of an agent.
 *
 * Deliberately the only place the status rule lives. The loader passes ALL of a
 * company's connector rows through here rather than pre-filtering by status in
 * SQL — two copies of a security predicate drift, and the SQL copy is the one
 * no unit test covers.
 */
export function selectConnectorRowsForAgent<T extends { id: string; status: string }>(
  input: ConnectorSelectionInput<T>,
): T[] {
  return input.connectors.filter((c) => {
    if (c.status !== "active") return false;
    if (!input.isCommander && !input.enabledConnectorIds.has(c.id)) return false;
    // FU-19: re-assert D7 against the host's CURRENT mode. This is an ADDITIONAL
    // exclusion layered on the allowlist above (status + opt-in) — never a
    // denylist. A connector the current host could not be asked to create is
    // dropped WITH a reason, not delivered. Skipped (not thrown): one
    // inadmissible connector must degrade to "that connector is unavailable",
    // never break the whole run.
    if (input.deploymentMode !== undefined) {
      const row = c as unknown as D7RelevantRow;
      const allowed = isTransportAllowed(
        row.transport ?? "",
        input.deploymentMode,
        row.source ?? "",
        // Stored column is nullable; the gate takes `string | undefined` and
        // treats a null/missing tier as unverified (fail-closed).
        row.trustTier ?? undefined,
        input.sandboxTarget ?? false,
      );
      if (!allowed) {
        input.onSkip?.(c, "d7_blocked");
        return false;
      }
    }
    // WS2: command-safety re-check. MODE-INDEPENDENT (not gated on deploymentMode,
    // unlike D7) — the pinning policy is universal. Only a stdio row that HAS a
    // command is checked: a commandless stdio row stays and is reported
    // `missing_command` by buildConnectorSpecs (the pre-existing reason), so this
    // gate does not steal that classification. A legacy/imported row whose command
    // the create chokepoint would now refuse is dropped WITH a reason, not run.
    const safetyRow = c as unknown as D7RelevantRow;
    if (
      safetyRow.transport === "stdio" &&
      safetyRow.command &&
      !isStdioCommandSafe(safetyRow.command, safetyRow.args)
    ) {
      input.onSkip?.(c, "unsafe_command");
      return false;
    }
    return true;
  });
}

/**
 * Convert connector rows into adapter specs + the env map carrying secrets.
 * Templates use the literal token `${TOKEN}`, rewritten to the connector's
 * real env var name. All three template surfaces behave alike: http `headers`,
 * stdio `env`, and stdio `args`.
 *
 * Rows that cannot form a valid spec are SKIPPED rather than emitted
 * malformed: http without url, stdio without command, any unrecognized
 * transport, and any row whose jsonb columns are the wrong runtime shape. Each
 * skip is reported in `skipped` — never swallowed. One bad row must degrade to
 * "that connector is unavailable", never "no connectors at all" (A19).
 */
export function buildConnectorSpecs(rows: ResolvedConnectorRow[]): ConnectorBuildResult {
  // Null-prototype: serverName is an untrusted runtime string from a DB row. A
  // connector named `__proto__` assigned onto a normal object literal would set
  // the prototype instead of adding a key, and the connector would silently
  // vanish here — BEFORE buildMcpConfig's own guard could ever see it
  // (amendment A13). A charset check does not substitute: `__proto__` passes
  // /^[a-zA-Z0-9_-]+$/ (amendment A8-CORRECTION).
  const specs: Record<string, McpServerSpec> = Object.create(null);
  const env: Record<string, string> = Object.create(null);
  const skipped: ConnectorBuildResult["skipped"] = [];

  for (const row of rows) {
    const varName = envVarNameFor(row.serverName);
    const substitute = (value: string): string => value.replaceAll("${TOKEN}", `\${${varName}}`);
    const substituteValues = (template: Record<string, string>): Record<string, string> =>
      Object.fromEntries(Object.entries(template).map(([k, v]) => [k, substitute(v)]));

    // A malformed row must not take the healthy ones down with it: `args.map`
    // and `Object.entries` throw if a jsonb column holds the wrong runtime
    // shape (A5/A19). Structural validation belongs at write time (Task 11);
    // this is the defensive floor.
    try {
      if (row.transport === "http") {
        if (!row.url) {
          skipped.push({ serverName: row.serverName, reason: "missing_url" });
          continue;
        }
        specs[row.serverName] = {
          kind: "http",
          url: row.url,
          headers: substituteValues(row.headerTemplate),
          // Env-var-NAME indirection for CLIs that take a variable name rather
          // than expanding `${VAR}` inline (e.g. codex's `bearer_token_env_var`).
          // Same `varName` as the env map key below — never a secret value, and
          // never set when there is no secret to point at.
          ...(row.secretValue ? { authTokenEnvVar: varName } : {}),
        };
      } else if (row.transport === "stdio") {
        if (!row.command) {
          skipped.push({ serverName: row.serverName, reason: "missing_command" });
          continue;
        }
        specs[row.serverName] = {
          kind: "stdio",
          command: row.command,
          // Substituted like headers/env: Task 4 proved `${VAR}` expands in
          // stdio args too, so a connector configured as `["--token", "${TOKEN}"]`
          // must get the real var name. Copying verbatim would emit a literal
          // `${TOKEN}`, which expands to nothing and authenticates as no-one.
          args: row.args.map((value) => substitute(value)),
          env: substituteValues(row.envTemplate),
          // The stdio counterpart of `authTokenEnvVar`, and the AUTHORITATIVE
          // "this connector has a secret" signal for writers. codex cannot
          // deliver a stdio secret at all (B2N9) and must skip such connectors,
          // but it cannot infer "has a secret" from placeholder shape: a
          // secretless connector can still contain `${AOA_MCP_*}` text, and
          // skipping it as `secret_unreachable` would be a false positive. Only
          // `row.secretValue` tells the truth, and only this module sees it.
          ...(row.secretValue ? { secretEnvVar: varName } : {}),
        };
      } else {
        // Unknown transport — skip rather than guess. `transport` is free text
        // in the schema and A2 anticipates "sse" being added later; an `else`
        // that fell through to stdio would emit a stdio spec for any such row
        // that happened to carry a command.
        skipped.push({ serverName: row.serverName, reason: "unknown_transport" });
        continue;
      }
    } catch {
      skipped.push({ serverName: row.serverName, reason: "malformed_row" });
      continue;
    }

    // MUST stay below the branch. Hoisting it above would write a live
    // credential into the spawn env for a connector that has no config entry —
    // readable by the CLI and by every other stdio connector in the run.
    if (row.secretValue) {
      env[varName] = row.secretValue;
    }
  }

  return { specs, env, skipped };
}

/**
 * The adapter type whose runtime cannot deliver a stdio connector's secret at
 * all (Plan 2b B2N9). codex expands nothing inside stdio `args`/`env` AND scrubs
 * its own environment before spawning an MCP child, so a `${AOA_MCP_*}`
 * placeholder never resolves. The native TOML writer classifies that as
 * `secret_unreachable` (`packages/adapters/codex-local/.../codex-config-toml.ts`);
 * the deliverability preview below mirrors that exact verdict for the Settings
 * surface so the founder learns it WITHOUT a run having to fail first.
 */
const CODEX_ADAPTER_TYPE = "codex_local";

/**
 * Why an ACTIVE connector would not currently reach an intended recipient.
 *
 * A SUPERSET of the two upstream skip vocabularies, deliberately reusing their
 * member names so the preview cannot drift into a third dialect:
 *  - `missing_url` | `missing_command` | `unknown_transport` | `malformed_row`
 *    | `d7_blocked` — the server-side {@link ConnectorSkipReason} (bad row → no
 *    spec, or the delivery-time D7 re-gate). These are CONNECTOR-GLOBAL: they do
 *    not depend on which agent receives the connector.
 *  - `secret_unreachable` — the adapter-writer skip
 *    (`McpWriterSkipReason` in `@armyofagents/adapter-utils`). This is
 *    PER-ADAPTER: only codex cannot deliver a stdio secret, so the same
 *    connector can be deliverable to a claude agent and undeliverable to a codex
 *    one.
 *  - `adapter_incapable` — the assigned agent's adapter has no MCP client at all
 *    (`process`/`http`/…); the connector is silently absent for that agent.
 *    Also per-adapter, and not expressible in either upstream vocabulary because
 *    those describe rows/specs, not the recipient.
 */
export type ConnectorDeliverabilityReason =
  | ConnectorSkipReason
  | "secret_unreachable"
  | "adapter_incapable"
  | "credential_inactive_or_missing";

/** One assigned agent that would NOT receive an otherwise-active connector. */
export interface BlockedAgentDeliverability {
  agentId: string;
  agentName: string;
  reason: ConnectorDeliverabilityReason;
}

/**
 * Computed "would this connector actually reach agents right now?" summary for
 * the Settings surface (FU-1). Only produced for ACTIVE connectors — a
 * non-active connector's status badge already explains itself, so
 * {@link computeConnectorDeliverability} returns `null` for those.
 */
export interface ConnectorDeliverabilitySummary {
  /** True iff no global block AND no assigned agent is blocked. */
  deliverable: boolean;
  /**
   * A CONNECTOR-GLOBAL block (D7, or a malformed/incomplete row) that stops the
   * connector reaching ANY recipient — Commander included. `null` when the
   * connector is well-formed and admissible and only per-agent issues (if any)
   * remain.
   */
  reason: ConnectorDeliverabilityReason | null;
  /**
   * Assigned agents that individually cannot receive the connector even though
   * it is globally deliverable (codex `secret_unreachable`, or a non-MCP
   * adapter). Empty when `reason` is set (a global block supersedes) or when
   * every assigned agent can receive it.
   */
  blockedAgents: BlockedAgentDeliverability[];
}

export interface ConnectorDeliverabilityInput {
  connector: {
    status: string;
    transport: string;
    source?: string;
    trustTier?: string | null;
    url: string | null;
    command: string | null;
    args: string[];
    headerTemplate: Record<string, string>;
    envTemplate: Record<string, string>;
    /** The BOUND secret reference, if any. A non-null value means "has a secret". */
    secretRef: string | null;
  };
  /** The host's CURRENT deployment mode — the axis the D7 re-gate evaluates. */
  deploymentMode: string;
  /**
   * Whether the connector's BOUND secret currently resolves — i.e. a company
   * secret row exists that is not deleted and `status = "active"` (F2). The
   * caller evaluates this (batched, non-decrypting) and passes it in; the pure
   * function stays DB-free. `undefined` = caller did not evaluate → legacy
   * presence-only behavior (no `credential_inactive_or_missing`).
   */
  secretResolvable?: boolean;
  /** The connector's per-agent opt-in set, resolved to name + adapter type. */
  assignedAgents: Array<{
    agentId: string;
    agentName: string;
    adapterType: string | null | undefined;
  }>;
}

/**
 * Compute whether an ACTIVE connector would currently be delivered, and if not,
 * the classified reason — WITHOUT depending on a run having happened (option A).
 *
 * Faithful to the real delivery pipeline because it reuses the SAME primitives
 * the pipeline uses:
 *  1. D7 re-gate — `isTransportAllowed` (the exact check inside
 *     `selectConnectorRowsForAgent`). A connector the current host would refuse
 *     to CREATE is globally undeliverable → `d7_blocked`.
 *  2. Spec shape — `buildConnectorSpecs`. A row that produces no spec
 *     (`missing_url`/`missing_command`/`unknown_transport`/`malformed_row`) is
 *     globally undeliverable with that exact reason. Secret PRESENCE is modeled
 *     by a sentinel `secretValue` derived from `secretRef` so the spec's
 *     `secretEnvVar` signal is set exactly when a real secret is bound — the
 *     real value is neither known nor needed here.
 *  3. Per-adapter writer — `stdioSpecCarriesSecretPlaceholder` (the exact
 *     predicate the codex TOML writer skips on) for codex, and
 *     `adapterSupportsConnectors` for a non-MCP adapter.
 *
 * Returns `null` for a non-active connector: its status badge is the surface.
 */
export function computeConnectorDeliverability(
  input: ConnectorDeliverabilityInput,
): ConnectorDeliverabilitySummary | null {
  const { connector, deploymentMode, assignedAgents } = input;
  if (connector.status !== "active") return null;

  // (1) D7 — connector-global, and applied FIRST exactly as the delivery
  // selector does. A connector the current host may not execute reaches no one.
  const d7Ok = isTransportAllowed(
    connector.transport,
    deploymentMode,
    connector.source ?? "",
    connector.trustTier ?? undefined,
  );
  if (!d7Ok) {
    return { deliverable: false, reason: "d7_blocked", blockedAgents: [] };
  }

  // (1a) Command safety — connector-global (WS2), the exact predicate the delivery
  // selector re-checks. MODE-INDEPENDENT: a stdio command the create chokepoint
  // would now refuse reaches no recipient. Only a row that HAS a command is
  // flagged here; a commandless stdio row falls through to the spec-shape build
  // below, which reports `missing_command` (the faithful reason). Ordered D7 →
  // unsafe_command → credential → spec, matching the delivery pipeline.
  if (
    connector.transport === "stdio" &&
    connector.command &&
    !isStdioCommandSafe(connector.command, connector.args)
  ) {
    return { deliverable: false, reason: "unsafe_command", blockedAgents: [] };
  }

  // (1b) Credential state — connector-global (F2). A connector active with a
  // bound secret that no longer resolves (deleted or disabled) is dropped by the
  // loader for EVERY recipient, yet the row stays `active` → the preview would
  // otherwise show it healthy. `secretResolvable === false` means the bound
  // secret is missing/inactive; `undefined` = caller did not evaluate (legacy).
  // Order is faithful: after D7 (selector), before the loader's secret-resolve
  // step that the spec-shape build models below.
  const hasSecret = Boolean(connector.secretRef);
  if (hasSecret && input.secretResolvable === false) {
    return { deliverable: false, reason: "credential_inactive_or_missing", blockedAgents: [] };
  }

  // (2) Spec shape — connector-global. Model secret PRESENCE (not value) so the
  // built spec's `secretEnvVar`/`authTokenEnvVar` signal matches production.
  const { specs, skipped } = buildConnectorSpecs([
    {
      serverName: "preview", // key is irrelevant here; a single-row build
      transport: connector.transport,
      url: connector.url,
      command: connector.command,
      args: connector.args,
      headerTemplate: connector.headerTemplate,
      envTemplate: connector.envTemplate,
      // Sentinel: only truthiness matters. NEVER a real credential — this path
      // does not resolve secrets, and must not.
      secretValue: hasSecret ? " bound" : null,
    },
  ]);
  if (skipped.length > 0) {
    return { deliverable: false, reason: skipped[0].reason, blockedAgents: [] };
  }

  const spec = specs.preview;

  // (3) Per-assigned-agent adapter checks. A connector with no assigned agents
  // is not a failure: it still reaches Commander (all-active) and any agent the
  // founder later assigns, so there is nothing to warn about.
  const blockedAgents: BlockedAgentDeliverability[] = [];
  for (const agent of assignedAgents) {
    if (!adapterSupportsConnectors(agent.adapterType)) {
      blockedAgents.push({
        agentId: agent.agentId,
        agentName: agent.agentName,
        reason: "adapter_incapable",
      });
      continue;
    }
    // codex cannot deliver a stdio secret at all — the SAME predicate its TOML
    // writer skips on, so this preview cannot disagree with the real write.
    if (
      agent.adapterType === CODEX_ADAPTER_TYPE &&
      spec &&
      isStdioServerSpec(spec) &&
      stdioSpecCarriesSecretPlaceholder(spec)
    ) {
      blockedAgents.push({
        agentId: agent.agentId,
        agentName: agent.agentName,
        reason: "secret_unreachable",
      });
    }
  }

  return {
    deliverable: blockedAgents.length === 0,
    reason: null,
    blockedAgents,
  };
}
