import type { Db } from "@armyofagents/db";
import {
  agents,
  companySkills,
  teams,
  teamMembers,
  teamCoordinations,
  agentProjects,
  projects,
} from "@armyofagents/db";
import { and, eq, inArray } from "drizzle-orm";
import { parseManifest } from "./team-manifest.js";
import { teamScaffolderService } from "./team-scaffolder.js";
import { insertTeamWithUniqueSlug } from "./teams.js";
import type { TeamManifest } from "@armyofagents/shared";
import { badRequest } from "../errors.js";

/**
 * Slice 8 / Tasks 8.1 + 8.2: Team import service.
 *
 * `preview(companyId, yamlContent)` parses the YAML manifest, detects
 * agent-name collisions against the company's existing agents, and lists
 * skills/plugins/workflows that aren't yet installed.
 *
 * `install(companyId, yamlContent, resolution)` runs the transactional
 * cascade: creates agents (respecting collision resolution), inserts the
 * team row, links members via `team_members`, and scaffolds the initial
 * `team_coordinations` row. v1 refuses installs that require not-yet-
 * installed skills (no marketplace fetch yet).
 */
export interface ImportPreview {
  manifest: TeamManifest;
  collisions: Array<{ kind: "agent" | "team"; name: string; existingId: string }>;
  skillsToInstall: string[];
  pluginsToInstall: string[];
  workflowsToInstall: string[];
}

export interface ImportResolution {
  /** Per-collision strategy, keyed by the colliding entity name. */
  collisions: Record<string, "rename" | "replace" | "skip">;
  parentProjectId: string;
  /** Original name → new name, when the strategy is "rename". */
  renames?: Record<string, string>;
}

export function teamImportService(db: Db) {
  return {
    /**
     * Parse + validate the manifest, then probe the DB for existing-agent
     * collisions and missing skills. Read-only — no writes.
     *
     * Throws on malformed YAML or schema-invalid manifest.
     *
     * Note: `parseManifest` already invokes `validateManifest` internally,
     * so regex/schema invariants are checked at parse time.
     */
    preview: async (
      companyId: string,
      yamlContent: string,
    ): Promise<ImportPreview> => {
      const manifest = parseManifest(yamlContent);

      // Collect agent names from BOTH inline and $ref forms:
      // - Inline agents have `name`
      // - $ref agents have `localName`
      const allNames: string[] = [];
      for (const a of manifest.agents) {
        if ("name" in a) allNames.push(a.name);
        else if ("localName" in a) allNames.push(a.localName);
      }

      // P2: reject manifests that declare two agents with the same name. The
      // install path resolves names → agentIds via `agentIdByLocalName`,
      // which silently overwrites duplicates and leaves the second agent
      // unlinked. Catch the bad input here so the founder sees a clean 400
      // before any DB lookups run.
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      for (const name of allNames) {
        if (seen.has(name)) duplicates.add(name);
        seen.add(name);
      }
      if (duplicates.size > 0) {
        throw badRequest(
          `manifest has duplicate agent names: ${[...duplicates].join(", ")}`,
        );
      }

      // Find collisions: agents in this company that already use one of these names.
      const existingAgents = allNames.length > 0
        ? await db
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(
              and(
                eq(agents.companyId, companyId),
                inArray(agents.name, allNames),
              ),
            )
        : [];

      const collisions: ImportPreview["collisions"] = existingAgents.map(
        (a: { id: string; name: string }) => ({
          kind: "agent" as const,
          name: a.name,
          existingId: a.id,
        }),
      );

      // Skills to install: declared in manifest.skillDeps but not yet on the company.
      // Filter at SQL layer (not in JS) so we don't ship a full company-skills table
      // over the wire just to compute a small set difference.
      const declaredSkills = manifest.skillDeps ?? [];
      const installedSkills = declaredSkills.length > 0
        ? await db
            .select({ key: companySkills.key })
            .from(companySkills)
            .where(
              and(
                eq(companySkills.companyId, companyId),
                inArray(companySkills.key, declaredSkills),
              ),
            )
        : [];
      const installedSet = new Set(
        installedSkills.map((s: { key: string }) => s.key),
      );
      const skillsToInstall = declaredSkills.filter(
        (s) => !installedSet.has(s),
      );

      // Plugins / workflows: simplified for v1 — assume not installed.
      // Task 8.2 may refine this once it has the install pipeline wired up.
      const pluginsToInstall = manifest.pluginDeps ?? [];
      const workflowsToInstall = (manifest.workflowTemplates ?? []).map(
        (w) => w.$ref,
      );

      return {
        manifest,
        collisions,
        skillsToInstall,
        pluginsToInstall,
        workflowsToInstall,
      };
    },

    /**
     * Transactional cascade install. Runs `preview()` first to surface
     * collisions + missing skills, then validates the import is safe
     * (no missing skills, ≤1 lead, no slug collision) BEFORE entering the
     * transaction so users get clean error messages instead of cryptic
     * Postgres unique-constraint violations.
     *
     * Inside the transaction:
     *  1. For each manifest agent: skip / reuse-on-replace / create-on-rename-or-new.
     *     Newly-created agents are immediately linked to the parent dept via
     *     `agent_projects` — this is required for the team_members insert to
     *     satisfy the dept-membership invariant enforced by `addMember`.
     *  2. Insert the `teams` row (slug = manifest.name; templateOrigin/Version
     *     populated from the manifest so a future re-import can detect drift).
     *  3. Insert `team_members` rows linking each non-skipped agent to the team.
     *     The partial unique index `team_members_one_lead_uq` is the backstop
     *     for the lead-count check.
     *  4. Scaffold the initial `team_coordinations` row using the existing
     *     scaffolder service — keeps content generation in one place.
     *
     * Returns the inserted team's id/slug/name/parentProjectId so the route
     * handler can issue a redirect.
     */
    install: async (
      companyId: string,
      yamlContent: string,
      resolution: ImportResolution,
    ): Promise<{
      id: string;
      slug: string;
      name: string;
      parentProjectId: string;
      /**
       * Task 11 / P3-D: non-fatal side effects worth surfacing to the
       * founder. The 'replace' resolution branch silently grants the
       * existing agent dept membership when they aren't already in the
       * parent dept -- the founder doesn't expect that, so we collect
       * the change here and the route relays it to the UI as a toast.
       *
       * Always present (empty array on the no-side-effects path) so
       * downstream callers don't have to null-check.
       */
      warnings: string[];
    }> => {
      const preview = await teamImportService(db).preview(
        companyId,
        yamlContent,
      );
      const { manifest } = preview;

      // Task 11 / P3-D: collected as we walk the agent resolution loop
      // inside the transaction. Returned alongside the team metadata so
      // the route can echo it back on the response body.
      const warnings: string[] = [];

      // ===== Pre-transaction validations =====

      // Refuse installs that need skills not on the company. v1 has no
      // marketplace fetch — founder must install dependencies separately first.
      // Throws via badRequest so the global error handler returns 400 with the
      // actionable message (plain `new Error` would map to a generic 500).
      if (preview.skillsToInstall.length > 0) {
        throw badRequest(
          `manifest requires skills not installed in this company: ${preview.skillsToInstall.join(", ")}. Install them first via the Skills tab.`,
        );
      }

      // Refuse manifests with >1 lead. The partial unique index would catch
      // this as a 23505 inside the transaction, but we lift it to a clean
      // pre-flight error so the founder sees a useful message.
      const leadAgents = manifest.agents.filter((a) => a.role === "lead");
      if (leadAgents.length > 1) {
        throw badRequest(
          `manifest has ${leadAgents.length} agents with role 'lead' — at most one lead per team is allowed`,
        );
      }

      // Same idea for the slug uniqueness constraint. TOCTOU window is
      // acceptable for v1 (the unique index catches the race).
      const existingTeam = await db
        .select({ id: teams.id })
        .from(teams)
        .where(
          and(
            eq(teams.companyId, companyId),
            eq(teams.slug, manifest.name),
          ),
        );
      if (existingTeam.length > 0) {
        throw badRequest(
          `a team with slug "${manifest.name}" already exists in this company`,
        );
      }

      // P1: Cross-tenant guard — verify the parent project from the import
      // resolution belongs to the caller's company before entering the
      // transactional cascade. The FK only enforces `projects.id` existence,
      // not company-tenancy.
      const projectCheck = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.id, resolution.parentProjectId),
            eq(projects.companyId, companyId),
          ),
        );
      if (projectCheck.length === 0) {
        throw badRequest(
          `parent project ${resolution.parentProjectId} not found in company ${companyId}`,
        );
      }

      // ===== Transactional cascade =====

      return db.transaction(async (tx) => {
        // Step 1: resolve agents (skip / reuse / create)
        const agentIdByLocalName = new Map<string, string>();

        for (const a of manifest.agents) {
          const isInline = "name" in a;
          const wantedName = isInline ? a.name : a.localName;
          const action = resolution.collisions[wantedName];

          if (action === "skip") continue;

          if (action === "replace") {
            const collision = preview.collisions.find(
              (c) => c.name === wantedName,
            );
            if (!collision) {
              throw new Error(
                `resolution says "replace" for ${wantedName} but no collision was found`,
              );
            }
            // Ensure the reused agent is in the parent dept. If not, link
            // it now — same invariant as creating a fresh agent below.
            const deptCheck = await tx
              .select()
              .from(agentProjects)
              .where(
                and(
                  eq(agentProjects.agentId, collision.existingId),
                  eq(agentProjects.projectId, resolution.parentProjectId),
                ),
              );
            if (deptCheck.length === 0) {
              await tx.insert(agentProjects).values({
                agentId: collision.existingId,
                projectId: resolution.parentProjectId,
                companyId,
              });
              // Task 11 / P3-D: 'replace' on a cross-dept agent silently
              // expands their dept membership. The founder picked
              // 'replace' expecting in-place reuse; this is a side
              // effect they should see. Non-fatal -- the install still
              // completes, but the warning lands as a toast in the UI.
              warnings.push(
                `Agent "${wantedName}" (existing, id=${collision.existingId}) was not previously a member of department ${resolution.parentProjectId}. The 'replace' action added them to this department.`,
              );
            }
            agentIdByLocalName.set(wantedName, collision.existingId);
            continue;
          }

          // No collision OR action === "rename" → create a fresh agent.
          let agentName = wantedName;
          if (action === "rename") {
            agentName =
              resolution.renames?.[wantedName] ?? `${wantedName}-imported`;
          }

          // Inline agents bring their own `skillKeys`. $ref agents pull from a
          // registry (out of scope for v1); we default to an empty list and
          // let the founder fix up the agent later.
          const skillKeys = isInline ? (a.skillKeys ?? []) : [];

          const inserted = await tx
            .insert(agents)
            .values({
              companyId,
              name: agentName,
              role: "general",
              skillKeys,
              // claude_local matches the most common founder default. Schema
              // default ("process") is also valid; we pick claude_local here
              // so imported agents are usable on a fresh install without
              // adapter reconfiguration.
              adapterType: "claude_local",
              status: "idle",
            })
            .returning();

          const newAgentId = inserted[0].id;
          agentIdByLocalName.set(wantedName, newAgentId);

          // Link the new agent to the parent dept BEFORE we try to insert
          // into team_members below — that insert mirrors `addMember`'s
          // invariant requiring agent ∈ dept.
          await tx.insert(agentProjects).values({
            agentId: newAgentId,
            projectId: resolution.parentProjectId,
            companyId,
          });
        }

        // Step 2: insert the team row.
        //
        // P1-C: the pre-flight slug-existence probe above narrows the
        // window where a concurrent install of the same manifest could
        // win the slug, but it does not eliminate it. The shared helper
        // retries up to 5 times on 23505 against `teams_company_slug_uq`,
        // and throws conflict() if the slug space is saturated.
        //
        // `slugBase` is the manifest's `name` (already a slug per the
        // manifest validator) — that preserves the original behavior
        // where the row's slug came directly from `manifest.name` rather
        // than slugifying the displayName.
        const team = await insertTeamWithUniqueSlug(
          tx,
          {
            companyId,
            parentProjectId: resolution.parentProjectId,
            name: manifest.displayName ?? manifest.name,
            description: manifest.description ?? null,
            manifest,
            templateOrigin: `@${manifest.name}`,
            templateVersion: manifest.version,
          },
          { slugBase: manifest.name },
        );

        // Step 3: link agents to the team via team_members.
        // Skipped agents have no entry in `agentIdByLocalName`.
        for (const a of manifest.agents) {
          const wantedName = "name" in a ? a.name : a.localName;
          const agentId = agentIdByLocalName.get(wantedName);
          if (!agentId) continue;

          await tx.insert(teamMembers).values({
            teamId: team.id,
            agentId,
            role: a.role,
          });
        }

        // Step 4: scaffold the coordination row.
        // Drizzle transactions implement the same query interface as `Db`,
        // so the cast is safe; the scaffolder only uses `select` operations.
        const scaffolder = teamScaffolderService(tx as unknown as Db);
        const initialMarkdown = await scaffolder.scaffoldInitial(
          team.id,
          manifest.description,
        );
        // P2: derive `key` from teamId (unique per company) instead of the
        // manifest name slug. Keeps consistency with `teamCoordinationService.upsert`.
        await tx.insert(teamCoordinations).values({
          companyId,
          teamId: team.id,
          key: `team-${team.id}:coordination`,
          slug: manifest.name,
          name: `${manifest.displayName ?? manifest.name} Coordination`,
          markdown: initialMarkdown,
        });

        return {
          id: team.id,
          slug: team.slug,
          name: team.name,
          // Non-null by construction: `resolution.parentProjectId` is a required
          // string that was validated against this company above (~:247), and it
          // is what was just inserted. YAML import always parents into a
          // department — only the marketplace crew installer writes null (D21) —
          // so the HTTP contract stays `string` rather than widening.
          parentProjectId: team.parentProjectId!,
          warnings,
        };
      });
    },
  };
}
