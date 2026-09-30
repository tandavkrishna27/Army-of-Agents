import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { feedbackVotes } from "@armyofagents/db";
import type {
  FeedbackDataSharingPreference,
  FeedbackTargetType,
  FeedbackVote,
  FeedbackVoteSummary,
  FeedbackVoteValue,
} from "@armyofagents/shared";
import { forbidden, notFound } from "../errors.js";

// Paperclip's `normalizeReason` (paperclip-master/server/src/services/feedback.ts:192):
// reason is persisted only for downvotes. Upvote reasons are discarded — if a user
// wants to leave positive feedback context, Paperclip uses task comments, not votes.
// Match source so data shape is identical between providers.
function normalizeReason(vote: FeedbackVoteValue, reason: string | null | undefined) {
  if (vote !== "down" || typeof reason !== "string") return null;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface RecordVoteInput {
  companyId: string;
  authorUserId: string;
  issueId: string;
  targetType: FeedbackTargetType;
  targetId: string;
  vote: FeedbackVoteValue;
  reason?: string | null;
}

export interface ListVotesFilters {
  companyId: string;
  authorUserId?: string;
  issueId?: string;
  targetType?: FeedbackTargetType;
  targetId?: string;
  since?: Date;
}

export interface VoteSummaryInput {
  companyId: string;
  issueId?: string;
  targetType: FeedbackTargetType;
  targetId: string;
}

// F.4 preference-gating hook. The route layer supplies these so the service
// stays composable: getFeedbackSharingPreference reads instance settings;
// onVoteShared runs the bundle build + local share write. Both optional —
// omitting them preserves F.2 behavior (capture-only) for older call sites.
// Fire-and-forget: recordVote never awaits onVoteShared; failures go to
// logger.warn so operators see them but the API response is never blocked.
export interface FeedbackVotesServiceDeps {
  getFeedbackSharingPreference?: () => Promise<FeedbackDataSharingPreference>;
  onVoteShared?: (voteId: string) => Promise<unknown>;
  logger?: { warn: (message: string, meta?: unknown) => void };
}

export function feedbackVotesService(db: Db, deps: FeedbackVotesServiceDeps = {}) {
  const { getFeedbackSharingPreference, onVoteShared, logger } = deps;
  const hookEnabled = Boolean(getFeedbackSharingPreference && onVoteShared);

  function scheduleShareIfAllowed(voteId: string): void {
    if (!hookEnabled) return;
    void getFeedbackSharingPreference!()
      .then((preference) => {
        if (preference === "allowed") {
          return onVoteShared!(voteId);
        }
        return null;
      })
      .catch((err: unknown) => {
        logger?.warn("feedback bundle build failed", { voteId, err });
      });
  }

  return {
    getById: async (voteId: string): Promise<FeedbackVote | null> => {
      const rows = await db
        .select()
        .from(feedbackVotes)
        .where(eq(feedbackVotes.id, voteId))
        .limit(1);
      return (rows[0] ?? null) as FeedbackVote | null;
    },

    recordVote: async (input: RecordVoteInput): Promise<FeedbackVote> => {
      const now = new Date();
      const normalizedReason = normalizeReason(input.vote, input.reason);

      const [saved] = await db
        .insert(feedbackVotes)
        .values({
          companyId: input.companyId,
          issueId: input.issueId,
          targetType: input.targetType,
          targetId: input.targetId,
          authorUserId: input.authorUserId,
          vote: input.vote,
          reason: normalizedReason,
          sharedWithLabs: false,
          sharedAt: null,
          consentVersion: null,
          redactionSummary: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            feedbackVotes.companyId,
            feedbackVotes.targetType,
            feedbackVotes.targetId,
            feedbackVotes.authorUserId,
          ],
          set: {
            vote: input.vote,
            reason: normalizedReason,
            updatedAt: now,
          },
        })
        .returning();
      const vote = saved as FeedbackVote;
      scheduleShareIfAllowed(vote.id);
      return vote;
    },

    listVotes: async (filters: ListVotesFilters): Promise<FeedbackVote[]> => {
      const conditions = [eq(feedbackVotes.companyId, filters.companyId)];
      if (filters.authorUserId) conditions.push(eq(feedbackVotes.authorUserId, filters.authorUserId));
      if (filters.issueId) conditions.push(eq(feedbackVotes.issueId, filters.issueId));
      if (filters.targetType) conditions.push(eq(feedbackVotes.targetType, filters.targetType));
      if (filters.targetId) conditions.push(eq(feedbackVotes.targetId, filters.targetId));
      if (filters.since) conditions.push(gte(feedbackVotes.createdAt, filters.since));

      const rows = await db
        .select()
        .from(feedbackVotes)
        .where(and(...conditions))
        .orderBy(desc(feedbackVotes.createdAt));
      return rows as FeedbackVote[];
    },

    dismissVote: async (voteId: string, authorUserId: string): Promise<void> => {
      const existing = await db
        .select()
        .from(feedbackVotes)
        .where(eq(feedbackVotes.id, voteId))
        .then((rows) => rows[0] ?? null);
      if (!existing) {
        throw notFound("Feedback vote not found");
      }
      if (existing.authorUserId !== authorUserId) {
        throw forbidden("Only the vote's author can dismiss it");
      }
      await db.delete(feedbackVotes).where(eq(feedbackVotes.id, voteId));
    },

    voteSummaryForTarget: async (input: VoteSummaryInput): Promise<FeedbackVoteSummary> => {
      const conditions = [
        eq(feedbackVotes.companyId, input.companyId),
        eq(feedbackVotes.targetType, input.targetType),
        eq(feedbackVotes.targetId, input.targetId),
      ];
      if (input.issueId) conditions.push(eq(feedbackVotes.issueId, input.issueId));

      const rows = await db
        .select({ vote: feedbackVotes.vote })
        .from(feedbackVotes)
        .where(and(...conditions));

      let ups = 0;
      let downs = 0;
      for (const row of rows) {
        if (row.vote === "up") ups += 1;
        else if (row.vote === "down") downs += 1;
      }
      return { ups, downs, total: ups + downs };
    },
  };
}
