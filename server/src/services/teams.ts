import { eq, and, inArray, count } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { teams, teamMembers, agentProjects, projects, teamCoordinations } from "@armyofagents/db";
import type {
  CreateTeamInput,
  UpdateTeamInput,
  TeamRole,
} from "@armyofagents/shared";
import { generateTeamSlug, ensureUniqueSlug } from "./team-slug.js";
import { validateManifest } from "./team-manifest.js";
import { isUniqueViolation } from "./db-errors.js";
import { badRequest, conflict, notFound } from "../errors.js";

/**
 * Insert a team with a unique slug, retrying with `-2`, `-3`, ... suffixes
 * on 23505 collisions against `teams_company_slug_uq`. Returns the
 * inserted team row.
 *
 * Caller MUST run this inside a transaction — the `tx` parameter is the
 * Drizzle transaction handle. The helper reads existing slugs to pick a
 * suffix; a concurrent insert can still beat us between the SELECT and
 * the INSERT, so retries re-probe and try again.
 *
 * The base slug is derived from `slugBase` if provided (used by
 * team-import where the manifest already supplies a slug-shaped string),
 * otherwise from `values.name` via `generateTeamSlug`. The display-name
 * column on the row is always `values.name`.
 *
 * Throws `conflict()` after `maxRetries` attempts (default 5) — the slug
 * space for that base name is functionally saturated, so the founder
 * needs to pick a different team name.
 *
 * P1-C: shared by `teamsService.create` and `teamImportService.install`.
 * Both paths previously had their own retry logic (or, in import's case,
 * none at all — relying on a pre-flight slug-existence probe that does
 * not close the TOCTOU window).
 *
 * `tx` is typed `any` because the inferred Drizzle Tx type isn't exported
 * cleanly across modules. The shape we depend on (select/insert) is the
 * same as `Db`.
 */
export async function insertTeamWithUniqueSlug(
  tx: any,
  values: {
    companyId: string;
    parentProjectId: string;
    name: string;
    description?: string | null;
    manifest?: unknown;
    templateOrigin?: string | null;
    templateVersion?: string | null;
  },
  options: { maxRetries?: number; slugBase?: string } = {},
): Promise<{
  id: string;
  slug: string;
  name: string;
  // `tx` is `any`, so this shape is an unchecked assertion about the returned
  // row — it must not claim more than the column guarantees. D21 made
  // `teams.parent_project_id` nullable, so a caller reading it back can get
  // null even though this helper's INPUT still requires a department (that
  // narrower input is a deliberate trap: a future company-wide caller gets a
  // compile error here rather than a silent write).
  parentProjectId: string | null;
  [k: string]: unknown;
}> {
  const maxRetries = options.maxRetries ?? 5;
  const baseSlug = generateTeamSlug(options.slugBase ?? values.name);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const existing = await tx
      .select({ slug: teams.slug })
      .from(teams)
      .where(eq(teams.companyId, values.companyId));
    const slug = ensureUniqueSlug(
      baseSlug,
      new Set(existing.map((r: { slug: string }) => r.slug)),
    );

    try {
      const inserted = await tx
        .insert(teams)
        .values({ ...values, slug })
        .returning();
      return inserted[0];
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Loop will re-fetch existing slugs (the colliding row is now
      // visible in this tx's snapshot or in subsequent reads) and pick a
      // fresh suffix.
    }
  }

  throw conflict(
    `could not generate a unique slug for "${options.slugBase ?? values.name}" after ${maxRetries} attempts — pick a different team name`,
  );
}

export function teamsService(db: Db) {
  /**
   * Loads a team for a roster mutation (add / remove / role change), refusing
   * the edit outright when the team is company-wide (D21 — `parentProjectId` is
   * null).
   *
   * For a company-wide team the ENTIRE membership surface is installer-owned:
   * the roster comes from the marketplace package, is written by the installer
   * inside its own transaction, and is reconciled by `team-reconcile`. Closing
   * only `addMember` would be worse than closing none — a founder could strip
   * the crew one agent at a time with no supported way to put anyone back.
   *
   * This is deliberately a refusal rather than a skipped check. `addMember`'s
   * department-membership lookup is the tenancy-bearing guard (it is what stops
   * an agent from another company being linked in); silently bypassing it for
   * null-parent teams would open a cross-tenant path. Making the roster
   * founder-editable needs its own company-scoped agent check — a real design
   * call, not a side effect of making the column nullable.
   */
  const loadTeamForRosterEdit = async (teamId: string) => {
    const teamRows = await db.select().from(teams).where(eq(teams.id, teamId));
    if (teamRows.length === 0) throw notFound(`team ${teamId} not found`);
    const team = teamRows[0];
    if (team.parentProjectId === null) {
      throw badRequest(
        `team ${teamId} is company-wide (no parent department) — its roster is installer-owned and cannot be edited through this path`,
      );
    }
    // Re-spread so the narrowing survives into the return type: callers get
    // `parentProjectId: string` and can use it as a department id without a
    // non-null assertion. Narrowing by construction, not by cast.
    return { ...team, parentProjectId: team.parentProjectId };
  };

  return {
    list: async (companyId: string, projectId?: string) => {
      // Fetch team rows
      const teamRows = await (projectId
        ? db
            .select()
            .from(teams)
            .where(and(eq(teams.companyId, companyId), eq(teams.parentProjectId, projectId)))
        : db.select().from(teams).where(eq(teams.companyId, companyId)));

      if (teamRows.length === 0) {
        return teamRows.map((t) => ({ ...t, memberCount: 0, leadAgentId: null as string | null, memberAgentIds: [] as string[] }));
      }

      // Single batch query for member summaries — avoids N+1 in the list view.
      const ids = teamRows.map((t) => t.id);
      const memberRows = await db
        .select({ teamId: teamMembers.teamId, agentId: teamMembers.agentId, role: teamMembers.role })
        .from(teamMembers)
        .where(inArray(teamMembers.teamId, ids));

      const byTeam = new Map<string, { agentId: string; role: string }[]>();
      for (const m of memberRows) {
        const bucket = byTeam.get(m.teamId);
        if (bucket) bucket.push(m);
        else byTeam.set(m.teamId, [m]);
      }

      return teamRows.map((t) => {
        const members = byTeam.get(t.id) ?? [];
        const lead = members.find((m) => m.role === "lead");
        return {
          ...t,
          memberCount: members.length,
          leadAgentId: lead?.agentId ?? null,
          memberAgentIds: members.map((m) => m.agentId),
        };
      });
    },

    getById: async (id: string) => {
      const rows = await db.select().from(teams).where(eq(teams.id, id));
      if (rows.length === 0) throw notFound(`team ${id} not found`);
      return rows[0];
    },

    getBySlug: async (companyId: string, slug: string) => {
      const rows = await db
        .select()
        .from(teams)
        .where(and(eq(teams.companyId, companyId), eq(teams.slug, slug)));
      if (rows.length === 0) throw notFound(`team ${slug} not found`);
      return rows[0];
    },

    create: async (companyId: string, input: CreateTeamInput) => {
      // P1: Cross-tenant guard — verify the parent project belongs to the
      // caller's company before writing. The FK only enforces
      // `projects.id` existence, not `projects.companyId === teams.companyId`,
      // so without this check a caller could supply another company's project
      // UUID and create a cross-tenant team.
      const projectCheck = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.id, input.parentProjectId),
            eq(projects.companyId, companyId),
          ),
        );
      if (projectCheck.length === 0) {
        throw badRequest(
          `parent project ${input.parentProjectId} not found in company ${companyId}`,
        );
      }

      const memberInputs = input.members ?? [];

      if (memberInputs.length > 0) {
        const agentIds = memberInputs.map((m) => m.agentId);
        const deptMemberships = await db
          .select({ agentId: agentProjects.agentId })
          .from(agentProjects)
          .where(
            and(
              inArray(agentProjects.agentId, agentIds),
              eq(agentProjects.projectId, input.parentProjectId),
            ),
          );
        const inDept = new Set(
          deptMemberships.map((m: { agentId: string }) => m.agentId),
        );
        const missing = agentIds.filter((id) => !inDept.has(id));
        if (missing.length > 0) {
          throw badRequest(
            `agents not in parent department: ${missing.join(", ")}`,
          );
        }
      }

      const leadCount = memberInputs.filter((m) => m.role === "lead").length;
      if (leadCount > 1) {
        throw badRequest(`at most one lead per team, got ${leadCount}`);
      }

      return db.transaction(async (tx) => {
        const team = await insertTeamWithUniqueSlug(tx, {
          companyId,
          parentProjectId: input.parentProjectId,
          name: input.name,
          description: input.description ?? null,
          manifest: input.manifest ?? {},
        });

        if (memberInputs.length > 0) {
          await tx.insert(teamMembers).values(
            memberInputs.map((m) => ({
              teamId: team.id,
              agentId: m.agentId,
              role: m.role,
            })),
          );
        }

        return team;
      });
    },

    update: async (id: string, patch: UpdateTeamInput) => {
      const updated = await db
        .update(teams)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(teams.id, id))
        .returning();
      if (updated.length === 0) throw notFound(`team ${id} not found`);
      return updated[0];
    },

    updateManifest: async (id: string, manifest: unknown) => {
      // Enforces invariants (regex compilation, schema shape) beyond what the
      // route-level Zod validator covers. Throws on violation.
      const validated = validateManifest(manifest);
      const updated = await db
        .update(teams)
        .set({ manifest: validated, updatedAt: new Date() })
        .where(eq(teams.id, id))
        .returning();
      if (updated.length === 0) throw notFound(`team ${id} not found`);
      return updated[0];
    },

    archive: async (id: string) => {
      // P1-D: archive cascades to the team's coordination. Without this,
      // buildTeamCoordinationSkillEntries continues to inject the team's
      // markdown into every member agent's heartbeat run because the
      // coordination row stays status='published'.
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(teams)
          .set({
            status: "archived",
            archivedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(teams.id, id))
          .returning();
        if (updated.length === 0) throw notFound(`team ${id} not found`);

        // Cascade — best effort. If no coord row exists, the UPDATE affects 0
        // rows and we don't care. If one exists, flipping it to archived stops
        // injection. team_coordinations has no archivedAt column (only `teams`
        // has one) — only updatedAt is touched here.
        await tx
          .update(teamCoordinations)
          .set({ status: "archived", updatedAt: new Date() })
          .where(
            and(
              eq(teamCoordinations.teamId, id),
              eq(teamCoordinations.status, "published"),
            ),
          );

        return updated[0];
      });
    },

    /**
     * Hard-delete a team. Schema cascades automatically remove team_members
     * and team_coordinations rows (both have `onDelete: "cascade"` on
     * `teams.id`). Agents survive — they were never owned by the team; they
     * live independently in `agents` + `agent_projects`.
     *
     * Use this as the founder escape hatch for "I imported the wrong team and
     * want to undo it cleanly." For temporary hide, use `archive()` instead.
     */
    dismantle: async (id: string): Promise<{ dismantledTeamId: string }> => {
      const teamRows = await db
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.id, id));
      if (teamRows.length === 0) throw notFound(`team ${id} not found`);

      await db.delete(teams).where(eq(teams.id, id));
      // Cascade handles team_members + team_coordinations.

      return { dismantledTeamId: id };
    },

    listMembers: async (teamId: string) => {
      return db
        .select()
        .from(teamMembers)
        .where(eq(teamMembers.teamId, teamId));
    },

    getMember: async (teamId: string, agentId: string) => {
      const rows = await db
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.agentId, agentId)));
      if (rows.length === 0) throw notFound(`agent ${agentId} not a member of team ${teamId}`);
      return rows[0];
    },

    addMember: async (teamId: string, agentId: string, role: TeamRole) => {
      const team = await loadTeamForRosterEdit(teamId);

      // Verify agent is a member of the team's parent department
      const deptMembership = await db
        .select()
        .from(agentProjects)
        .where(
          and(
            eq(agentProjects.agentId, agentId),
            eq(agentProjects.projectId, team.parentProjectId),
          ),
        );
      if (deptMembership.length === 0) {
        throw badRequest(
          `agent is not a member of the team's parent department`,
        );
      }

      // Verify no existing lead if adding a lead
      if (role === "lead") {
        const existingLead = await db
          .select()
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.teamId, teamId),
              eq(teamMembers.role, "lead"),
            ),
          );
        if (existingLead.length > 0) {
          throw badRequest(`team already has a lead — reassign first`);
        }
      }

      // P2: convert PG 23505 unique-violation on the
      // `team_members_team_agent_uq` index into a clean 409 Conflict.
      // A naked re-insert would otherwise bubble up as 500 via the global
      // error handler — but a duplicate addMember is a client-correctable
      // condition, not a server fault.
      try {
        const inserted = await db
          .insert(teamMembers)
          .values({ teamId, agentId, role })
          .returning();
        return inserted[0];
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw conflict(
            `agent ${agentId} is already a member of team ${teamId}`,
          );
        }
        throw err;
      }
    },

    removeMember: async (teamId: string, agentId: string) => {
      await loadTeamForRosterEdit(teamId);

      const membershipRows = await db
        .select()
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, teamId),
            eq(teamMembers.agentId, agentId),
          ),
        );
      if (membershipRows.length === 0) throw notFound(`membership not found`);
      const membership = membershipRows[0];

      if (membership.role === "lead") {
        const leadCount = await db
          .select()
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.teamId, teamId),
              eq(teamMembers.role, "lead"),
            ),
          );
        if (leadCount.length === 1) {
          throw badRequest(
            `cannot remove the only lead — designate a new lead first`,
          );
        }
      }

      await db
        .delete(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, teamId),
            eq(teamMembers.agentId, agentId),
          ),
        );
      return { ok: true };
    },

    updateMemberRole: async (
      teamId: string,
      agentId: string,
      role: TeamRole,
    ) => {
      await loadTeamForRosterEdit(teamId);

      // P1-B: when promoting to lead, the partial unique index
      // team_members_one_lead_uq backstops the demote-then-promote
      // sequence. A concurrent caller racing the same promotion can win
      // the lead slot; our UPDATE then throws 23505. Convert to a clean
      // 409 — the asymmetry with addMember (which already does this) was
      // the bug.
      return db.transaction(async (tx) => {
        if (role === "lead") {
          const existingLead = await tx
            .select()
            .from(teamMembers)
            .where(
              and(
                eq(teamMembers.teamId, teamId),
                eq(teamMembers.role, "lead"),
              ),
            );
          for (const lead of existingLead) {
            if (lead.agentId !== agentId) {
              await tx
                .update(teamMembers)
                .set({ role: "member" })
                .where(eq(teamMembers.id, lead.id));
            }
          }
        }
        try {
          const updated = await tx
            .update(teamMembers)
            .set({ role })
            .where(
              and(
                eq(teamMembers.teamId, teamId),
                eq(teamMembers.agentId, agentId),
              ),
            )
            .returning();
          if (updated.length === 0) throw notFound(`membership not found`);
          return updated[0];
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw conflict(
              `concurrent lead change for team ${teamId} — retry`,
            );
          }
          throw err;
        }
      });
    },
  };
}
