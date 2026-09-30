/**
 * Memory governance settings service (enterprise memory model, P1-T10).
 *
 * Owns reads/writes of the `memory_settings` table: the company-default row
 * (departmentId null) plus per-department overrides. `pickAutonomyLevel` is the
 * pure resolver (dept override > company default > 'supervised' fallback) consumed
 * by `resolveWriteDisposition` wiring in P5. Follows the `goals.ts` service shape.
 */
import { and, eq, sql } from "drizzle-orm";
import { memorySettings, projects, type Db } from "@armyofagents/db";
import type { AutonomyLevel } from "./memory-tier-policy.js";

const VALID_AUTONOMY: readonly AutonomyLevel[] = ["manual", "supervised", "trusted", "policy"];

/**
 * Effective autonomy for a department: its override wins, else the company default,
 * else 'supervised'. An invalid stored value coerces to 'supervised' (least surprise —
 * never hands a caller an out-of-enum level).
 */
export function pickAutonomyLevel(
  rows: Array<{ departmentId: string | null; autonomyLevel: string }>,
  departmentId: string | null,
): AutonomyLevel {
  const dept = departmentId ? rows.find((r) => r.departmentId === departmentId) : undefined;
  const company = rows.find((r) => r.departmentId === null);
  const val = dept?.autonomyLevel ?? company?.autonomyLevel ?? "supervised";
  return (VALID_AUTONOMY as readonly string[]).includes(val) ? (val as AutonomyLevel) : "supervised";
}

/** Fields a caller may set through upsert (governance columns are P3/P4-owned). */
export type MemorySettingsPatch = Partial<{
  autonomyLevel: string;
  activeContextTier: string;
}>;

export function memorySettingsService(db: Db) {
  return {
    /** All rows for a company: the company default (departmentId null) + overrides. */
    list: (companyId: string) =>
      db.select().from(memorySettings).where(eq(memorySettings.companyId, companyId)),

    /** Resolve only a real department belonging to this company. */
    getDepartment: (companyId: string, departmentId: string) =>
      db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.id, departmentId),
            eq(projects.companyId, companyId),
            eq(projects.type, "department"),
          ),
        )
        .then((rows) => rows[0] ?? null),

    /**
     * Upsert the company-default (departmentId null) or a department override.
     * Guarded on the null-dept default: matches with `isNull` so a second
     * company-default write updates the existing row rather than inserting a
     * duplicate (Postgres NULLs are distinct — the composite unique can't catch it;
     * the partial unique + this guard together do).
     */
    upsert: async (
      companyId: string,
      departmentId: string | null,
      patch: MemorySettingsPatch,
    ) => {
      return db
        .insert(memorySettings)
        .values({ companyId, departmentId, ...patch })
        .onConflictDoUpdate(
          departmentId
            ? {
                target: [memorySettings.companyId, memorySettings.departmentId],
                set: { ...patch, updatedAt: new Date() },
              }
            : {
                target: memorySettings.companyId,
                targetWhere: sql`${memorySettings.departmentId} IS NULL`,
                set: { ...patch, updatedAt: new Date() },
              },
        )
        .returning()
        .then((r) => r[0]);
    },

    /**
     * Remove a department override so the department reverts to the company
     * default. Never touches the company-default row (departmentId must be set).
     */
    deleteOverride: (companyId: string, departmentId: string) =>
      db
        .delete(memorySettings)
        .where(
          and(
            eq(memorySettings.companyId, companyId),
            eq(memorySettings.departmentId, departmentId),
          ),
        ),
  };
}
