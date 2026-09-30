import {
  agentApiKeys,
  agents,
  companies,
  companyMemberships,
  organizationMemberships,
  type Db,
} from "@armyofagents/db";
import { and, eq, isNull } from "drizzle-orm";

export type UpgradeSocketActorContext =
  | {
      companyId: string;
      actorType: "board";
      actorId: string;
    }
  | {
      companyId: string;
      actorType: "agent";
      actorId: string;
      keyId: string;
    };

/** The shared cloud tenant predicate for both handshake and open-socket checks. */
export async function hasActiveCloudMembership(
  db: Db,
  companyId: string,
  userId: string,
): Promise<boolean> {
  const companyRow = await db
    .select({ organizationId: companies.organizationId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  const organizationId = companyRow?.organizationId ?? null;
  if (!organizationId) return false;

  const [orgMembership, companyMembership] = await Promise.all([
    db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.organizationId, organizationId),
          eq(organizationMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null),
    db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null),
  ]);
  return Boolean(orgMembership && companyMembership);
}

/** Revalidate the exact key used for the upgrade plus the agent's live eligibility. */
export async function hasActiveAgentSocketAuthorization(
  db: Db,
  context: Extract<UpgradeSocketActorContext, { actorType: "agent" }>,
): Promise<boolean> {
  const key = await db
    .select({
      id: agentApiKeys.id,
      companyId: agentApiKeys.companyId,
      agentId: agentApiKeys.agentId,
      revokedAt: agentApiKeys.revokedAt,
    })
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.id, context.keyId), isNull(agentApiKeys.revokedAt)))
    .then((rows) => rows[0] ?? null);
  if (
    !key ||
    key.id !== context.keyId ||
    key.companyId !== context.companyId ||
    key.agentId !== context.actorId ||
    key.revokedAt
  ) {
    return false;
  }

  const agent = await db
    .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
    .from(agents)
    .where(eq(agents.id, context.actorId))
    .then((rows) => rows[0] ?? null);
  return Boolean(
    agent &&
    agent.id === context.actorId &&
    agent.companyId === context.companyId &&
    agent.status !== "terminated" &&
    agent.status !== "pending_approval"
  );
}
