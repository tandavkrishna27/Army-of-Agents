import { eq } from "drizzle-orm";
import { internalAgentConfig, type Db } from "@armyofagents/db";

export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  payload: T,
): T & { modelProfileHint: "cheap"; recoveryModelProfile: "cheap" } {
  return { ...payload, modelProfileHint: "cheap", recoveryModelProfile: "cheap" };
}

export function isCheapRecoveryWake(payload: Record<string, unknown> | null | undefined) {
  return payload?.modelProfileHint === "cheap" || payload?.recoveryModelProfile === "cheap";
}

export async function resolveRecoveryCheapModel(db: Db, companyId: string) {
  const row = await db
    .select({ cheapModel: internalAgentConfig.cheapModel })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return row?.cheapModel?.trim() || null;
}
