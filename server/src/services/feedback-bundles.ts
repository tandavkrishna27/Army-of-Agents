import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  agents,
  feedbackExports,
  feedbackVotes,
  issueComments,
  issues,
} from "@armyofagents/db";
import type {
  FeedbackTargetType,
  FeedbackTraceTargetSummary,
  FeedbackVoteValue,
} from "@armyofagents/shared";
import { notFound, unprocessable } from "../errors.js";
import {
  createFeedbackRedactionState,
  type FeedbackRedactionState,
  finalizeFeedbackRedactionSummary,
  sanitizeFeedbackText,
  sanitizeFeedbackValue,
  sha256Digest,
} from "./feedback-redaction.js";

// Version constants — Paperclip parity. Keep in lockstep with Paperclip's
// server/src/services/feedback.ts so bundles produced by AoA and Paperclip are
// wire-compatible at the same schemaVersion / bundleVersion / payloadVersion.
export const FEEDBACK_SCHEMA_VERSION = "paperclip-feedback-envelope-v2";
export const FEEDBACK_BUNDLE_VERSION = "paperclip-feedback-bundle-v2";
export const FEEDBACK_PAYLOAD_VERSION = "paperclip-feedback-v1";

// Capture limits — Paperclip parity (feedback.ts:54-63). Tuned to stay under
// typical transmission endpoint body limits once F.D1 decision lands.
const FEEDBACK_CONTEXT_WINDOW = 3;
const MAX_EXCERPT_CHARS = 200;
const MAX_PRIMARY_CONTENT_CHARS = 8_000;
const MAX_CONTEXT_ITEM_BODY_CHARS = 3_000;
const MAX_TOTAL_CONTEXT_CHARS = 12_000;
const MAX_DESCRIPTION_CHARS = 1_200;

// Anonymization pepper — read at call time from env so rotation doesn't need a
// redeploy of the hot path. Fallback used in unit tests and local dev; any
// transmission destination MUST set AOA_FEEDBACK_ANONYMIZATION_PEPPER in prod.
export const FEEDBACK_ANONYMIZATION_PEPPER_ENV = "AOA_FEEDBACK_ANONYMIZATION_PEPPER";
export const FEEDBACK_ANONYMIZATION_FALLBACK_PEPPER = "aoa-feedback-anon-v1";

export function buildExportId(feedbackVoteId: string, sharedAt: Date): string {
  return `fbexp_${sha256Digest(`${feedbackVoteId}:${sharedAt.toISOString()}`).slice(0, 24)}`;
}

function truncateExcerpt(text: string, max = MAX_EXCERPT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function buildIssuePath(identifier: string | null): string | null {
  if (!identifier || identifier.trim().length === 0) return null;
  return `/tasks/${identifier}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BuildBundleInput {
  voteId: string;
  now?: Date;
}

export interface BuildBundleResult {
  feedbackExportId: string;
  exportId: string;
  payloadDigest: string;
  payloadSnapshot: Record<string, unknown>;
  targetSummary: FeedbackTraceTargetSummary;
  redactionSummary: Record<string, unknown>;
}

export interface FeedbackBundleRecord {
  id: string;
  companyId: string;
  feedbackVoteId: string;
  issueId: string;
  projectId: string | null;
  payloadSnapshot: Record<string, unknown>;
}

interface ResolvedVote {
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
  createdAt: Date;
  updatedAt: Date;
}

interface ResolvedIssue {
  id: string;
  companyId: string;
  projectId: string | null;
  identifier: string | null;
  title: string;
  description: string | null;
}

interface ResolvedTarget {
  targetType: FeedbackTargetType;
  targetId: string;
  label: string;
  body: string;
  createdAt: Date;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdByRunId: string | null;
  documentId: string | null;
  documentKey: string | null;
  documentTitle: string | null;
  revisionNumber: number | null;
  issuePath: string | null;
  targetPath: string | null;
  payloadTarget: Record<string, unknown>;
}

// ── buildBundle ───────────────────────────────────────────────────────────────

// buildBundle assembles a feedback bundle from a saved vote, applies redaction,
// and upserts a feedback_exports row with status='local_only'. Matches
// Paperclip's buildPayloadArtifacts (feedback.ts:1303) in shape and digest
// semantics. Key divergences from Paperclip (documented for auditors):
//
//   1. Paperclip builds the bundle *inside* the saveIssueVote transaction
//      (feedback.ts:2003). AoA F.2 ships vote capture separately (4a21c9b); F.3
//      adds buildBundle as a callable that takes an already-saved voteId. F.4
//      will wire this to recordVote post-commit when preference='allowed'.
//   2. Paperclip writes status='pending' when sharedWithLabs=true, else
//      'local_only' (feedback.ts:2034). F.3 always writes 'local_only' because
//      transmission destination is deferred (F.D1). F.4 updates status when
//      preference gating lands.
//   3. issue_comments in AoA has no createdByRunId column, so agentContext
//      cannot walk back to heartbeatRuns / costEvents. Paperclip's
//      buildAgentContext runtime block is therefore omitted. Comment this gap
//      upstream when CLI capture lands (follow-up noted in plan F.3).
//   4. AoA's agentInstructionsService does not exist — agentContext ships only
//      the agent record shape (id, name, role, title, status, adapterType).
//      Paperclip's skills + instructions blocks are skipped. Future parity:
//      port agent-instructions + cost summary when F.5 telemetry routing lands.

export async function buildBundle(
  db: Pick<Db, "select" | "insert">,
  input: BuildBundleInput,
): Promise<BuildBundleResult> {
  const now = input.now ?? new Date();

  const vote = await loadVote(db, input.voteId);
  if (!vote) throw notFound("Feedback vote not found");

  const issue = await loadIssue(db, vote.issueId);
  if (!issue) throw notFound("Issue not found for feedback vote");
  if (issue.companyId !== vote.companyId) throw notFound("Feedback vote / issue company mismatch");

  const target = await resolveTarget(db, vote, issue);

  const state = createFeedbackRedactionState();
  const exportId = buildExportId(vote.id, now);

  const primaryContent = buildPrimaryContent(target, state);
  const targetSummary = buildTargetSummary(target, primaryContent.excerpt);
  const issueContext = await buildIssueContext(db, issue, target, state);
  const agentContext = await buildAgentContext(db, issue.companyId, target.authorAgentId, state);

  const payloadWithoutSummary = {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    bundleVersion: FEEDBACK_BUNDLE_VERSION,
    payloadVersion: FEEDBACK_PAYLOAD_VERSION,
    sourceApp: "aoa",
    capturedAt: now.toISOString(),
    consentVersion: vote.consentVersion,
    vote: {
      id: vote.id,
      value: vote.vote,
      reason: vote.reason,
      authorUserId: vote.authorUserId,
      sharedWithLabs: vote.sharedWithLabs,
      sharedAt: vote.sharedAt ? vote.sharedAt.toISOString() : null,
    },
    target: target.payloadTarget,
    exportId,
    exportEligible: true,
    bundle: {
      primaryContent: primaryContent.content,
      issueContext,
      agentContext,
    },
  } satisfies Record<string, unknown>;

  const redactionSummary = finalizeFeedbackRedactionSummary(state);
  const payloadSnapshot = {
    ...payloadWithoutSummary,
    redactionSummary,
  };
  const payloadDigest = sha256Digest(payloadSnapshot);

  const [savedRow] = await db
    .insert(feedbackExports)
    .values({
      companyId: vote.companyId,
      feedbackVoteId: vote.id,
      issueId: issue.id,
      projectId: issue.projectId,
      authorUserId: vote.authorUserId,
      targetType: vote.targetType,
      targetId: vote.targetId,
      vote: vote.vote,
      status: "local_only",
      destination: null,
      exportId,
      consentVersion: vote.consentVersion,
      schemaVersion: FEEDBACK_SCHEMA_VERSION,
      bundleVersion: FEEDBACK_BUNDLE_VERSION,
      payloadVersion: FEEDBACK_PAYLOAD_VERSION,
      payloadDigest,
      payloadSnapshot,
      targetSummary,
      redactionSummary,
      attemptCount: 0,
      failureReason: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [feedbackExports.feedbackVoteId],
      set: {
        projectId: issue.projectId,
        targetType: vote.targetType,
        targetId: vote.targetId,
        vote: vote.vote,
        status: "local_only",
        destination: null,
        exportId,
        consentVersion: vote.consentVersion,
        schemaVersion: FEEDBACK_SCHEMA_VERSION,
        bundleVersion: FEEDBACK_BUNDLE_VERSION,
        payloadVersion: FEEDBACK_PAYLOAD_VERSION,
        payloadDigest,
        payloadSnapshot,
        targetSummary,
        redactionSummary,
        failureReason: null,
        updatedAt: now,
      },
    })
    .returning({ id: feedbackExports.id });

  return {
    feedbackExportId: savedRow.id,
    exportId,
    payloadDigest,
    payloadSnapshot,
    targetSummary,
    redactionSummary,
  };
}

// ── Loaders ───────────────────────────────────────────────────────────────────

async function loadVote(
  db: Pick<Db, "select">,
  voteId: string,
): Promise<ResolvedVote | null> {
  const rows = await db
    .select({
      id: feedbackVotes.id,
      companyId: feedbackVotes.companyId,
      issueId: feedbackVotes.issueId,
      targetType: feedbackVotes.targetType,
      targetId: feedbackVotes.targetId,
      authorUserId: feedbackVotes.authorUserId,
      vote: feedbackVotes.vote,
      reason: feedbackVotes.reason,
      sharedWithLabs: feedbackVotes.sharedWithLabs,
      sharedAt: feedbackVotes.sharedAt,
      consentVersion: feedbackVotes.consentVersion,
      createdAt: feedbackVotes.createdAt,
      updatedAt: feedbackVotes.updatedAt,
    })
    .from(feedbackVotes)
    .where(eq(feedbackVotes.id, voteId));
  return (rows[0] as ResolvedVote | undefined) ?? null;
}

async function loadIssue(
  db: Pick<Db, "select">,
  issueId: string,
): Promise<ResolvedIssue | null> {
  const rows = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      projectId: issues.projectId,
      identifier: issues.identifier,
      title: issues.title,
      description: issues.description,
    })
    .from(issues)
    .where(eq(issues.id, issueId));
  return (rows[0] as ResolvedIssue | undefined) ?? null;
}

async function resolveTarget(
  db: Pick<Db, "select">,
  vote: ResolvedVote,
  issue: ResolvedIssue,
): Promise<ResolvedTarget> {
  const issuePath = buildIssuePath(issue.identifier);

  // AoA F.2 MVP ports "issue_comment" only (shared/types/feedback.ts:13).
  // Paperclip also supports "issue_document_revision" (feedback.ts:844) — add
  // here once F.2 UI + schema extend the target union.
  if (vote.targetType === "issue_comment") {
    const rows = await db
      .select({
        id: issueComments.id,
        issueId: issueComments.issueId,
        companyId: issueComments.companyId,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
        body: issueComments.body,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(eq(issueComments.id, vote.targetId));

    const comment = rows[0] as
      | {
          id: string;
          issueId: string;
          companyId: string;
          authorAgentId: string | null;
          authorUserId: string | null;
          body: string;
          createdAt: Date;
        }
      | undefined;

    if (!comment || comment.issueId !== issue.id || comment.companyId !== issue.companyId) {
      throw notFound("Feedback target not found");
    }
    if (!comment.authorAgentId) {
      // Matches Paperclip's guard (feedback.ts:811) — thumbs only appear on
      // agent-authored comments; human-authored comments can't receive votes.
      throw unprocessable("Feedback voting is only available on agent-authored issue comments");
    }

    return {
      targetType: "issue_comment",
      targetId: comment.id,
      label: "Comment",
      body: comment.body,
      createdAt: comment.createdAt,
      authorAgentId: comment.authorAgentId,
      authorUserId: comment.authorUserId,
      createdByRunId: null,
      documentId: null,
      documentKey: null,
      documentTitle: null,
      revisionNumber: null,
      issuePath,
      targetPath: issuePath ? `${issuePath}#comment-${comment.id}` : null,
      payloadTarget: {
        type: "issue_comment",
        id: comment.id,
        createdAt: comment.createdAt.toISOString(),
        authorAgentId: comment.authorAgentId,
        authorUserId: comment.authorUserId,
        createdByRunId: null,
        issuePath,
        targetPath: issuePath ? `${issuePath}#comment-${comment.id}` : null,
      },
    };
  }

  throw unprocessable(`Unsupported feedback target type: ${vote.targetType}`);
}

// ── Bundle builders ───────────────────────────────────────────────────────────

function buildPrimaryContent(
  target: ResolvedTarget,
  state: FeedbackRedactionState,
): { content: Record<string, unknown>; excerpt: string } {
  const body = sanitizeFeedbackText(
    target.body,
    state,
    "bundle.primaryContent.body",
    MAX_PRIMARY_CONTENT_CHARS,
  );
  const excerpt = truncateExcerpt(body);
  return {
    excerpt,
    content: {
      type: target.targetType,
      id: target.targetId,
      label: target.label,
      createdAt: target.createdAt.toISOString(),
      authorAgentId: target.authorAgentId,
      authorUserId: target.authorUserId,
      createdByRunId: target.createdByRunId,
      documentId: target.documentId,
      documentKey: target.documentKey,
      documentTitle: target.documentTitle,
      revisionNumber: target.revisionNumber,
      targetPath: target.targetPath,
      body,
      excerpt,
    },
  };
}

function buildTargetSummary(target: ResolvedTarget, excerpt: string): FeedbackTraceTargetSummary {
  return {
    label: target.label,
    excerpt,
    authorAgentId: target.authorAgentId,
    authorUserId: target.authorUserId,
    createdAt: target.createdAt,
    documentKey: target.documentKey,
    documentTitle: target.documentTitle,
    revisionNumber: target.revisionNumber,
  };
}

async function buildIssueContext(
  db: Pick<Db, "select">,
  issue: ResolvedIssue,
  target: ResolvedTarget,
  state: FeedbackRedactionState,
): Promise<Record<string, unknown>> {
  const rows = await db
    .select({
      id: issueComments.id,
      body: issueComments.body,
      createdAt: issueComments.createdAt,
      authorAgentId: issueComments.authorAgentId,
      authorUserId: issueComments.authorUserId,
    })
    .from(issueComments)
    .where(and(eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id)))
    .orderBy(asc(issueComments.createdAt));

  const items = rows as Array<{
    id: string;
    body: string;
    createdAt: Date;
    authorAgentId: string | null;
    authorUserId: string | null;
  }>;

  const targetIndex = items.findIndex((item) => item.id === target.targetId);
  const before = targetIndex >= 0
    ? items.slice(Math.max(0, targetIndex - FEEDBACK_CONTEXT_WINDOW), targetIndex)
    : [];
  const after = targetIndex >= 0
    ? items.slice(targetIndex + 1, targetIndex + 1 + FEEDBACK_CONTEXT_WINDOW)
    : [];

  const issuePath = buildIssuePath(issue.identifier);

  let remainingChars = MAX_TOTAL_CONTEXT_CHARS;
  const serialized = [...before.map((item) => ({ ...item, relation: "before" as const })),
                      ...after.map((item) => ({ ...item, relation: "after" as const }))]
    .map((item, index) => {
      if (remainingChars <= 0) {
        state.omittedFields.add("bundle.issueContext.items");
        return null;
      }
      const maxChars = Math.min(MAX_CONTEXT_ITEM_BODY_CHARS, remainingChars);
      const body = sanitizeFeedbackText(
        item.body,
        state,
        `bundle.issueContext.items.${index}.body`,
        maxChars,
      );
      remainingChars -= body.length;
      return {
        type: "issue_comment" as const,
        id: item.id,
        label: "Comment",
        relation: item.relation,
        createdAt: item.createdAt.toISOString(),
        authorAgentId: item.authorAgentId,
        authorUserId: item.authorUserId,
        createdByRunId: null,
        documentKey: null,
        documentTitle: null,
        revisionNumber: null,
        targetPath: issuePath ? `${issuePath}#comment-${item.id}` : null,
        body,
        excerpt: truncateExcerpt(body),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const descriptionExcerpt = issue.description
    ? truncateExcerpt(
        sanitizeFeedbackText(
          issue.description,
          state,
          "bundle.issueContext.issue.description",
          MAX_DESCRIPTION_CHARS,
        ),
        MAX_DESCRIPTION_CHARS,
      )
    : null;

  return {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      projectId: issue.projectId,
      path: issuePath,
      descriptionExcerpt,
    },
    items: serialized,
  };
}

async function buildAgentContext(
  db: Pick<Db, "select">,
  companyId: string,
  authorAgentId: string | null,
  state: FeedbackRedactionState,
): Promise<Record<string, unknown> | null> {
  if (!authorAgentId) {
    state.notes.add("author_agent_missing");
    return null;
  }

  const rows = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      role: agents.role,
      title: agents.title,
      status: agents.status,
      adapterType: agents.adapterType,
    })
    .from(agents)
    .where(eq(agents.id, authorAgentId));

  const agent = rows[0] as
    | {
        id: string;
        companyId: string;
        name: string;
        role: string;
        title: string | null;
        status: string;
        adapterType: string;
      }
    | undefined;

  if (!agent || agent.companyId !== companyId) {
    state.notes.add("author_agent_unavailable");
    return null;
  }

  // AoA-only-scope: no runtime/skills/instructions block. Paperclip's
  // buildAgentContext (feedback.ts:1053) enriches with heartbeatRun + skills +
  // instructions; AoA ships the agent card only until F.5 wires telemetry.
  return sanitizeFeedbackValue(
    {
      agent: {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        title: agent.title,
        status: agent.status,
        adapterType: agent.adapterType,
      },
      paperclip: {
        schemaVersion: FEEDBACK_SCHEMA_VERSION,
        bundleVersion: FEEDBACK_BUNDLE_VERSION,
      },
    },
    state,
    "bundle.agentContext",
    400,
  ) as Record<string, unknown>;
}

// ── listExports (F.4) ─────────────────────────────────────────────────────────

// Compact shape returned to the UI (PrivacyTab "Recent shared bundles" section
// + any admin listing). Deliberately omits payloadSnapshot — it can contain
// redacted identifiers and internal structure that the UI doesn't need and that
// shouldn't leak via list endpoints. sizeBytes is a rough proxy for "how much
// content left this instance" (computed from payload JSON, not gzipped bytes —
// gzipped file size lives on disk and isn't cheap to aggregate).
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
  createdAt: Date;
  sizeBytes: number;
}

export interface ListExportsOptions {
  companyId?: string;
  limit?: number;
}

const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 50;

function estimateSnapshotSize(snapshot: unknown): number {
  if (snapshot == null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  } catch {
    return 0;
  }
}

export async function listExports(
  db: Pick<Db, "select">,
  options: ListExportsOptions = {},
): Promise<FeedbackExportSummary[]> {
  const requested = options.limit ?? DEFAULT_LIST_LIMIT;
  const limit = Math.min(Math.max(requested, 1), MAX_LIST_LIMIT);
  const conditions = options.companyId
    ? [eq(feedbackExports.companyId, options.companyId)]
    : [];

  const query = db
    .select({
      id: feedbackExports.id,
      exportId: feedbackExports.exportId,
      companyId: feedbackExports.companyId,
      issueId: feedbackExports.issueId,
      projectId: feedbackExports.projectId,
      authorUserId: feedbackExports.authorUserId,
      vote: feedbackExports.vote,
      status: feedbackExports.status,
      destination: feedbackExports.destination,
      createdAt: feedbackExports.createdAt,
      payloadSnapshot: feedbackExports.payloadSnapshot,
    })
    .from(feedbackExports);

  const filtered = conditions.length > 0 ? query.where(and(...conditions)) : query;
  const rows = await filtered.orderBy(desc(feedbackExports.createdAt)).limit(limit);

  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as string,
    exportId: (row.exportId as string | null) ?? null,
    companyId: row.companyId as string,
    issueId: row.issueId as string,
    projectId: (row.projectId as string | null) ?? null,
    authorUserId: row.authorUserId as string,
    vote: row.vote as FeedbackVoteValue,
    status: row.status as string,
    destination: (row.destination as string | null) ?? null,
    createdAt: row.createdAt as Date,
    sizeBytes: estimateSnapshotSize(row.payloadSnapshot),
  }));
}

// ── Anonymization (pure) ──────────────────────────────────────────────────────

// Deterministic namespaced hash. Kind scopes the hash so the same underlying
// value (e.g. a UUID shared by a userId + agentId in some system) produces
// distinct anonymized forms. Pepper lets operators rotate the hash namespace
// without invalidating historical export compatibility.
export function hashIdentityValue(kind: string, value: string, pepper: string): string {
  const hex = createHash("sha256").update(`${pepper}:${kind}:${value}`).digest("hex").slice(0, 16);
  return `${kind}_${hex}`;
}

function resolvePepper(override?: string): string {
  if (typeof override === "string" && override.length > 0) return override;
  const fromEnv = process.env[FEEDBACK_ANONYMIZATION_PEPPER_ENV];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return FEEDBACK_ANONYMIZATION_FALLBACK_PEPPER;
}

export interface AnonymizeOptions {
  pepper?: string;
}

// Pure. Takes a persisted bundle record and returns a transmission-ready copy
// with identifying fields replaced by namespaced hashes and human-readable
// strings stripped. NOT called by F.3 — wired when the transmission pipeline
// lands (F.D1 deferred to Phase I). Kept here as a unit-testable function so
// the destination decision can snap it in without a design round-trip.
//
// Strategy (plan F.D3):
//   - Hash: companyId, vote.authorUserId, authorAgentId, authorUserId wherever
//     it appears in the payload (primaryContent, issueContext.items, agentContext).
//   - Strip: agent name/title, issue title/identifier/path (human-readable).
//   - Strip: vote.reason (free-text that can leak names, claim text, URLs).
//   - Preserve: ids that stay opaque post-hash (issue.id, projectId),
//     non-identifying enums (role, adapterType, status), versions, timestamps.
export function anonymizeForTransmission(
  bundle: FeedbackBundleRecord,
  options: AnonymizeOptions = {},
): FeedbackBundleRecord {
  const pepper = resolvePepper(options.pepper);
  const hashUser = (v: string | null) => (v == null ? null : hashIdentityValue("user", v, pepper));
  const hashCompany = (v: string | null) => (v == null ? null : hashIdentityValue("company", v, pepper));
  const hashAgent = (v: string | null) => (v == null ? null : hashIdentityValue("agent", v, pepper));

  const snapshot = bundle.payloadSnapshot;

  const voteBlock = (snapshot.vote ?? {}) as Record<string, unknown>;
  const targetBlock = (snapshot.target ?? {}) as Record<string, unknown>;
  const bundleBlock = (snapshot.bundle ?? null) as Record<string, unknown> | null;

  const anonymizedVote = {
    ...voteBlock,
    authorUserId: hashUser(voteBlock.authorUserId as string | null),
    reason: null,
  };

  const anonymizedTarget = {
    ...targetBlock,
    authorAgentId: hashAgent(targetBlock.authorAgentId as string | null),
    authorUserId: hashUser(targetBlock.authorUserId as string | null),
  };

  let anonymizedBundle: Record<string, unknown> | null = null;
  if (bundleBlock) {
    const primary = (bundleBlock.primaryContent ?? {}) as Record<string, unknown>;
    const issueCtx = (bundleBlock.issueContext ?? {}) as Record<string, unknown>;
    const agentCtx = (bundleBlock.agentContext ?? null) as Record<string, unknown> | null;

    const anonymizedPrimary = {
      ...primary,
      authorAgentId: hashAgent(primary.authorAgentId as string | null),
      authorUserId: hashUser(primary.authorUserId as string | null),
    };

    const issueRec = (issueCtx.issue ?? {}) as Record<string, unknown>;
    const items = Array.isArray(issueCtx.items) ? (issueCtx.items as Array<Record<string, unknown>>) : [];
    const anonymizedIssue = {
      id: issueRec.id ?? null,
      identifier: null,
      title: null,
      projectId: issueRec.projectId ?? null,
      path: null,
      descriptionExcerpt: null,
    };
    const anonymizedItems = items.map((item) => ({
      ...item,
      authorAgentId: hashAgent(item.authorAgentId as string | null),
      authorUserId: hashUser(item.authorUserId as string | null),
    }));

    let anonymizedAgentCtx: Record<string, unknown> | null = null;
    if (agentCtx) {
      const agentRec = (agentCtx.agent ?? {}) as Record<string, unknown>;
      anonymizedAgentCtx = {
        ...agentCtx,
        agent: {
          ...agentRec,
          id: hashAgent(agentRec.id as string | null),
          name: null,
          title: null,
        },
      };
    }

    anonymizedBundle = {
      primaryContent: anonymizedPrimary,
      issueContext: {
        issue: anonymizedIssue,
        items: anonymizedItems,
      },
      agentContext: anonymizedAgentCtx,
    };
  }

  const anonymizedSnapshot: Record<string, unknown> = {
    ...snapshot,
    vote: anonymizedVote,
    target: anonymizedTarget,
    bundle: anonymizedBundle,
  };

  return {
    ...bundle,
    companyId: hashCompany(bundle.companyId) as string,
    payloadSnapshot: anonymizedSnapshot,
  };
}
