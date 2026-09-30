import type { Db } from "@armyofagents/db";
import { environments, companies } from "@armyofagents/db";
import { and, eq } from "drizzle-orm";
import { probeEnvironmentConfig, type EnvironmentProbeResult } from "./environment-probe.js";

/** The single local environment onboarding creates/updates (upsert-by-name). */
export const ONBOARDING_ENVIRONMENT_NAME = "Local machine";

type ProbeFn = (input: {
  companyId: string;
  driver: "local";
  config: Record<string, unknown>;
}) => Promise<EnvironmentProbeResult>;

/**
 * Idempotent onboarding environment setup (Stage C / C5). BLOCKING (revA R13):
 * the local write-probe runs FIRST and, on failure, nothing is persisted — the
 * caller returns 422 and the founder stays on the step. On success it upserts
 * the "Local machine" environment by (companyId, name) and sets the company's
 * rootFolder, so re-entry never duplicates.
 */
export async function setupOnboardingEnvironment(
  db: Db,
  args: { companyId: string; rootFolder: string; probe?: ProbeFn },
): Promise<
  | { ok: false; environmentId: null; probe: EnvironmentProbeResult }
  | { ok: true; environmentId: string; created: boolean; probe: EnvironmentProbeResult }
> {
  const probeFn = args.probe ?? probeEnvironmentConfig;
  // 1. Blocking probe FIRST — never write rootFolder against an unwritable path.
  const probe = await probeFn({
    companyId: args.companyId,
    driver: "local",
    config: { path: args.rootFolder },
  });
  if (!probe.ok) {
    return { ok: false, environmentId: null, probe };
  }

  // 2. Idempotent env upsert-by-name.
  const [existing] = await db
    .select({ id: environments.id, name: environments.name })
    .from(environments)
    .where(
      and(
        eq(environments.companyId, args.companyId),
        eq(environments.name, ONBOARDING_ENVIRONMENT_NAME),
      ),
    )
    .limit(1);

  let environmentId: string;
  let created = false;
  if (existing) {
    await db
      .update(environments)
      .set({ driver: "local", config: { path: args.rootFolder }, status: "active", updatedAt: new Date() })
      .where(eq(environments.id, existing.id));
    environmentId = existing.id;
  } else {
    const [createdEnvironment] = await db
      .insert(environments)
      .values({
        companyId: args.companyId,
        name: ONBOARDING_ENVIRONMENT_NAME,
        driver: "local",
        status: "active",
        config: { path: args.rootFolder },
      })
      .returning();
    environmentId = createdEnvironment.id;
    created = true;
  }

  // 3. Persist rootFolder on the company (idempotent set).
  await db
    .update(companies)
    .set({ rootFolder: args.rootFolder, updatedAt: new Date() })
    .where(eq(companies.id, args.companyId));

  return { ok: true, environmentId, created, probe };
}
