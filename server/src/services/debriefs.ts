import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { debriefs, briefs } from "@armyofagents/db";

export interface DebriefFilters {
  status?: string;
  departmentId?: string;
  inputType?: string;
}

export function debriefService(db: Db) {
  return {
    list: (companyId: string, filters: DebriefFilters = {}) => {
      const conditions = [eq(debriefs.companyId, companyId)];

      if (filters.status) {
        conditions.push(eq(debriefs.status, filters.status));
      }
      if (filters.departmentId) {
        conditions.push(eq(debriefs.departmentId, filters.departmentId));
      }
      if (filters.inputType) {
        conditions.push(eq(debriefs.inputType, filters.inputType));
      }

      return db.select().from(debriefs).where(and(...conditions));
    },

    getById: async (companyId: string, id: string) => {
      const debrief = await db
        .select()
        .from(debriefs)
        .where(and(eq(debriefs.id, id), eq(debriefs.companyId, companyId)))
        .then((rows) => rows[0] ?? null);

      if (!debrief) return null;

      // Include associated brief if exists
      const brief = await db
        .select()
        .from(briefs)
        .where(eq(briefs.debriefId, debrief.id))
        .then((rows) => rows[0] ?? null);

      return { ...debrief, brief };
    },

    create: (
      companyId: string,
      data: Omit<typeof debriefs.$inferInsert, "companyId" | "status">,
    ) =>
      db
        .insert(debriefs)
        .values({ ...data, companyId, status: "processing" })
        .returning()
        .then((rows) => rows[0]),

    update: (
      companyId: string,
      id: string,
      data: Partial<Pick<typeof debriefs.$inferInsert, "title" | "status" | "departmentId" | "projectId" | "goalId">>,
    ) =>
      db
        .update(debriefs)
        .set(data)
        .where(and(eq(debriefs.id, id), eq(debriefs.companyId, companyId)))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
