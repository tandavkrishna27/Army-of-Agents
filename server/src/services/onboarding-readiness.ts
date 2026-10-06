import { and, eq, isNull } from "drizzle-orm";
import {
  companies,
  companyImportOperations,
  companyMemberships,
  organizationMemberships,
  userRoles,
  type Db,
} from "@armyofagents/db";
import { normalizeLegacyOnboardingState, type OnboardingJourney, type OnboardingState } from "@armyofagents/shared";
import { advanceState, type AdvanceResult } from "./onboarding.js";

async function isActiveFounderOwner(db: Db, companyId: string, userId: string): Promise<boolean> {
  const [company] = await db.select({ organizationId: companies.organizationId })
    .from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) return false;

  const [companyOwner] = await db.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
    eq(companyMemberships.companyId, companyId),
    eq(companyMemberships.principalType, "user"),
    eq(companyMemberships.principalId, userId),
    eq(companyMemberships.status, "active"),
    eq(companyMemberships.membershipRole, "owner"),
  )).for("share").limit(1);
  if (!companyOwner) return false;

  const [activeOrganizationMember] = await db.select({ id: organizationMemberships.id })
    .from(organizationMemberships).where(and(
      eq(organizationMemberships.organizationId, company.organizationId),
      eq(organizationMemberships.userId, userId),
      eq(organizationMemberships.status, "active"),
    )).for("share").limit(1);
  if (!activeOrganizationMember) return false;

  const [founderRole] = await db.select({ id: userRoles.id }).from(userRoles).where(and(
    eq(userRoles.companyId, companyId),
    eq(userRoles.userId, userId),
    eq(userRoles.role, "founder"),
    isNull(userRoles.projectId),
  )).for("share").limit(1);
  return Boolean(founderRole);
}

/**
 * Completes the requested onboarding progress and, only for an authorized
 * founder-owner in a non-imported workspace, atomically marks execution ready.
 * The company state transition is monotonic and independent of first-run UI
 * completion. Imported workspaces remain owned by their import operation.
 */
export async function advanceSetupReadiness(db: Db, args: {
  actor: Pick<Actor, "type" | "source" | "userId">;
  companyId: string;
  journey: OnboardingJourney;
  requestedState: OnboardingState;
}): Promise<AdvanceResult> {
  return db.transaction(async (txHandle) => {
    const tx = txHandle as unknown as Db;
    if (args.actor.type !== "board" || !args.actor.userId) {
      return { status: "illegal", reason: "setup completion requires an authenticated board actor" };
    }
    const result = await advanceState(tx, {
      userId: args.actor.userId,
      companyId: args.companyId,
      journey: args.journey,
      requestedState: args.requestedState,
    });
    if (normalizeLegacyOnboardingState(args.requestedState) !== "SETUP_COMPLETE" ||
      result.status !== "ok" || !result.row.completedStates.includes("SETUP_COMPLETE")) return result;
    if (args.journey !== "founder") return result;

    const authorized = args.actor.source === "local_implicit" ||
      await isActiveFounderOwner(tx, args.companyId, args.actor.userId);
    if (!authorized) return result;

    const [importOperation] = await tx.select({ id: companyImportOperations.id })
      .from(companyImportOperations).where(eq(companyImportOperations.companyId, args.companyId)).limit(1);
    if (importOperation) return result;

    await tx.update(companies).set({ agentExecutionSetupState: "ready", updatedAt: new Date() })
      .where(and(eq(companies.id, args.companyId), eq(companies.agentExecutionSetupState, "pending")));
    return result;
  });
}
