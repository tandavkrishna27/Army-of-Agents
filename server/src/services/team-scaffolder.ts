import type { Db } from "@armyofagents/db";
import { teams, teamMembers, agents } from "@armyofagents/db";
import { eq, inArray } from "drizzle-orm";

/**
 * Slice 3 / Task 3.3: Team coordination scaffolder.
 *
 * Two responsibilities:
 *  - `scaffoldInitial(teamId, description?)` — generate the full
 *    initial coordination.md for a brand-new team (Mission, Scope,
 *    auto:members, auto:routing, Escalation, Edge cases).
 *  - `regenerateAutoContent(teamId)` — return just the `auto:*` section
 *    contents as `Record<sectionName, content>` so callers can hand the
 *    map straight to `teamCoordinationService.regenerateAutoSections`.
 *
 * v1: deterministic templates. Future: LLM-generated.
 */
export function teamScaffolderService(db: Db) {
  return {
    /**
     * Generate the full initial coordination.md for a brand-new team.
     */
    scaffoldInitial: async (teamId: string, description?: string): Promise<string> => {
      const teamRows = await db.select().from(teams).where(eq(teams.id, teamId));
      if (teamRows.length === 0) throw new Error(`team ${teamId} not found`);
      const team = teamRows[0];

      const memberRows = await db
        .select()
        .from(teamMembers)
        .where(eq(teamMembers.teamId, teamId));

      const agentIds = memberRows.map((m) => m.agentId);
      const agentRows =
        agentIds.length > 0
          ? await db.select().from(agents).where(inArray(agents.id, agentIds))
          : [];
      const byId = new Map(agentRows.map((a) => [a.id, a]));

      const lines: string[] = [];
      lines.push("## Mission");
      lines.push(description ?? `${team.name} handles work assigned to it.`);
      lines.push("");
      lines.push("## Scope");
      lines.push("### What we handle");
      lines.push("- _(describe what this team is responsible for)_");
      lines.push("");
      lines.push("### What we don't handle");
      lines.push("- _(out-of-scope topics; route those elsewhere)_");
      lines.push("");

      // Auto sections
      // ASCII-only output — postgres clusters initialized with WIN1252 (Windows
      // default) reject non-Latin-1 characters in INSERT/UPDATE. Use ASCII
      // separators (`-`, `--`, `->`) to keep the scaffolder portable across
      // cluster encodings without requiring a re-initdb.
      lines.push("<!-- begin:auto:members -->");
      lines.push("## Members");
      for (const m of memberRows) {
        const a = byId.get(m.agentId);
        const skills = (a?.skillKeys as string[] | undefined)?.join(", ") ?? "-";
        const roleLabel = m.role === "lead" ? "[LEAD]" : "[MEMBER]";
        lines.push(`- **${a?.name ?? m.agentId}** ${roleLabel} -- ${skills}`);
      }
      lines.push("<!-- end:auto:members -->");
      lines.push("");

      lines.push("<!-- begin:auto:routing -->");
      lines.push("## Routing");
      const lead = memberRows.find((m) => m.role === "lead");
      const leadAgent = lead ? byId.get(lead.agentId) : undefined;
      lines.push(`- default -> @${leadAgent?.name ?? "lead"} (lead)`);
      lines.push("<!-- end:auto:routing -->");
      lines.push("");

      lines.push("## Escalation");
      lines.push("_(when to escalate, who to)_");
      lines.push("");
      lines.push("## Edge cases");
      lines.push("_(special handling rules)_");

      return lines.join("\n");
    },

    /**
     * Regenerate just the auto sections for an existing coordination.md.
     * Returns a Record<sectionName, content> ready for replaceAutoSection.
     */
    regenerateAutoContent: async (teamId: string): Promise<Record<string, string>> => {
      const teamRows = await db.select().from(teams).where(eq(teams.id, teamId));
      const team = teamRows[0];
      if (!team) throw new Error(`team ${teamId} not found`);

      const memberRows = await db
        .select()
        .from(teamMembers)
        .where(eq(teamMembers.teamId, teamId));
      const agentRows =
        memberRows.length > 0
          ? await db
              .select()
              .from(agents)
              .where(inArray(agents.id, memberRows.map((m) => m.agentId)))
          : [];
      const byId = new Map(agentRows.map((a) => [a.id, a]));

      // ASCII-only output (see scaffoldInitial above for rationale).
      const memberLines: string[] = ["## Members"];
      for (const m of memberRows) {
        const a = byId.get(m.agentId);
        const skills = (a?.skillKeys as string[] | undefined)?.join(", ") ?? "-";
        memberLines.push(`- **${a?.name ?? m.agentId}** [${m.role.toUpperCase()}] -- ${skills}`);
      }

      const routingLines: string[] = ["## Routing"];
      const manifestRouting = (team.manifest as {
        routing?: { rules?: Array<{ match: string; mention: string }> };
      })?.routing;
      for (const rule of manifestRouting?.rules ?? []) {
        routingLines.push(`- pattern \`${rule.match}\` -> ${rule.mention}`);
      }
      const lead = memberRows.find((m) => m.role === "lead");
      const leadName = lead ? byId.get(lead.agentId)?.name : undefined;
      routingLines.push(`- default -> @${leadName ?? "lead"} (lead)`);

      return {
        members: memberLines.join("\n"),
        routing: routingLines.join("\n"),
      };
    },
  };
}
