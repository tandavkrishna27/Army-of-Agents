import type {
  FeedbackExportSummary,
  FeedbackTargetType,
  FeedbackVote,
  FeedbackVoteSummary,
  FeedbackVoteValue,
} from "@armyofagents/shared";
import { api } from "./client";

export interface RecordVoteBody {
  targetType: FeedbackTargetType;
  targetId: string;
  vote: FeedbackVoteValue;
  reason?: string;
}

export const feedbackApi = {
  recordVote: (issueId: string, body: RecordVoteBody) =>
    api.post<FeedbackVote>(`/issues/${issueId}/feedback-votes`, body),

  listVotes: (issueId: string) =>
    api.get<FeedbackVote[]>(`/issues/${issueId}/feedback-votes`),

  summary: (issueId: string, targetType: FeedbackTargetType, targetId: string) => {
    const qs = new URLSearchParams({ targetType, targetId }).toString();
    return api.get<FeedbackVoteSummary>(`/issues/${issueId}/feedback-votes/summary?${qs}`);
  },

  dismissVote: (voteId: string) =>
    api.delete<void>(`/feedback-votes/${voteId}`),

  listExports: (limit = 3) =>
    api.get<FeedbackExportSummary[]>(`/feedback/exports?limit=${limit}`),
};
