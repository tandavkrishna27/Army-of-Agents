import { eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { companies, projects } from "@armyofagents/db";
import {
  memoryFoldersService,
  seedCompanyRootFolder,
  seedFoldersOnDepartmentCreate,
} from "../services/memory-folders.js";

function departmentSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/&/g, "-and-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "department";
}

/**
 * Backfill the expanded company brain folder seeds for companies/departments
 * created before the richer seed template shipped.
 *
 * Idempotent: the underlying seed service skips existing seed keys and paths,
 * so this can safely run on every startup.
 */
export async function backfillMemoryFolderSeeds(
  db: Db,
): Promise<{ companies: number; departments: number }> {
  const svc = memoryFoldersService(db);

  const companyRows = await db
    .select({ id: companies.id })
    .from(companies);

  for (const company of companyRows) {
    await seedCompanyRootFolder(svc, { companyId: company.id });
  }

  const departmentRows = await db
    .select({
      id: projects.id,
      companyId: projects.companyId,
      name: projects.name,
      type: projects.type,
      functionType: projects.functionType,
    })
    .from(projects)
    .where(eq(projects.type, "department"));

  for (const department of departmentRows) {
    await seedFoldersOnDepartmentCreate(svc, {
      companyId: department.companyId,
      project: {
        id: department.id,
        type: department.type,
        name: department.name,
        urlKey: departmentSlug(department.name),
        functionType: department.functionType,
      },
    });
  }

  return {
    companies: companyRows.length,
    departments: departmentRows.length,
  };
}

export const __memoryFolderSeedBackfillTest = {
  departmentSlug,
};
