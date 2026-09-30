import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { environments } from "@armyofagents/db";

export interface ResolvedEnvironmentRuntimeConfig {
  environmentId: string | null;
  envVars: Record<string, unknown>;
  target: Record<string, unknown> | null;
  // P5: the environment's explicit execution-target pin (null = route by credential).
  executionTargetId: string | null;
}

/**
 * Resolve the environment envVars to inject between project baseline and agent
 * adapterConfig.env during heartbeat dispatch.
 *
 * Priority: issue.executionEnvironmentId > agent.defaultEnvironmentId > none.
 * The DB query is always scoped by companyId to prevent cross-tenant leakage.
 */
export async function resolveEnvironmentEnvVars(
  db: Db,
  opts: {
    executionEnvironmentId: string | null | undefined;
    defaultEnvironmentId: string | null | undefined;
    companyId: string;
  },
): Promise<Record<string, unknown>> {
  const resolved = await resolveEnvironmentRuntimeConfig(db, opts);
  return resolved.envVars;
}

export async function resolveEnvironmentRuntimeConfig(
  db: Db,
  opts: {
    executionEnvironmentId: string | null | undefined;
    defaultEnvironmentId: string | null | undefined;
    companyId: string;
  },
): Promise<ResolvedEnvironmentRuntimeConfig> {
  const envId = opts.executionEnvironmentId ?? opts.defaultEnvironmentId ?? null;
  if (!envId) return { environmentId: null, envVars: {}, target: null, executionTargetId: null };

  const row = await db
    .select({
      envVars: environments.envVars,
      target: environments.target,
      executionTargetId: environments.executionTargetId,
    })
    .from(environments)
    .where(and(eq(environments.id, envId), eq(environments.companyId, opts.companyId)))
    .then((rows) => rows[0] ?? null);

  if (!row) return { environmentId: null, envVars: {}, target: null, executionTargetId: null };
  return {
    environmentId: envId,
    envVars: (row.envVars as Record<string, unknown>) ?? {},
    target: (row.target as Record<string, unknown> | null | undefined) ?? null,
    executionTargetId: (row.executionTargetId as string | null | undefined) ?? null,
  };
}
