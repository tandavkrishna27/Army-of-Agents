import type { AgentTool, ToolResult } from "../types.js";
import { COMMANDER_SKILL_PREAMBLE } from "../commander-preamble.js";

// Curated↔runtime key normalization: skill frontmatter is authored as
// "skill:aoa-curated/aoa-<name>" but the runtime seeder installs the
// company's copy as "skill:aoa/<name>", and in-skill handoffs may reference
// either form. Compute the alternate form (in either direction) so a
// reference in one form still resolves a skill stored under the other.
function alternateSkillKey(prefixedKey: string): string | null {
  const curatedMatch = prefixedKey.match(/^skill:aoa-curated\/aoa-(.+)$/);
  if (curatedMatch) return `skill:aoa/${curatedMatch[1]}`;
  const runtimeMatch = prefixedKey.match(/^skill:aoa\/(.+)$/);
  if (runtimeMatch) return `skill:aoa-curated/aoa-${runtimeMatch[1]}`;
  return null;
}

export const useSkillTool: AgentTool = {
  name: "use_skill",
  description:
    "Load a skill's full instructions into context. Call this before applying any skill. The skill content will be available for the rest of this conversation.",
  parameters: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "The skill key from the Available Skills list",
      },
    },
    required: ["key"],
  },
  category: "query",
  requiredRole: "team_member",
  requiresConfirmation: false,
  execute: async (params: unknown, ctx): Promise<ToolResult> => {
    const { key } = (params ?? {}) as { key?: unknown };
    if (!key || typeof key !== "string") {
      return {
        success: false,
        data: null,
        summary: "key is required",
        error: "INVALID_PARAMS",
      };
    }

    try {
      const { companySkills, agents, internalAgentConfig } = await import("@armyofagents/db");
      const { and, eq } = await import("drizzle-orm");

      // Flexible resolution: the model sometimes drops the "skill:" prefix or
      // passes the slug/name. Resolve to the canonical company skill.
      const all = await ctx.db
        .select({
          key: companySkills.key,
          slug: companySkills.slug,
          name: companySkills.name,
          description: companySkills.description,
          markdown: companySkills.markdown,
        })
        .from(companySkills)
        .where(eq(companySkills.companyId, ctx.companyId));

      const want = key.toLowerCase();
      const wantPrefixed = want.startsWith("skill:") ? want : `skill:${want}`;
      const altPrefixed = alternateSkillKey(wantPrefixed);
      const skill =
        all.find((s) => s.key.toLowerCase() === want) ??
        all.find((s) => s.key.toLowerCase() === wantPrefixed) ??
        (altPrefixed ? all.find((s) => s.key.toLowerCase() === altPrefixed) : undefined) ??
        all.find((s) => {
          const k = s.key.toLowerCase();
          return k.endsWith(`/${want}`) || k.endsWith(`:${want}`);
        }) ??
        all.find((s) => (s.slug ?? "").toLowerCase() === want) ??
        all.find((s) => (s.name ?? "").toLowerCase() === want) ??
        null;

      if (!skill) {
        return {
          success: false,
          data: null,
          summary: `Skill '${key}' not found. Check the Available Skills list for valid keys.`,
          error: "NOT_FOUND",
        };
      }

      // Curated-source-of-truth enforcement (Decision D8): an agent may only use
      // skills deliberately attached to it (agents.skillKeys). The skill LIBRARY
      // is open (D7) — a founder can install from any GitHub repo — so this
      // per-agent allowlist is the ONLY thing standing between a crew agent and
      // an arbitrarily-sourced skill. It must be enforced for BOTH callers:
      //
      //   • Commander (actorType "commander"): the bridge sets no agent id, so
      //     resolve the Commander agent from companyId via
      //     internalAgentConfig.agentId. That row is ALREADY company-scoped, so
      //     the agents lookup needs no companyId conjunct (unchanged behaviour).
      //
      //   • Crew  (actorType "agent" + agentKind "aoa" + ctx.agentId): the agent
      //     id comes from AOA_AGENT_ID in the bridge subprocess — an env value —
      //     so the agents lookup MUST company-scope (and(id, companyId)). Without
      //     it, a crew run could resolve another company's agent (and thus its
      //     skillKeys allowlist). A cross-company / missing agent yields an empty
      //     allowlist → NOT_ENABLED, never a skill leak.
      //
      // Other actors (board, org) are intentionally NOT gated here (out of scope
      // for this task). The shared allowlist check below is factored out so the
      // two paths can only differ in HOW they resolve/scope the agent, never in
      // the allow/deny decision itself.
      let scopedAgentId: string | null = null;
      let enforcementSurface: "commander" | "crew" | null = null;

      if (ctx.actorType === "commander") {
        const [cfg] = await ctx.db
          .select({ agentId: internalAgentConfig.agentId })
          .from(internalAgentConfig)
          .where(eq(internalAgentConfig.companyId, ctx.companyId))
          .limit(1);
        scopedAgentId = cfg?.agentId ?? null;
        enforcementSurface = "commander";
      } else if (ctx.actorType === "agent" && ctx.agentKind === "aoa") {
        // Key on kind ALONE (mirrors authorize-tool.ts:67, which gates the
        // runtime allowlist on agentKind so a misconfigured identity fails
        // closed rather than falling through). agentId may be null/empty here —
        // handled by the fail-closed guard below.
        scopedAgentId = ctx.agentId ?? null;
        enforcementSurface = "crew";
      }

      // Crew identity is mandatory. A missing/empty agentId is an env/caller
      // defect, never a legitimate crew run (a crew run is definitionally an
      // agent executing as itself), so fail closed rather than fall through to
      // the unconditional allow. `!scopedAgentId` also catches "".
      if (enforcementSurface === "crew" && !scopedAgentId) {
        return {
          success: false,
          data: null,
          summary: `Skill '${skill.key}' is not enabled: crew agent identity could not be verified.`,
          error: "NOT_ENABLED",
        };
      }

      if (enforcementSurface && scopedAgentId) {
        // Company-scope the lookup ONLY for crew (its agentId is an untrusted
        // env value). Commander's agentId is transitively company-scoped via the
        // internalAgentConfig row above, so its WHERE stays a single eq — byte-
        // compatible with the prior behaviour.
        const where =
          enforcementSurface === "crew"
            ? and(eq(agents.id, scopedAgentId), eq(agents.companyId, ctx.companyId))
            : eq(agents.id, scopedAgentId);
        const [agent] = await ctx.db
          .select({ skillKeys: agents.skillKeys })
          .from(agents)
          .where(where)
          .limit(1);
        // Observability (no behaviour change): for crew, a row that fails to
        // resolve UNDER COMPANY SCOPE is a strong env-corruption / cross-tenant
        // signal — distinct from a resolved agent that simply lacks the skill.
        // Surface it so the two collapse-to-`allowed=[]` cases are separable.
        if (enforcementSurface === "crew" && !agent) {
          console.warn(
            `use_skill: crew agent '${scopedAgentId}' did not resolve under company scope ` +
              `(companyId='${ctx.companyId}') — denying skill '${skill.key}'. ` +
              `Possible env corruption or cross-tenant identity.`,
          );
        }
        const allowed: string[] = Array.isArray(agent?.skillKeys) ? agent.skillKeys : [];
        if (!allowed.includes(skill.key)) {
          return enforcementSurface === "commander"
            ? {
                success: false,
                data: null,
                summary: `Skill '${skill.key}' is not enabled for Commander. Enable it in Settings → Commander → Skills.`,
                error: "NOT_ENABLED",
              }
            : {
                success: false,
                data: null,
                summary: `Skill '${skill.key}' is not enabled for this agent. Ask the founder to attach it on the agent's Skills tab (Agent → Skills).`,
                error: "NOT_ENABLED",
              };
        }
      }

      return {
        success: true,
        data: {
          key: skill.key,
          name: skill.name,
          content: `${COMMANDER_SKILL_PREAMBLE}\n\n---\n\n${skill.markdown}`,
        },
        summary: `Loaded skill: ${skill.name}. Follow the instructions in 'content' for the rest of this conversation.`,
      };
    } catch (err: any) {
      return {
        success: false,
        data: null,
        summary: err?.message ?? "Failed to load skill",
        error: "INTERNAL",
      };
    }
  },
};
