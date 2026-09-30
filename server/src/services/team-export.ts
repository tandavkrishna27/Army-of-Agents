import type { Db } from "@armyofagents/db";
import { teams, teamMembers, agents } from "@armyofagents/db";
import { eq, inArray } from "drizzle-orm";
import { stringify as stringifyYaml } from "yaml";
import { TeamManifestSchema, type TeamManifest } from "@armyofagents/shared";
import { notFound } from "../errors.js";

/**
 * Slice 9 / Task 9.1: Team export service.
 *
 * Reconstructs a `TeamManifest` from the persisted DB rows and serializes
 * it back to YAML so a founder can download a `.team.yaml` file. The
 * output is import-compatible — round-tripping a team through
 * export → import to a second company yields an equivalent team. (Note:
 * agent UUIDs differ across companies; everything else is equivalent.)
 *
 * Routing rules, skill deps, and plugin deps live on the persisted
 * `team.manifest` blob (the import path put them there) and are
 * round-tripped faithfully so downstream consumers don't lose data.
 */
export function teamExportService(db: Db) {
  return {
    /**
     * Reconstruct the manifest from DB state and serialize to YAML.
     * Throws notFound if the team doesn't exist.
     */
    exportYaml: async (teamId: string): Promise<string> => {
      const teamRows = await db
        .select()
        .from(teams)
        .where(eq(teams.id, teamId));
      if (teamRows.length === 0) {
        throw notFound(`team ${teamId} not found`);
      }
      const team = teamRows[0];

      const memberRows = await db
        .select()
        .from(teamMembers)
        .where(eq(teamMembers.teamId, teamId));

      const agentRows =
        memberRows.length > 0
          ? await db
              .select()
              .from(agents)
              .where(
                inArray(
                  agents.id,
                  memberRows.map((m) => m.agentId),
                ),
              )
          : [];
      const agentById = new Map(agentRows.map((a) => [a.id, a]));

      // P1-5: spread the full persisted manifest so any fields the schema
      // defines (or future-defines) are preserved. Previously this method
      // only rehydrated routing/skillDeps/pluginDeps, silently dropping
      // workflowTemplates and memoryItems on export → re-import lost data.
      // Order matters: spread first, then override the fields we always
      // recompute (schemaVersion, name/slug, displayName, agents).
      const stored = (team.manifest as Partial<TeamManifest>) ?? {};

      const manifest: TeamManifest = {
        ...stored,
        schemaVersion: 1, // always force to current schema
        name: team.slug, // canonical slug from the DB row
        version: team.templateVersion ?? stored.version ?? "1.0.0",
        displayName: team.name,
        // P2-H: TeamManifestSchema.description is `.optional()` (not
        // `.nullable()`), so a residual `null` from the DB column would crash
        // `.parse()` below. Coalesce both sources, then coerce a trailing
        // `null` to `undefined`. `??` only descends on null-or-undefined, so
        // `null ?? undefined === undefined`.
        description: team.description ?? stored.description ?? undefined,
        agents: memberRows.map((m) => {
          const a = agentById.get(m.agentId);
          return {
            name: a?.name ?? `agent-${m.agentId.slice(0, 8)}`,
            role: m.role as "lead" | "member",
            skillKeys: (a?.skillKeys as string[] | undefined) ?? [],
          };
        }),
        routing: stored.routing ?? { rules: [] },
      };

      // Validate the assembled shape before serializing. `.parse` (not
      // `.safeParse`) — we want a loud failure if the persisted manifest
      // is missing fields a future schema makes mandatory.
      const validated = TeamManifestSchema.parse(manifest);

      return stringifyYaml(validated);
    },
  };
}
