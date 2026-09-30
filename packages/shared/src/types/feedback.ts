export const FEEDBACK_DATA_SHARING_PREFERENCES = ["allowed", "not_allowed", "prompt"] as const;
export type FeedbackDataSharingPreference = (typeof FEEDBACK_DATA_SHARING_PREFERENCES)[number];

// AoA privacy-first default: "not_allowed".
// Paperclip defaults to "prompt" (asks user on first feedback action). AoA opts users out
// until they explicitly opt in. The feedback/telemetry subsystem itself lands in Phase F;
// this constant only controls the instance-settings default at Phase A.7.
export const DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE: FeedbackDataSharingPreference = "not_allowed";

// F.2 MVP ports only "issue_comment" — covers agent output comments on tasks, the primary
// feedback surface on TaskSlideOver. Paperclip also defines "issue_document_revision"
// for document revisions; deferred to Phase I polish along with artifact-version votes.
export const FEEDBACK_TARGET_TYPES = ["issue_comment"] as const;
export type FeedbackTargetType = (typeof FEEDBACK_TARGET_TYPES)[number];

export const FEEDBACK_VOTE_VALUES = ["up", "down"] as const;
export type FeedbackVoteValue = (typeof FEEDBACK_VOTE_VALUES)[number];

export interface FeedbackVote {
  id: string;
  companyId: string;
  issueId: string;
  targetType: FeedbackTargetType;
  targetId: string;
  authorUserId: string;
  vote: FeedbackVoteValue;
  reason: string | null;
  sharedWithLabs: boolean;
  sharedAt: Date | null;
  consentVersion: string | null;
  redactionSummary: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FeedbackVoteSummary {
  ups: number;
  downs: number;
  total: number;
}

export type FeedbackRedactionState = {
  redactedFields: Set<string>;
  truncatedFields: Set<string>;
  omittedFields: Set<string>;
  notes: Set<string>;
  counts: Map<string, number>;
};

export type FeedbackRedactionSummary = {
  strategy: string;
  redactedFields: string[];
  truncatedFields: string[];
  omittedFields: string[];
  notes: string[];
  counts: Record<string, number>;
};

// Persisted into feedback_exports.target_summary (jsonb, NOT NULL). Matches
// Paperclip's FeedbackTraceTargetSummary shape so future transmission endpoints
// can consume AoA bundles without per-source schema adapters.
export interface FeedbackTraceTargetSummary {
  label: string;
  excerpt: string | null;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: Date | null;
  documentKey: string | null;
  documentTitle: string | null;
  revisionNumber: number | null;
}

// F.4 bundle history row returned by `GET /feedback/exports`. Compact shape —
// omits payloadSnapshot + redactionSummary since those can contain redacted
// identifiers and internal structure the PrivacyTab list view doesn't need.
// sizeBytes is a JSON-byte estimate, not a gzipped-file size.
export interface FeedbackExportSummary {
  id: string;
  exportId: string | null;
  companyId: string;
  issueId: string;
  projectId: string | null;
  authorUserId: string;
  vote: FeedbackVoteValue;
  status: string;
  destination: string | null;
  createdAt: string;
  sizeBytes: number;
}
