import { and, asc, eq } from "drizzle-orm";
import { companyMemberships, userRoles, type Db } from "@armyofagents/db";
import type { IssueReviewerSource } from "@armyofagents/shared";
import { notFound, unprocessable } from "../errors.js";

async function assertActiveCompanyUser(db: Db, companyId: string, userId: string, subject: string) {
  const membership = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId),
      eq(companyMemberships.status, "active"),
    ))
    .then((rows) => rows[0] ?? null);
  if (!membership) throw notFound(`${subject} not found`);
}

async function findRoleHolder(
  db: Db,
  input: { companyId: string; role: "team_lead" | "founder"; projectId?: string | null },
): Promise<string | null> {
  const conditions = [eq(userRoles.companyId, input.companyId), eq(userRoles.role, input.role)];
  if (input.role === "team_lead") {
    if (!input.projectId) return null;
    conditions.push(eq(userRoles.projectId, input.projectId));
  }
  return db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(
      companyMemberships,
      and(
        eq(companyMemberships.companyId, userRoles.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userRoles.userId),
        eq(companyMemberships.status, "active"),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(userRoles.createdAt))
    .then((rows) => rows[0]?.userId ?? null);
}

export async function resolveIssueReviewer(
  db: Db,
  input: {
    companyId: string;
    projectId: string | null;
    explicitReviewerUserId: string | null;
    existingReviewerSource: string | null;
    responsibleUserId: string | null;
  },
): Promise<{ reviewerUserId: string; reviewerSource: IssueReviewerSource }> {
  if (input.explicitReviewerUserId) {
    await assertActiveCompanyUser(db, input.companyId, input.explicitReviewerUserId, "Reviewer user");
    const persistedSource = ["explicit", "responsible", "scope_lead", "founder"]
      .includes(input.existingReviewerSource ?? "")
      ? input.existingReviewerSource as IssueReviewerSource
      : "explicit";
    return { reviewerUserId: input.explicitReviewerUserId, reviewerSource: persistedSource };
  }
  if (input.responsibleUserId) {
    await assertActiveCompanyUser(db, input.companyId, input.responsibleUserId, "Responsible user");
    return { reviewerUserId: input.responsibleUserId, reviewerSource: "responsible" };
  }
  const scopeLead = await findRoleHolder(db, {
    companyId: input.companyId,
    role: "team_lead",
    projectId: input.projectId,
  });
  if (scopeLead) return { reviewerUserId: scopeLead, reviewerSource: "scope_lead" };

  const founder = await findRoleHolder(db, { companyId: input.companyId, role: "founder" });
  if (founder) return { reviewerUserId: founder, reviewerSource: "founder" };

  throw unprocessable("Task cannot enter review because no eligible human reviewer is available", {
    code: "reviewer_unavailable",
  });
}
