import { eq, and } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { teamCoordinations } from "@armyofagents/db";
import type { CreateTeamCoordinationInput } from "@armyofagents/shared";
import { generateTeamSlug } from "./team-slug.js";
import { isUniqueViolation } from "./db-errors.js";
import { notFound, conflict } from "../errors.js";
import { replaceAutoSection } from "./coordination-parser.js";

export function teamCoordinationService(db: Db) {
  return {
    getByTeam: async (teamId: string) => {
      const rows = await db
        .select()
        .from(teamCoordinations)
        .where(and(eq(teamCoordinations.teamId, teamId), eq(teamCoordinations.status, "published")));
      return rows[0] ?? null;
    },

    upsert: async (companyId: string, input: CreateTeamCoordinationInput) => {
      // P1-E + P1-F hardening:
      //   - The partial unique index `team_coordinations_one_published_uq`
      //     guarantees at most one published row per team; we map its 23505
      //     to a clean 409 Conflict.
      //   - The `key` column is constant per team (`team-${teamId}:coordination`)
      //     and the FULL unique index `team_coordinations_company_key_uq` covers
      //     it. So when no PUBLISHED row exists but an ARCHIVED row does,
      //     we MUST update the archived row back to published instead of
      //     inserting a fresh row (which would 23505 on the company-key index).
      return db.transaction(async (tx) => {
        const existingPublished = await tx
          .select()
          .from(teamCoordinations)
          .where(and(
            eq(teamCoordinations.teamId, input.teamId),
            eq(teamCoordinations.status, "published"),
          ));

        if (existingPublished.length > 0) {
          const updated = await tx
            .update(teamCoordinations)
            .set({
              name: input.name,
              description: input.description,
              markdown: input.markdown,
              updatedAt: new Date(),
            })
            .where(and(
              eq(teamCoordinations.id, existingPublished[0].id),
              // C1: re-check status in the WHERE — if a concurrent tx archived
              // the row between our SELECT and this UPDATE, updated.length === 0
              // and we surface a clean 409 rather than silently overwriting an
              // archived row with new content.
              eq(teamCoordinations.status, "published"),
            ))
            .returning();
          if (updated.length === 0) {
            throw conflict(
              `coordination for team ${input.teamId} was just archived by a concurrent request — retry`,
            );
          }
          return updated[0];
        }

        // No published row — check for an archived row to revive.
        const existingArchived = await tx
          .select()
          .from(teamCoordinations)
          .where(and(
            eq(teamCoordinations.teamId, input.teamId),
            eq(teamCoordinations.status, "archived"),
          ));

        if (existingArchived.length > 0) {
          // C2: wrap the revive UPDATE in 23505 handling AND re-check status in
          // the WHERE. Two race shapes are possible:
          //   1. Concurrent tx revived this same archived row first → our
          //      WHERE-by-id-AND-status='archived' returns 0 rows → 409.
          //   2. Concurrent tx archived this row + inserted a NEW published row
          //      for the same team → our UPDATE flips the archived row to
          //      published, but the partial unique index fires because there's
          //      now two published rows for the same team → 23505 → 409.
          try {
            const revived = await tx
              .update(teamCoordinations)
              .set({
                status: "published",
                name: input.name,
                description: input.description,
                markdown: input.markdown,
                updatedAt: new Date(),
              })
              .where(and(
                eq(teamCoordinations.id, existingArchived[0].id),
                eq(teamCoordinations.status, "archived"),
              ))
              .returning();
            if (revived.length === 0) {
              throw conflict(
                `coordination for team ${input.teamId} was just revived by a concurrent request — retry`,
              );
            }
            return revived[0];
          } catch (err) {
            if (isUniqueViolation(err)) {
              throw conflict(
                `coordination for team ${input.teamId} was just published by a concurrent request — retry to merge`,
              );
            }
            throw err;
          }
        }

        // Truly new — insert. Wrapped in try/catch so a concurrent insert losing
        // the partial unique race surfaces as 409 not 500.
        const slug = generateTeamSlug(input.name);
        try {
          const inserted = await tx
            .insert(teamCoordinations)
            .values({
              companyId,
              teamId: input.teamId,
              key: `team-${input.teamId}:coordination`,
              slug,
              name: input.name,
              description: input.description,
              markdown: input.markdown,
            })
            .returning();
          return inserted[0];
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw conflict(
              `coordination for team ${input.teamId} was just published by a concurrent request — retry to merge`,
            );
          }
          throw err;
        }
      });
    },

    archive: async (id: string) => {
      const updated = await db
        .update(teamCoordinations)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(teamCoordinations.id, id))
        .returning();
      if (updated.length === 0) throw notFound(`coordination ${id} not found`);
      return updated[0];
    },

    regenerateAutoSections: async (
      coordinationId: string,
      sections: Record<string, string>,
    ) => {
      const rows = await db
        .select()
        .from(teamCoordinations)
        .where(eq(teamCoordinations.id, coordinationId));
      if (rows.length === 0) throw notFound(`coordination ${coordinationId} not found`);

      let markdown = rows[0].markdown;
      for (const [name, content] of Object.entries(sections)) {
        markdown = replaceAutoSection(markdown, name, content);
      }

      const updated = await db
        .update(teamCoordinations)
        .set({ markdown, updatedAt: new Date() })
        .where(eq(teamCoordinations.id, coordinationId))
        .returning();
      // B3.1: defense-in-depth against the row being deleted between the
      // SELECT above and the UPDATE here. Without this guard, the function
      // would return `undefined` and the caller would silently drop the
      // result. Mirrors the symmetric guard in `archive` above.
      if (updated.length === 0) {
        throw notFound(`coordination ${coordinationId} not found`);
      }
      return updated[0];
    },
  };
}
