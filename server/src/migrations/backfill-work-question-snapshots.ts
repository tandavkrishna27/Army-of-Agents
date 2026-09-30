import { and, eq, isNull, or } from "drizzle-orm";
import { agents, issues, workQuestions, type Db } from "@armyofagents/db";

interface WorkQuestionSnapshotSource {
  issueIdentifierSnapshot: string | null;
  issueTitleSnapshot: string | null;
  askingAgentNameSnapshot: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  askingAgentName: string | null;
}

export function buildWorkQuestionSnapshotPatch(source: WorkQuestionSnapshotSource) {
  const patch: {
    issueIdentifierSnapshot?: string;
    issueTitleSnapshot?: string;
    askingAgentNameSnapshot?: string;
    updatedAt?: Date;
  } = {};

  if (!source.issueIdentifierSnapshot && source.issueIdentifier) {
    patch.issueIdentifierSnapshot = source.issueIdentifier;
  }
  if (!source.issueTitleSnapshot && source.issueTitle) {
    patch.issueTitleSnapshot = source.issueTitle;
  }
  if (!source.askingAgentNameSnapshot && source.askingAgentName) {
    patch.askingAgentNameSnapshot = source.askingAgentName;
  }
  if (Object.keys(patch).length > 0) patch.updatedAt = new Date();
  return patch;
}

/**
 * Preserve human-readable identity for questions created before snapshot
 * columns shipped. Await this before serving requests so later FK set-null
 * behavior cannot erase the last useful task or agent label.
 */
export async function backfillWorkQuestionSnapshots(db: Db): Promise<{ updated: number }> {
  const rows = await db
    .select({
      id: workQuestions.id,
      companyId: workQuestions.companyId,
      issueIdentifierSnapshot: workQuestions.issueIdentifierSnapshot,
      issueTitleSnapshot: workQuestions.issueTitleSnapshot,
      askingAgentNameSnapshot: workQuestions.askingAgentNameSnapshot,
      issueIdentifier: issues.identifier,
      issueTitle: issues.title,
      askingAgentName: agents.name,
    })
    .from(workQuestions)
    .leftJoin(issues, and(
      eq(issues.companyId, workQuestions.companyId),
      eq(issues.id, workQuestions.issueId),
    ))
    .leftJoin(agents, and(
      eq(agents.companyId, workQuestions.companyId),
      eq(agents.id, workQuestions.askingAgentId),
    ))
    .where(or(
      isNull(workQuestions.issueIdentifierSnapshot),
      isNull(workQuestions.issueTitleSnapshot),
      isNull(workQuestions.askingAgentNameSnapshot),
    ));

  let updated = 0;
  for (const row of rows) {
    const patch = buildWorkQuestionSnapshotPatch(row);
    if (Object.keys(patch).length === 0) continue;
    await db
      .update(workQuestions)
      .set(patch)
      .where(and(
        eq(workQuestions.companyId, row.companyId),
        eq(workQuestions.id, row.id),
      ));
    updated += 1;
  }
  return { updated };
}
