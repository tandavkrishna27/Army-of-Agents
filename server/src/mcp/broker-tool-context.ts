// server/src/mcp/broker-tool-context.ts
//
// U2b (Cloud Execution Isolation / E2B, Wave 1) — server-side resolver that
// builds the internal-agent `ToolContext` for a sandboxed agent run FROM the
// run-JWT identity + the control-plane `db`.
//
// Why this exists: an E2B-sandboxed crew/org run executes inside a VM that
// must never hold direct DB credentials. The VM instead talks to a broker
// running on the control plane over the network (wired in U2c); the broker
// verifies the run-JWT minted for that run (U3, `agent-auth-jwt.ts` —
// `sub`=agentId, `company_id`=companyId, `run_id`=runId) and calls this
// resolver to build the SAME `ToolContext` shape the in-process crew runner
// (`aoa-agents/runner.ts`) already builds for a local (non-sandboxed) run.
//
// Security property: the ONLY inputs are the run-JWT's verified identity
// (agentId/companyId/runId) and the control-plane `db` — never a
// client-supplied companyId. `agentId`/`companyId` are compared against the
// `agents` row to assert the run cannot widen its own tenant.
import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, discussions, heartbeatRuns, internalAgentConfig, issues } from "@armyofagents/db";
import type { CommanderToolPermissions } from "@armyofagents/shared";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { ToolContext } from "../services/internal-agent/types.js";
import { createServiceContainer } from "../services/internal-agent/service-container.js";
import { createToolRegistry } from "../services/internal-agent/tool-registry.js";
import { deriveEnabledCapabilities } from "../services/internal-agent/aoa-agents/derive-capabilities.js";
import {
  ORG_HEARTBEAT_ENABLED_CAPABILITIES,
  ORG_HEARTBEAT_TOOL_ALLOWLIST,
  resolveHeartbeatEffectiveAutonomy,
} from "../services/heartbeat-mcp.js";

// Mirrors the crew subagent session identity contract in
// `aoa-agents/runner.ts` (SUBAGENT_SESSION_USER_ID / SUBAGENT_SESSION_USER_ROLE
// — verified there against `submit_extracted_items`' requiredRole==="founder",
// authorize-tool.ts ROLE_RANK). A broker-resolved ToolContext represents the
// SAME class of caller (a crew/org agent run, never a human board session), so
// it reuses the identical placeholder session identity rather than inventing
// a second one. Not exported from runner.ts, so re-declared here verbatim.
const BROKER_SESSION_USER_ID = "aoa-subagent";
const CREW_SESSION_USER_ROLE = "founder";
// Mirrors the ORG heartbeat stdio path's `heartbeatMcpParams.userRole`
// (`heartbeat.ts` ~4598) — org agents run as `team_member`, never `founder`.
// Using the crew (founder-session) role here would be a latent privilege
// elevation for org runs (Wave 1 review, FIX A).
const ORG_SESSION_USER_ROLE = "team_member";

// Built once at module load — the SAME call `aoa-agents/runner.ts` makes
// (`TOOL_REGISTRY_FOR_CAPABILITY_DERIVATION = createToolRegistry()`).
// `createToolRegistry()` returns `AgentTool[]` with static name+category; the
// heavy per-tool `execute` callbacks are not invoked by capability derivation,
// so this is cheap to build once and reuse across every resolver call.
const TOOL_REGISTRY_FOR_CAPABILITY_DERIVATION = createToolRegistry();

export interface ResolveBrokerToolContextInput {
  db: Db;
  companyId: string;
  agentId: string;
  runId: string;
}

/**
 * Best-effort lookup of the source-Discussion autonomy override for an ORG
 * heartbeat run, reproducing the stdio path's query chain (`heartbeat.ts`
 * ~4572-4593): `heartbeat_runs.context_snapshot.issueId` -> `issues.
 * source_discussion_id` -> `discussions.autonomy_level`. Every hop is
 * company-scoped (mirrors the stdio path's `eq(discussions.companyId, ...)`
 * guard) so a run can never read another tenant's discussion dial.
 *
 * Returns `undefined` (== "no override, fall back to the company dial") when
 * any hop is missing OR the lookup itself fails — this is enrichment for a
 * more accurate `effectiveAutonomy`, not a security boundary, so a DB hiccup
 * here must never fail the whole broker request.
 */
async function resolveOrgDiscussionAutonomyOverride(
  db: Db,
  companyId: string,
  runId: string,
): Promise<number | null | undefined> {
  try {
    const [runRow] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)))
      .limit(1);
    const contextSnapshot = (runRow?.contextSnapshot ?? {}) as Record<string, unknown>;
    const issueId = typeof contextSnapshot.issueId === "string" && contextSnapshot.issueId.trim()
      ? contextSnapshot.issueId
      : null;
    if (!issueId) return undefined;

    const [issueRow] = await db
      .select({ sourceDiscussionId: issues.sourceDiscussionId })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .limit(1);
    if (!issueRow?.sourceDiscussionId) return undefined;

    const [discussionRow] = await db
      .select({ autonomyLevel: discussions.autonomyLevel })
      .from(discussions)
      .where(and(eq(discussions.id, issueRow.sourceDiscussionId), eq(discussions.companyId, companyId)))
      .limit(1);
    return discussionRow?.autonomyLevel;
  } catch (err) {
    logger.warn(
      { err, companyId, runId },
      "[broker-tool-context] failed to resolve source-Discussion autonomy override for an org run — falling back to the company dial",
    );
    return undefined;
  }
}

/**
 * Build the internal-agent `ToolContext` for a sandboxed (E2B) agent run.
 *
 * - Loads the `agents` row for `agentId` and asserts `agent.companyId ===
 *   companyId`. A missing agent and a cross-tenant agent are treated
 *   identically (fail closed, 403) so the error never leaks whether the
 *   agent exists under a different company — mirrors the
 *   `CROSS_COMPANY_FORBIDDEN` convention in `tools/agent-dispatch.ts` and the
 *   cross-tenant backstop already in `aoa-agents/runner.ts` (`agent.companyId
 *   !== payload.companyId`).
 * - Branches on `agentRow.kind` — the broker serves exactly the two run
 *   kinds that ever execute over it (Wave 1 review, FIX A):
 *     - `"aoa"` (crew): UNCHANGED from before this fix. `toolAllowlist` +
 *       `enabledCapabilities` reuse the EXACT derivation `runAoaAgent`
 *       (`aoa-agents/runner.ts`) feeds into `buildMcpBridgeSpec`:
 *       `toolAllowlist` comes straight off `agent.runtimeConfig.aoa.
 *       toolAllowlist` (the per-agent allowlist seeded by the `ensure-*`
 *       crew-role files), and `deriveEnabledCapabilities`
 *       (`aoa-agents/derive-capabilities.ts`) turns that allowlist into the
 *       coarse capability set against the SAME tool registry the crew path
 *       uses. `userRole` is the founder-session placeholder
 *       (`SUBAGENT_SESSION_USER_ROLE` in `runner.ts`, re-declared here as
 *       `CREW_SESSION_USER_ROLE`). `effectiveAutonomy` reads
 *       `internal_agent_config.crewAutonomyLevel` directly, falling back to
 *       `0` (Manual) — matching the same `?? 0` fallback used by
 *       `dispatcher.ts` / `controller-adjutant-runner.ts`.
 *     - `"org"`: reproduces the ORG heartbeat stdio path's authz
 *       (`heartbeat.ts` `heartbeatMcpParams`, ~4595-4612) instead of the crew
 *       derivation above — an org agent has no `runtimeConfig.aoa`, so
 *       running it through the crew branch would silently allowlist zero
 *       tools. `userRole:"team_member"` (never founder), `toolAllowlist` =
 *       the imported `ORG_HEARTBEAT_TOOL_ALLOWLIST`, `enabledCapabilities` =
 *       the imported `ORG_HEARTBEAT_ENABLED_CAPABILITIES`, and
 *       `effectiveAutonomy` via the SAME `resolveHeartbeatEffectiveAutonomy`
 *       helper the stdio path calls, fed the company dial
 *       (`crewAutonomyLevel`) plus the source-Discussion override resolved
 *       by `resolveOrgDiscussionAutonomyOverride` above (best-effort; a
 *       missing/failed lookup just falls back to the company dial, same as
 *       the stdio path's `?? 0` chain when there's no source Discussion).
 *     - any other kind (e.g. `"platform"`, which never dispatches through
 *       heartbeat or the crew runner — see `aoa-heartbeat-kind-guard.test.ts`)
 *       — throws `forbidden(...)`, failing closed. This also closes a second
 *       hole: `authorize-tool.ts`'s allowlist gate only activates for
 *       `agentKind` `"aoa"`/`"org"`, so any other kind previously reached
 *       tool dispatch with NO allowlist check at all.
 * - `resolveCrewRole` (`resolve-crew-role.ts`) is a DIFFERENT helper — it
 *   resolves a trigger's `config.role` for the autonomy min-role gate
 *   (`autonomy.ts` ROLE_MIN_AUTONOMY) and plays no part in allowlist/
 *   capability derivation for either branch, so it is not used here.
 * - Sets `actorType:"agent"` (never `"commander"`) and leaves
 *   `commanderToolPermissions` / `runtimeApprovalsEnabled` unset —
 *   `mcp-bridge.ts` gates those fields exclusively on
 *   `actorType==="commander"`, and a broker-resolved context always
 *   represents a crew/org agent run.
 */
export async function resolveBrokerToolContext(
  input: ResolveBrokerToolContextInput,
): Promise<ToolContext> {
  const { db, companyId, agentId, runId } = input;

  const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agentRow || agentRow.companyId !== companyId) {
    throw forbidden("Broker run identity does not match the requesting company");
  }

  if (agentRow.kind !== "aoa" && agentRow.kind !== "org") {
    // Fail closed: the broker only serves crew ('aoa') and org runs. Any
    // other kind (platform, or a future kind this resolver hasn't been
    // taught about) never legitimately reaches the broker, and letting it
    // through would skip authorize-tool.ts's allowlist gate entirely (that
    // gate only checks agentKind "aoa"/"org" — see the doc comment above).
    throw forbidden(`Broker does not serve agent kind '${agentRow.kind}'`);
  }

  const [configRow] = await db
    .select({ crewAutonomyLevel: internalAgentConfig.crewAutonomyLevel })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId))
    .limit(1);
  const companyAutonomyLevel = configRow?.crewAutonomyLevel ?? 0;

  if (agentRow.kind === "org") {
    const discussionAutonomyLevel = await resolveOrgDiscussionAutonomyOverride(db, companyId, runId);
    const effectiveAutonomy = resolveHeartbeatEffectiveAutonomy({
      companyAutonomyLevel,
      discussionAutonomyLevel,
    });

    return {
      companyId,
      userId: BROKER_SESSION_USER_ID,
      userRole: ORG_SESSION_USER_ROLE,
      enabledCapabilities: [...ORG_HEARTBEAT_ENABLED_CAPABILITIES],
      agentKind: "org",
      toolAllowlist: [...ORG_HEARTBEAT_TOOL_ALLOWLIST],
      actorType: "agent",
      agentId,
      effectiveAutonomy,
      runId,
      db,
      services: createServiceContainer(db),
    };
  }

  // agentRow.kind === "aoa" (crew) — unchanged from before this fix.
  const runtimeConfig = (agentRow.runtimeConfig ?? {}) as Record<string, unknown>;
  const aoaConfig = (runtimeConfig.aoa ?? {}) as Record<string, unknown>;
  const toolAllowlist = Array.isArray(aoaConfig.toolAllowlist)
    ? (aoaConfig.toolAllowlist as string[])
    : [];
  const enabledCapabilities = deriveEnabledCapabilities(
    toolAllowlist,
    TOOL_REGISTRY_FOR_CAPABILITY_DERIVATION,
  );

  return {
    companyId,
    userId: BROKER_SESSION_USER_ID,
    userRole: CREW_SESSION_USER_ROLE,
    enabledCapabilities,
    agentKind: "aoa",
    toolAllowlist,
    actorType: "agent",
    agentId,
    effectiveAutonomy: companyAutonomyLevel,
    runId,
    db,
    services: createServiceContainer(db),
  };
}

export interface ResolveCommanderBrokerToolContextInput {
  db: Db;
  companyId: string;
  userId: string;
  userRole: string;
  conversationId: string;
}

/**
 * Build the internal-agent `ToolContext` for a sandboxed COMMANDER turn from a
 * verified Commander run-JWT (W7.5a / SC3). Distinct from
 * `resolveBrokerToolContext`: Commander has NO agents row, so there is NO
 * agents-row lookup and NO `kind ∈ {aoa,org}` gate. It returns the SAME shape
 * the in-process stdio bridge builds for `actorType:"commander"`
 * (`mcp-bridge.ts:357-377`): full tool surface (no allowlist gate — `agentKind`
 * is undefined, so `authorizeToolInvocation`'s allowlist gate does not fire),
 * commander policy fields read from `internal_agent_config`.
 *
 * Company scope is enforced by the caller (`mcp/server.ts` asserts
 * `jwt.company_id === :companyId` via `assertCompanyAccess`'s commander branch
 * before dispatching here) — this resolver trusts the `companyId` it is given.
 */
export async function resolveCommanderBrokerToolContext(
  input: ResolveCommanderBrokerToolContextInput,
): Promise<ToolContext> {
  const { db, companyId, userId, userRole, conversationId } = input;

  const [config] = await db
    .select({
      enabledCapabilities: internalAgentConfig.enabledCapabilities,
      commanderToolPermissions: internalAgentConfig.commanderToolPermissions,
      runtimeApprovalsEnabled: internalAgentConfig.runtimeApprovalsEnabled,
    })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId))
    .limit(1);

  return {
    companyId,
    userId,
    userRole,
    enabledCapabilities: (config?.enabledCapabilities as string[] | null) ?? [],
    agentKind: undefined,
    toolAllowlist: [],
    actorType: "commander",
    conversationId,
    commanderToolPermissions:
      (config?.commanderToolPermissions as CommanderToolPermissions | null | undefined) ?? null,
    runtimeApprovalsEnabled: config?.runtimeApprovalsEnabled ?? true,
    db,
    services: createServiceContainer(db),
  };
}
