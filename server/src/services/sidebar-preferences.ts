import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { sidebarPreferences } from "@armyofagents/db";
import type { SidebarPreferences } from "@armyofagents/shared";

function normalizeOrderedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function toPreferences(
  row: { departmentOrder: unknown; projectOrder: unknown; updatedAt: Date | null } | null,
): SidebarPreferences {
  return {
    departmentOrder: normalizeOrderedIds(row?.departmentOrder),
    projectOrder: normalizeOrderedIds(row?.projectOrder),
    updatedAt: row?.updatedAt ?? null,
  };
}

export interface SidebarPreferencesPatch {
  departmentOrder?: string[];
  projectOrder?: string[];
}

export function sidebarPreferencesService(db: Db) {
  async function readRow(userId: string, companyId: string) {
    const rows = await db
      .select({
        departmentOrder: sidebarPreferences.departmentOrder,
        projectOrder: sidebarPreferences.projectOrder,
        updatedAt: sidebarPreferences.updatedAt,
      })
      .from(sidebarPreferences)
      .where(
        and(
          eq(sidebarPreferences.userId, userId),
          eq(sidebarPreferences.companyId, companyId),
        ),
      );
    return rows[0] ?? null;
  }

  async function writeRow(
    userId: string,
    companyId: string,
    departmentOrder: string[],
    projectOrder: string[],
  ): Promise<SidebarPreferences> {
    const now = new Date();
    const [row] = await db
      .insert(sidebarPreferences)
      .values({
        userId,
        companyId,
        departmentOrder,
        projectOrder,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [sidebarPreferences.userId, sidebarPreferences.companyId],
        set: {
          departmentOrder,
          projectOrder,
          updatedAt: now,
        },
      })
      .returning({
        departmentOrder: sidebarPreferences.departmentOrder,
        projectOrder: sidebarPreferences.projectOrder,
        updatedAt: sidebarPreferences.updatedAt,
      });
    return toPreferences(row ?? null);
  }

  return {
    async get(userId: string, companyId: string): Promise<SidebarPreferences> {
      return toPreferences(await readRow(userId, companyId));
    },

    async upsert(
      userId: string,
      companyId: string,
      patch: SidebarPreferencesPatch,
    ): Promise<SidebarPreferences> {
      const existing = await readRow(userId, companyId);
      const existingDept = normalizeOrderedIds(existing?.departmentOrder);
      const existingProj = normalizeOrderedIds(existing?.projectOrder);
      const nextDept =
        patch.departmentOrder !== undefined
          ? normalizeOrderedIds(patch.departmentOrder)
          : existingDept;
      const nextProj =
        patch.projectOrder !== undefined
          ? normalizeOrderedIds(patch.projectOrder)
          : existingProj;
      return writeRow(userId, companyId, nextDept, nextProj);
    },

    async reset(userId: string, companyId: string): Promise<SidebarPreferences> {
      return writeRow(userId, companyId, [], []);
    },
  };
}
