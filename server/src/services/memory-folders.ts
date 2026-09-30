import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { memoryFolders, memoryItems } from "@armyofagents/db";
import { normalizeMemoryFolderPath } from "@armyofagents/shared";
import { getSeedFoldersForFunctionType, COMPANY_SEED_FOLDERS } from "./memory-folder-seeds.js";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";

const log = logger.child({ service: "memory-folders" });

interface CreateInput {
  companyId: string;
  departmentId: string | null;
  path: string;
  displayName: string;
  icon?: string | null;
  seedKey?: string | null;
  sortOrder?: number;
}

interface UpdateInput {
  path?: string;
  displayName?: string;
  icon?: string | null;
  sortOrder?: number;
}

interface ListInput {
  companyId: string;
  departmentId?: string | null;
}

interface SeedInput {
  companyId: string;
  departmentId: string;
  departmentSlug: string;
  functionType: string | null;
}

export function memoryFoldersService(db: Db) {
  return {
    list: async ({ companyId, departmentId }: ListInput) => {
      const conditions = [eq(memoryFolders.companyId, companyId)];
      if (departmentId === null) {
        conditions.push(isNull(memoryFolders.departmentId));
      } else if (departmentId !== undefined) {
        conditions.push(eq(memoryFolders.departmentId, departmentId));
      }
      return db.select().from(memoryFolders).where(and(...conditions));
    },

    create: async (input: CreateInput) => {
      const path = normalizeMemoryFolderPath(input.path);
      // Get-or-create (idempotent): the folder path is unique per company
      // (memory_folders_unique_path_per_company). A folder-creation collision —
      // e.g. two proposed memory items in one Librarian run both ensuring the
      // same root/department folder, or a re-seed — must NOT crash the caller.
      // Insert, no-op on conflict, then return the existing row.
      const [inserted] = await db
        .insert(memoryFolders)
        .values({
          companyId: input.companyId,
          departmentId: input.departmentId,
          path,
          displayName: input.displayName,
          icon: input.icon ?? null,
          seedKey: input.seedKey ?? null,
          sortOrder: input.sortOrder ?? 0,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) {
        publishLiveEvent({
          type: "memory.folder.created",
          companyId: input.companyId,
          payload: { folder: inserted },
        });
        return inserted;
      }
      // Conflict — the folder already exists; return it (no duplicate, no throw).
      const [existing] = await db
        .select()
        .from(memoryFolders)
        .where(and(eq(memoryFolders.companyId, input.companyId), eq(memoryFolders.path, path)));
      return existing;
    },

    update: async (id: string, companyId: string, patch: UpdateInput) => {
      const next: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.path !== undefined) next.path = normalizeMemoryFolderPath(patch.path);
      if (patch.displayName !== undefined) next.displayName = patch.displayName;
      if (patch.icon !== undefined) next.icon = patch.icon;
      if (patch.sortOrder !== undefined) next.sortOrder = patch.sortOrder;
      const [row] = await db
        .update(memoryFolders)
        .set(next)
        .where(and(eq(memoryFolders.id, id), eq(memoryFolders.companyId, companyId)))
        .returning();
      if (row) {
        publishLiveEvent({
          type: "memory.folder.updated",
          companyId,
          payload: { folder: row },
        });
      }
      return row ?? null;
    },

    remove: async (id: string, companyId: string): Promise<void> => {
      // Step 1: Look up the folder. If not found, silently no-op (idempotent).
      const targets = await db
        .select()
        .from(memoryFolders)
        .where(and(eq(memoryFolders.id, id), eq(memoryFolders.companyId, companyId)));

      const target = targets[0];
      if (!target) {
        // Already gone — silent success.
        return;
      }

      // Step 2: Enforce seedKey IS NULL — refuse to delete seeded folders.
      if (target.seedKey !== null) {
        const err = new Error("Cannot delete seeded folder");
        (err as Error & { code?: string }).code = "FOLDER_IS_SEEDED";
        throw err;
      }

      // Step 3: Compute parent path. e.g.
      //   "engineering/Q3"        -> "engineering"
      //   "engineering/Q3/OKRs"   -> "engineering/Q3"
      //   "Company"               -> ""  (top-level — safe-guard)
      const parentPath = target.path.includes("/")
        ? target.path.slice(0, target.path.lastIndexOf("/"))
        : "";

      // Codex P1 follow-up: wrap the entire reparent + delete sequence in a
      // single DB transaction. Without it, a mid-sequence failure (e.g. a
      // `memory_folders_unique_path_per_company` collision while reparenting
      // descendants) would leave earlier item/folder moves committed and the
      // tree in a partially-mutated state. The transaction guarantees the
      // operation is all-or-nothing.
      await db.transaction(async (tx) => {
        // Step 4: Reparent items. Fetch all affected rows in JS, compute the
        //         new folderPath, and update each. SQL's SUBSTRING+|| approach
        //         had a parameter-typing edge case in drizzle's sql template
        //         that produced NULL. JS rewrite is bulletproof and the row
        //         counts here are always small (single dept's items).
        const affectedItems = await tx
          .select({ id: memoryItems.id, folderPath: memoryItems.folderPath })
          .from(memoryItems)
          .where(
            and(
              eq(memoryItems.companyId, companyId),
              // folder_path = target.path OR folder_path LIKE target.path/%
              sql`(${memoryItems.folderPath} = ${target.path} OR ${memoryItems.folderPath} LIKE ${target.path + "/%"})`,
            ),
          );
        for (const row of affectedItems) {
          const remainder =
            row.folderPath === target.path
              ? ""
              : row.folderPath.slice(target.path.length); // includes leading "/"
          const newPath = parentPath + remainder;
          await tx
            .update(memoryItems)
            .set({ folderPath: newPath })
            .where(eq(memoryItems.id, row.id));
        }

        // Step 5: Reparent sub-folder rows. Same JS approach.
        const affectedFolders = await tx
          .select({ id: memoryFolders.id, path: memoryFolders.path })
          .from(memoryFolders)
          .where(
            and(
              eq(memoryFolders.companyId, companyId),
              sql`${memoryFolders.path} LIKE ${target.path + "/%"}`,
            ),
          );
        for (const row of affectedFolders) {
          const remainder = row.path.slice(target.path.length); // always starts with "/"
          const newPath = parentPath + remainder;
          await tx
            .update(memoryFolders)
            .set({ path: newPath })
            .where(eq(memoryFolders.id, row.id));
        }

        // Step 6: Delete the target folder row itself.
        await tx
          .delete(memoryFolders)
          .where(and(eq(memoryFolders.id, id), eq(memoryFolders.companyId, companyId)));
      });

      // Step 7: Publish LiveEvent — only after the transaction commits, so
      // we never announce a deletion that was rolled back.
      publishLiveEvent({
        type: "memory.folder.deleted",
        companyId,
        payload: { id, path: target.path, reparented: true },
      });
    },

    seedForDepartment: async (input: SeedInput) => {
      const seeds = getSeedFoldersForFunctionType(input.functionType);
      // Idempotent: skip seeds that already exist (matched by seedKey + dept).
      const existing = await db
        .select()
        .from(memoryFolders)
        .where(
          and(
            eq(memoryFolders.companyId, input.companyId),
            eq(memoryFolders.departmentId, input.departmentId),
          ),
        );
      const existingKeys = new Set(
        existing.map((row: { seedKey: string | null }) => row.seedKey).filter(Boolean),
      );
      const existingPaths = new Set(
        existing.map((row: { path: string }) => normalizeMemoryFolderPath(row.path)),
      );
      const toCreate = seeds.filter((s) => {
        const path = normalizeMemoryFolderPath(`${input.departmentSlug}/${s.path}`);
        return !existingKeys.has(s.seedKey) && !existingPaths.has(path);
      });
      if (toCreate.length === 0) return [];
      const created = [];
      for (const seed of toCreate) {
        const [row] = await db
          .insert(memoryFolders)
          .values({
            companyId: input.companyId,
            departmentId: input.departmentId,
            path: `${input.departmentSlug}/${seed.path}`,
            displayName: seed.displayName,
            icon: seed.icon ?? null,
            seedKey: seed.seedKey,
            sortOrder: 0,
          })
          .returning();
        created.push(row);
      }
      log.info({ companyId: input.companyId, departmentId: input.departmentId, count: created.length }, "seeded folders");
      return created;
    },
  };
}

export type MemoryFoldersService = ReturnType<typeof memoryFoldersService>;

interface SeedHookProject {
  id: string;
  type: string;
  name: string;
  urlKey: string;
  functionType: string | null;
}

export async function seedFoldersOnDepartmentCreate(
  svc: MemoryFoldersService,
  input: { companyId: string; project: SeedHookProject },
): Promise<void> {
  if (input.project.type !== "department") return;
  await svc.seedForDepartment({
    companyId: input.companyId,
    departmentId: input.project.id,
    departmentSlug: input.project.urlKey,
    functionType: input.project.functionType,
  });
}

/**
 * Phase 6.0 polish: seed the Company root folder for a new company. Best-effort
 * — duplicate key violations (from a re-run on a company that already has the
 * folder) are caught and ignored. The unique index on (companyId, path)
 * provides the idempotency guarantee at the DB level.
 */
async function seedCompanyRootFolderLegacy(
  svc: MemoryFoldersService,
  input: { companyId: string },
): Promise<void> {
  const seed = COMPANY_SEED_FOLDERS[0];
  if (!seed) return;
  try {
    await svc.create({
      companyId: input.companyId,
      departmentId: null,
      path: seed.path,
      displayName: seed.displayName,
      icon: seed.icon ?? null,
      seedKey: seed.seedKey,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("memory_folders_unique_path_per_company")) {
      // Already seeded — fine. Best-effort idempotence.
      return;
    }
    throw err;
  }
}

export async function seedCompanyRootFolder(
  svc: MemoryFoldersService,
  input: { companyId: string },
): Promise<void> {
  for (const seed of COMPANY_SEED_FOLDERS) {
    try {
      await svc.create({
        companyId: input.companyId,
        departmentId: null,
        path: seed.path,
        displayName: seed.displayName,
        icon: seed.icon ?? null,
        seedKey: seed.seedKey,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("memory_folders_unique_path_per_company")) {
        continue;
      }
      throw err;
    }
  }
}
