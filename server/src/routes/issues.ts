import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { discussions, type Db } from "@armyofagents/db";
import { and, eq } from "drizzle-orm";
import {
  addIssueCommentSchema,
  createIssueAttachmentMetadataSchema,
  createIssueLabelSchema,
  checkoutIssueSchema,
  createIssueSchema,
  linkIssueApprovalSchema,
  updateIssueSchema,
} from "@armyofagents/shared";
import type { StorageService } from "../storage/types.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  goalService,
  heartbeatService,
  issueApprovalService,
  issueService,
  logActivity,
  memoryLifecycleService,
  projectService,
  routineService,
} from "../services/index.js";

import { logger } from "../middleware/logger.js";
import { forbidden, HttpError, unauthorized, unprocessable } from "../errors.js";
import { accessibleCompanyIdsForActor, assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { resolveStorageTenant } from "./authz-tenant.js";
import { shouldWakeAssigneeOnCheckout } from "./issues-checkout-wakeup.js";
import { shouldDispatchIssueWakeup } from "./issues-planning-mode-dispatch.js";
import { enqueueIssueAssigneeWakeup } from "../services/issue-assignee-wakeup.js";
import { documentService } from "../services/documents.js";
import { getSafeServingHeaders } from "../services/asset-serving-safety.js";
import { sniffAndVerifyContentType } from "../services/asset-content-guard.js";
import { issueDocumentKeySchema, upsertIssueDocumentSchema } from "@armyofagents/shared";
import { createEagerWorkspaceForIssue } from "../services/eager-workspace.js";
import { COMMENT_WAKEUP_DEFER_GRACE_MS, type CommentWakeupTarget } from "../services/comment-wakeup-outbox.js";
import { canDelegateToTarget, type WakeSkippedReason } from "../services/task-policy.js";
import {
  listIssueContextBundlesForIssue,
  setIssueContextBundleItemIncluded,
} from "../services/issue-context-bundles.js";
import { assertCanOverrideTaskWorkspace } from "../services/workspace-authz.js";
import { assertAgentInReviewReviewPath } from "../services/issue-agent-status-guard.js";
import { assertRole } from "../middleware/rbac.js";

// Re-exported from the shared guard module so existing import paths
// (e.g. agent-in-review-guard.test.ts importing from "../routes/issues.js")
// keep resolving after the move to server/src/services/.
export { assertAgentInReviewReviewPath };

export function normalizeIssueDateFields<T extends Record<string, unknown>>(fields: T): T {
  if (!Object.prototype.hasOwnProperty.call(fields, "dueDate")) return fields;
  const dueDate = fields.dueDate;
  return {
    ...fields,
    dueDate: typeof dueDate === "string" ? new Date(dueDate) : dueDate,
  };
}

function hasWorkspaceOverrideFields(body: Record<string, unknown>): boolean {
  return body.executionWorkspaceId !== undefined
    || body.executionWorkspacePreference !== undefined
    || body.executionWorkspaceSettings !== undefined;
}

function workspaceOverrideAuditDetails(body: Record<string, unknown>) {
  if (!hasWorkspaceOverrideFields(body)) return undefined;
  return {
    executionWorkspaceId: body.executionWorkspaceId ?? null,
    preference: body.executionWorkspacePreference ?? null,
    settings: body.executionWorkspaceSettings ?? null,
  };
}

const MAX_ATTACHMENT_BYTES = Number(process.env.AOA_ATTACHMENT_MAX_BYTES) || 10 * 1024 * 1024;
const ALLOWED_ATTACHMENT_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/pdf",
]);
const MAX_ATTACHMENTS_PER_COMMENT = Number(process.env.AOA_ATTACHMENTS_PER_COMMENT_MAX) || 5;

export function issueRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const svc = issueService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db);
  const agentsSvc = agentService(db);
  const projectsSvc = projectService(db);
  const goalsSvc = goalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const documentsSvc = documentService(db);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });
  const multiFileUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: MAX_ATTACHMENTS_PER_COMMENT },
  });

  function withContentPath<T extends { id: string }>(attachment: T) {
    return {
      ...attachment,
      contentPath: `/api/attachments/${attachment.id}/content`,
    };
  }

  async function runSingleFileUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function runMultiFileUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      multiFileUpload.array("files", MAX_ATTACHMENTS_PER_COMMENT)(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  function validateAttachmentFile(file: { mimetype: string; buffer: Buffer }) {
    const contentType = (file.mimetype || "").toLowerCase();
    if (!ALLOWED_ATTACHMENT_CONTENT_TYPES.has(contentType)) {
      throw unprocessable(`Unsupported attachment type: ${contentType || "unknown"}`);
    }
    if (file.buffer.length <= 0) {
      throw unprocessable("Attachment is empty");
    }
    return contentType;
  }

  // P2 (PR #291 round-3 review): allowlist + byte-sniff a task-comment
  // attachment. `sniffAndVerifyContentType` re-checks the bytes against the
  // shared composer allowlist; `image/jpg` is a legacy alias for `image/jpeg`
  // (identical magic bytes), so normalize it for the sniff while preserving the
  // caller's declared type on the stored/returned record.
  function sniffCommentAttachment(file: { mimetype: string; buffer: Buffer }) {
    const contentType = validateAttachmentFile(file);
    sniffAndVerifyContentType(file.buffer, contentType === "image/jpg" ? "image/jpeg" : contentType);
    return contentType;
  }

  async function assertCanManageIssueApprovalLinks(req: Request, res: Response, companyId: string) {
    await assertCompanyAccess(db, req, companyId);
    if (req.actor.type === "board") return true;
    if (!req.actor.agentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    const actorAgent = await agentsSvc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      res.status(403).json({ error: "Forbidden" });
      return false;
    }
    if (actorAgent.role === "cxo" || Boolean(actorAgent.permissions?.canCreateAgents)) return true;
    res.status(403).json({ error: "Missing permission to link approvals" });
    return false;
  }

  function canCreateAgentsLegacy(agent: { permissions: Record<string, unknown> | null | undefined; role: string }) {
    // CXO-tier agents bypass the explicit permission check — they're
    // categorically empowered to hire. (Was historically `=== "ceo"`
    // before the role-enum cleanup; see plan
    // docs/superpowers/plans/2026-04-30-agent-role-3-tier-cleanup.md.)
    if (agent.role === "cxo") return true;
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function assertCanAssignTasks(req: Request, companyId: string) {
    await assertCompanyAccess(db, req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, req.actor.userId, "tasks:assign");
      if (!allowed) throw forbidden("Missing permission: tasks:assign");
      return;
    }
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden("Agent authentication required");
      const allowedByGrant = await access.hasPermission(companyId, "agent", req.actor.agentId, "tasks:assign");
      if (allowedByGrant) return;
      const actorAgent = await agentsSvc.getById(req.actor.agentId);
      if (actorAgent && actorAgent.companyId === companyId && canCreateAgentsLegacy(actorAgent)) return;
      throw forbidden("Missing permission: tasks:assign");
    }
    throw unauthorized();
  }

  function requireAgentRunId(req: Request, res: Response) {
    if (req.actor.type !== "agent") return null;
    const runId = req.actor.runId?.trim();
    if (runId) return runId;
    res.status(401).json({ error: "Agent run id required" });
    return null;
  }

  async function assertAgentRunCheckoutOwnership(
    req: Request,
    res: Response,
    issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null },
  ) {
    if (req.actor.type !== "agent") return true;
    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    if (issue.status !== "in_progress" || issue.assigneeAgentId !== actorAgentId) {
      return true;
    }
    const runId = requireAgentRunId(req, res);
    if (!runId) return false;
    const ownership = await svc.assertCheckoutOwner(issue.id, actorAgentId, runId);
    if (ownership.adoptedFromRunId) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.checkout_lock_adopted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          previousCheckoutRunId: ownership.adoptedFromRunId,
          checkoutRunId: runId,
          reason: "stale_checkout_run",
        },
      });
    }
    return true;
  }

  type CommentWakeAttachment = {
    id: string;
    originalFilename?: string | null;
    contentType?: string | null;
    byteSize?: number | null;
  };

  type IssueForCommentControl = {
    id: string;
    companyId: string;
    identifier: string | null;
    title: string;
    status: string;
    workMode: string | null;
    assigneeAgentId: string | null;
    executionRunId?: string | null;
  };

  function attachmentWakeMetadata(attachments: CommentWakeAttachment[]) {
    return attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.originalFilename ?? null,
      contentType: attachment.contentType ?? null,
      byteSize: attachment.byteSize ?? null,
    }));
  }

  function parseMultipartBoolean(value: unknown): boolean {
    return value === true || value === "true";
  }

  // Authz gate that must run BEFORE the comment is created (round-4 review): the
  // interrupt-is-board-only rule rejects up front so a non-board caller never
  // creates a comment. The MUTATING control effects (reopen/interrupt) are then
  // deferred until AFTER the conflict-protected insert is WON, so a same-key
  // race loser never reopens a task or cancels a run. Returns false (after
  // sending 403) when the request must be rejected.
  function assertInterruptAuthorized(req: Request, res: Response, interruptRequested: boolean): boolean {
    if (interruptRequested && req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can interrupt active runs from issue comments" });
      return false;
    }
    return true;
  }

  // Resolve the RUNNING run an interrupt would cancel for this issue (or null):
  // the issue's execution run if running, else the assignee's active run when it
  // is running ON this issue. Read-only — shared by applyIssueCommentControlEffects
  // (which then cancels it) and the round-17 #1 pre-resolve (so the in-transaction
  // wakeup can carry interruptedRunId even though the actual cancel runs after the
  // comment tx).
  async function resolveInterruptTargetRunId(currentIssue: IssueForCommentControl): Promise<string | null> {
    let runToInterrupt = currentIssue.executionRunId
      ? await heartbeat.getRun(currentIssue.executionRunId)
      : null;
    if ((!runToInterrupt || runToInterrupt.status !== "running") && currentIssue.assigneeAgentId) {
      const activeRun = await heartbeat.getActiveRunForAgent(currentIssue.assigneeAgentId);
      const activeIssueId =
        activeRun &&
        activeRun.contextSnapshot &&
        typeof activeRun.contextSnapshot === "object" &&
        typeof (activeRun.contextSnapshot as Record<string, unknown>).issueId === "string"
          ? ((activeRun.contextSnapshot as Record<string, unknown>).issueId as string)
          : null;
      if (activeRun && activeRun.status === "running" && activeIssueId === currentIssue.id) {
        runToInterrupt = activeRun;
      }
    }
    return runToInterrupt && runToInterrupt.status === "running" ? runToInterrupt.id : null;
  }

  async function applyIssueCommentControlEffects(input: {
    req: Request;
    res: Response;
    issue: IssueForCommentControl;
    actor: ReturnType<typeof getActorInfo>;
    reopenRequested: boolean;
    interruptRequested: boolean;
  }): Promise<
    | {
        ok: true;
        currentIssue: IssueForCommentControl;
        reopened: boolean;
        reopenFromStatus: string | null;
        interruptedRunId: string | null;
      }
    | { ok: false }
  > {
    const { req, res, issue, actor, reopenRequested, interruptRequested } = input;
    const isClosed = issue.status === "done" || issue.status === "cancelled";
    let reopened = false;
    let reopenFromStatus: string | null = null;
    let interruptedRunId: string | null = null;
    let currentIssue: IssueForCommentControl = issue;

    if (reopenRequested && isClosed) {
      const reopenedIssue = await svc.update(issue.id, { status: "todo" });
      if (!reopenedIssue) {
        res.status(404).json({ error: "Issue not found" });
        return { ok: false };
      }
      reopened = true;
      reopenFromStatus = issue.status;
      currentIssue = reopenedIssue;

      await logActivity(db, {
        companyId: currentIssue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: currentIssue.id,
        details: {
          status: "todo",
          reopened: true,
          reopenedFrom: reopenFromStatus,
          source: "comment",
          identifier: currentIssue.identifier,
        },
      });
    }

    if (interruptRequested) {
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only board users can interrupt active runs from issue comments" });
        return { ok: false };
      }

      const runToInterruptId = await resolveInterruptTargetRunId(currentIssue);

      if (runToInterruptId) {
        const cancelled = await heartbeat.cancelRun(runToInterruptId);
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "issue_comment_interrupt", issueId: currentIssue.id },
          });
        }
      }
    }

    return { ok: true, currentIssue, reopened, reopenFromStatus, interruptedRunId };
  }

  async function buildIssueCommentWakeupTargets(input: {
    issue: {
      id: string;
      companyId: string;
      status: string;
      workMode: string | null;
      assigneeAgentId: string | null;
    };
    currentIssue: {
      id: string;
      companyId: string;
      status: string;
      workMode: string | null;
      assigneeAgentId: string | null;
    };
    comment: {
      id: string;
      authorAgentId?: string | null;
    };
    body: string;
    actor: ReturnType<typeof getActorInfo>;
    reopened?: boolean;
    reopenFromStatus?: string | null;
    interruptedRunId?: string | null;
    attachments?: CommentWakeAttachment[];
  }): Promise<CommentWakeupTarget[]> {
    const {
      issue,
      currentIssue,
      comment,
      body,
      actor,
      reopened = false,
      reopenFromStatus = null,
      interruptedRunId = null,
      attachments = [],
    } = input;
    const wakeups = new Map<string, Parameters<typeof heartbeat.wakeup>[1]>();
    const assigneeId = currentIssue.assigneeAgentId;
    const actorIsAgent = actor.actorType === "agent";
    const selfComment = actorIsAgent && actor.actorId === assigneeId;
    const isClosed = issue.status === "done" || issue.status === "cancelled";
    const attachmentMetadata = attachmentWakeMetadata(attachments);
    const attachmentContext = attachments.length > 0
      ? { attachmentCount: attachments.length, attachments: attachmentMetadata }
      : {};

    if (assigneeId && shouldDispatchIssueWakeup(currentIssue) && (reopened || (!selfComment && !isClosed))) {
      if (reopened) {
        wakeups.set(assigneeId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_reopened_via_comment",
          payload: {
            issueId: currentIssue.id,
            commentId: comment.id,
            reopenedFrom: reopenFromStatus,
            mutation: "comment",
            ...attachmentContext,
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: currentIssue.id,
            taskId: currentIssue.id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            source: "issue.comment.reopen",
            wakeReason: "issue_reopened_via_comment",
            reopenedFrom: reopenFromStatus,
            ...attachmentContext,
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      } else {
        wakeups.set(assigneeId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: {
            issueId: currentIssue.id,
            commentId: comment.id,
            mutation: "comment",
            ...attachmentContext,
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: currentIssue.id,
            taskId: currentIssue.id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            source: "issue.comment",
            wakeReason: "issue_commented",
            ...attachmentContext,
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }
    }

    let mentionedIds: string[] = [];
    try {
      mentionedIds = await svc.findMentionedAgents(issue.companyId, body);
    } catch (err) {
      logger.warn({ err, issueId: issue.id }, "failed to resolve @-mentions");
    }

    for (const mentionedId of mentionedIds) {
      if (wakeups.has(mentionedId)) continue;
      if (actorIsAgent && actor.actorId === mentionedId) continue;
      if (comment.authorAgentId === mentionedId) continue;
      wakeups.set(mentionedId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_comment_mentioned",
        payload: { issueId: issue.id, commentId: comment.id, ...attachmentContext },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        contextSnapshot: {
          issueId: issue.id,
          taskId: issue.id,
          commentId: comment.id,
          wakeCommentId: comment.id,
          wakeReason: "issue_comment_mentioned",
          source: "comment.mention",
          ...attachmentContext,
        },
      });
    }

    // Human @mention notifications: idempotent (hub reconcile dedups) + best-
    // effort, and about the ISSUE + body (not the comment), so it stays inline
    // rather than in the per-agent wakeup outbox (which covers AGENT wakeups —
    // the round-16 finding). It runs before the comment insert; a duplicate
    // request re-notifies harmlessly.
    await svc.notifyMentionedHumans(issue.companyId, body, currentIssue.id, actor);

    // Round-16: return the per-agent wakeup TARGETS (agentId + fully-built config)
    // instead of dispatching here. The caller enqueues these in the comment-insert
    // transaction (addComment) and the durable comment_wakeup_outbox worker
    // delivers each exactly once — resolving each agent's kind (aoa vs org) at
    // drain time (so a failed kind lookup just retries that row, never misroutes).
    return [...wakeups.entries()].map(([agentId, wakeup]) => ({ agentId, wakeup }));
  }

  // Dispatch the wakeups for the combined comment+reassign / update PATCH path
  // (PR #291 round-11 #1). Builds the same request-changes + assignment + @mention
  // wakeups the PATCH always fired, but AWAITS their durable enqueue (so a caller
  // can stamp wakeups_enqueued_at only after the summon rows exist) and is reused
  // by both the fresh PATCH and its idempotent-replay resume — parity with the
  // POST comment routes. buildIssueCommentWakeupTargets.
  async function buildPatchCommentWakeupTargets(input: {
    issue: IssueForCommentControl;
    comment: { id: string; authorAgentId?: string | null } | null;
    /** Comment body for @mention resolution (empty when this is a pure update). */
    body: string;
    actor: ReturnType<typeof getActorInfo>;
    /** Wake issue.assigneeAgentId with issue_assigned (a reassign happened / was requested). */
    assigneeChanged: boolean;
    /** Wake issue.assigneeAgentId with issue_review_changes_requested. */
    requestChanges: boolean;
  }): Promise<CommentWakeupTarget[]> {
    const { issue, comment, body, actor, assigneeChanged, requestChanges } = input;
    const wakeups = new Map<string, Parameters<typeof heartbeat.wakeup>[1]>();

    if (requestChanges && comment && issue.assigneeAgentId && shouldDispatchIssueWakeup(issue)) {
      wakeups.set(issue.assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_review_changes_requested",
        payload: { issueId: issue.id, commentId: comment.id, mutation: "request_changes" },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        contextSnapshot: {
          issueId: issue.id,
          taskId: issue.id,
          commentId: comment.id,
          wakeCommentId: comment.id,
          wakeReason: "issue_review_changes_requested",
          source: "task.review",
        },
      });
    }

    if (assigneeChanged && issue.assigneeAgentId && issue.status !== "backlog" && shouldDispatchIssueWakeup(issue)) {
      wakeups.set(issue.assigneeAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: issue.id, mutation: "update" },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        contextSnapshot: { issueId: issue.id, source: "issue.update" },
      });
    }

    if (body && comment) {
      let mentionedIds: string[] = [];
      try {
        mentionedIds = await svc.findMentionedAgents(issue.companyId, body);
      } catch (err) {
        logger.warn({ err, issueId: issue.id }, "failed to resolve @-mentions");
      }
      for (const mentionedId of mentionedIds) {
        if (wakeups.has(mentionedId)) continue;
        if (actor.actorType === "agent" && actor.actorId === mentionedId) continue;
        if (comment.authorAgentId === mentionedId) continue;
        wakeups.set(mentionedId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_comment_mentioned",
          payload: { issueId: issue.id, commentId: comment.id },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            taskId: issue.id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            wakeReason: "issue_comment_mentioned",
            source: "comment.mention",
          },
        });
      }
      await svc.notifyMentionedHumans(issue.companyId, body, issue.id, actor);
    }

    // Round-16: return the per-agent wakeup TARGETS. The caller enqueues them into
    // the durable comment_wakeup_outbox and the worker delivers each exactly once,
    // resolving each agent's kind (aoa vs org) at drain time.
    return [...wakeups.entries()].map(([agentId, wakeup]) => ({ agentId, wakeup }));
  }

  // Fire-and-forget DIRECT dispatch for wakeup targets NOT tied to a comment — a
  // pure reassign / status PATCH with no comment to key the durable
  // comment_wakeup_outbox on. A keyless one-shot reassign has no durability
  // contract, so direct dispatch matches the pre-outbox behavior for these paths;
  // comment-tied wakeups go through svc.enqueueCommentWakeups (durable) instead.
  // Kinds are resolved here (round-14 #1: a lookup failure skips rather than
  // misrouting aoa → heartbeat).
  async function dispatchWakeupTargets(companyId: string, targets: CommentWakeupTarget[]): Promise<void> {
    if (targets.length === 0) return;
    let kinds: Map<string, string>;
    try {
      kinds = await svc.resolveAgentKinds(targets.map((t) => t.agentId));
    } catch (err) {
      logger.warn({ err, companyId }, "resolveAgentKinds failed on reassign wakeup dispatch — skipping");
      return;
    }
    await Promise.allSettled(
      targets.map((t) => {
        const w = (t.wakeup ?? {}) as { source?: string | null; reason?: string | null; payload?: unknown };
        return kinds.get(t.agentId) === "aoa"
          ? svc
              .enqueueAoaMentionWakeup(companyId, t.agentId, { source: w.source, reason: w.reason, payload: w.payload })
              .catch((err) => logger.warn({ err, agentId: t.agentId }, "failed aoa reassign wakeup"))
          : heartbeat
              .wakeup(t.agentId, t.wakeup as Parameters<typeof heartbeat.wakeup>[1])
              .catch((err) => logger.warn({ err, agentId: t.agentId }, "failed reassign wakeup"));
      }),
    );
  }

  // Resume a replayed/race-lost comment's side effects that the original request
  // never completed. Two parts, each idempotent so a resume finishes what's
  // missing without re-firing what's done:
  //   - CONTROL EFFECTS (reopen/interrupt): gated by control_effects_completed_at
  //     so a resume never re-applies them (the founder may have re-closed the task);
  //   - @mention/assignee WAKEUPS (round-16): re-build the per-agent targets and
  //     re-enqueue them into comment_wakeup_outbox. The enqueue is idempotent on
  //     (comment, agent), so this is a no-op when the original already enqueued
  //     them, and it RECOVERS the case where the original committed the comment but
  //     crashed before enqueueing (the durable worker then delivers each once).
  // Returns { ok:false } when authz/control-effect handling already sent a response.
  async function resumeIncompleteCommentSideEffects(input: {
    req: Request;
    res: Response;
    issue: IssueForCommentControl;
    comment: {
      id: string;
      body: string;
      authorAgentId?: string | null;
      controlEffectsCompletedAt?: Date | null;
    };
    reopenRequested: boolean;
    interruptRequested: boolean;
    // Completed attachment rows to carry into the re-enqueued wakeup so the woken
    // agent receives the file metadata (round-8 #2).
    attachments?: CommentWakeAttachment[];
  }): Promise<{ ok: boolean }> {
    const { req, res, issue, comment, reopenRequested, interruptRequested } = input;
    const attachments = input.attachments ?? [];
    const actor = getActorInfo(req);

    let currentIssue: IssueForCommentControl = issue;
    let reopened = false;
    let reopenFromStatus: string | null = null;
    let interruptedRunId: string | null = null;

    if (!comment.controlEffectsCompletedAt) {
      if (!assertInterruptAuthorized(req, res, interruptRequested)) return { ok: false };
      const control = await applyIssueCommentControlEffects({
        req,
        res,
        issue,
        actor,
        reopenRequested,
        interruptRequested,
      });
      if (!control.ok) return { ok: false };
      currentIssue = control.currentIssue;
      reopened = control.reopened;
      reopenFromStatus = control.reopenFromStatus;
      interruptedRunId = control.interruptedRunId;
      await svc.markCommentControlEffectsCompleted(comment.id);
    }

    const targets = await buildIssueCommentWakeupTargets({
      issue,
      currentIssue,
      comment,
      body: comment.body,
      actor,
      reopened,
      reopenFromStatus,
      interruptedRunId,
      attachments,
    });
    await svc.enqueueCommentWakeups({
      companyId: issue.companyId,
      issueId: issue.id,
      commentId: comment.id,
      targets,
    });
    // Round-18 #2/#3: the resumed control effects + completed attachments are now
    // durable, so flip any DEFERRED wakeup rows ready. This recovers a comment
    // whose original request crashed AFTER committing the (deferred) rows but
    // BEFORE flipping them — the retry lands here and readies them explicitly
    // (before the ready_at grace backstop would).
    await svc.markCommentWakeupsReady(comment.id);

    return { ok: true };
  }

  // When `companyId` is provided the resolve is company-scoped (matches the
  // (company_id, identifier) unique index → the correct tenant's task); the
  // bare `/issues/:id…` routes pass no companyId and use the bare-route resolve
  // scoped to the actor's accessible companies, re-checking authz on the
  // resolved issue's company downstream.
  async function normalizeIssueIdentifier(
    rawId: string,
    companyId?: string,
    accessibleCompanyIds?: string[],
  ): Promise<string> {
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      const issue = companyId
        ? await svc.getByIdentifierInCompany(companyId, rawId)
        : await svc.getByIdentifier(rawId, accessibleCompanyIds);
      if (issue) {
        return issue.id;
      }
    }
    return rawId;
  }

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for all /issues/:id routes
  // (bare — no company in the URL → resolve scoped to the actor's companies).
  router.param("id", async (req, res, next, rawId) => {
    try {
      req.params.id = await normalizeIssueIdentifier(
        rawId,
        undefined,
        accessibleCompanyIdsForActor(req.actor),
      );
      next();
    } catch (err) {
      next(err);
    }
  });

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for company-scoped
  // attachment routes (`/companies/:companyId/issues/:issueId/attachments`).
  // `:companyId` precedes `:issueId` in the route path, so it is populated here
  // — scope the resolve to it so an identifier never crosses orgs. When the
  // route carries no company (bare), fall back to the actor-scoped resolve.
  router.param("issueId", async (req, res, next, rawId) => {
    try {
      const companyId = req.params.companyId as string | undefined;
      // This company-qualified attachment param hook runs before its handler.
      // Gate the URL company before the identifier lookup to avoid exposing
      // task existence through 404-versus-401/403 response differences.
      if (companyId) {
        await assertCompanyAccess(db, req, companyId);
      }
      req.params.issueId = await normalizeIssueIdentifier(
        rawId,
        companyId,
        companyId ? undefined : accessibleCompanyIdsForActor(req.actor),
      );
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/issues", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const assigneeUserFilterRaw = req.query.assigneeUserId as string | undefined;
    const responsibleUserFilterRaw = req.query.responsibleUserId as string | undefined;
    const createdByUserFilterRaw = req.query.createdByUserId as string | undefined;
    const touchedByUserFilterRaw = req.query.touchedByUserId as string | undefined;
    const unreadForUserFilterRaw = req.query.unreadForUserId as string | undefined;
    const assigneeUserId =
      assigneeUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : assigneeUserFilterRaw;
    const responsibleUserId =
      responsibleUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : responsibleUserFilterRaw;
    const createdByUserId =
      createdByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : createdByUserFilterRaw;
    const touchedByUserId =
      touchedByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : touchedByUserFilterRaw;
    const unreadForUserId =
      unreadForUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : unreadForUserFilterRaw;

    if (assigneeUserFilterRaw === "me" && (!assigneeUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "assigneeUserId=me requires board authentication" });
      return;
    }
    if (responsibleUserFilterRaw === "me" && (!responsibleUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "responsibleUserId=me requires board authentication" });
      return;
    }
    if (createdByUserFilterRaw === "me" && (!createdByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "createdByUserId=me requires board authentication" });
      return;
    }
    if (touchedByUserFilterRaw === "me" && (!touchedByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "touchedByUserId=me requires board authentication" });
      return;
    }
    if (unreadForUserFilterRaw === "me" && (!unreadForUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "unreadForUserId=me requires board authentication" });
      return;
    }

    const parentIdRaw = req.query.parentId;
    let parentIdFilter: string | null | undefined;
    if (typeof parentIdRaw === "string") {
      parentIdFilter = parentIdRaw === "null" || parentIdRaw === "" ? null : parentIdRaw;
    }

    // Crew/org task scope (2026-06-02 unified separation, T-A). The service
    // applies its own fail-safe default of 'org' when no scope is passed, so the
    // route only forwards an explicit scope:
    //  - `taskScope=org|crew|all` is forwarded verbatim (junk → undefined).
    //  - legacy `crewBoard=true` maps to taskScope='crew' (literal "true" only).
    //  - an explicit `taskScope` wins over `crewBoard`.
    const taskScopeRaw = req.query.taskScope;
    const taskScopeParam =
      taskScopeRaw === "org" || taskScopeRaw === "crew" || taskScopeRaw === "all"
        ? taskScopeRaw
        : undefined;
    const crewBoard = req.query.crewBoard === "true";
    const taskScope = taskScopeParam ?? (crewBoard ? "crew" : undefined);

    const result = await svc.list(companyId, {
      status: req.query.status as string | undefined,
      assigneeAgentId: req.query.assigneeAgentId as string | undefined,
      assigneeUserId,
      responsibleUserId,
      createdByUserId,
      touchedByUserId,
      unreadForUserId,
      projectId: req.query.projectId as string | undefined,
      labelId: req.query.labelId as string | undefined,
      q: req.query.q as string | undefined,
      ...(parentIdFilter !== undefined ? { parentId: parentIdFilter } : {}),
      ...(taskScope ? { taskScope } : {}),
    });
    res.json(result);
  });

  // Explicit 404 for the common mis-path /companies/:cid/issues/:id — the
  // canonical issue-by-id endpoint is unprefixed at /api/issues/:id. Placed
  // AFTER the list handler so it doesn't intercept GET /companies/:cid/issues.
  router.all("/companies/:companyId/issues/:id", (req, res) => {
    const id = req.params.id as string;
    res.status(404).json({
      error: "Issue endpoint is unprefixed",
      hint: `Use /api/issues/${id} instead`,
      correctRoute: `/api/issues/${id}`,
    });
  });

  router.get("/companies/:companyId/labels", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const result = await svc.listLabels(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/labels", validate(createIssueLabelSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const label = await svc.createLabel(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.created",
      entityType: "label",
      entityId: label.id,
      details: { name: label.name, color: label.color },
    });
    res.status(201).json(label);
  });

  router.delete("/labels/:labelId", async (req, res) => {
    const labelId = req.params.labelId as string;
    const existing = await svc.getLabelById(labelId);
    if (!existing) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    const removed = await svc.deleteLabel(labelId);
    if (!removed) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.deleted",
      entityType: "label",
      entityId: removed.id,
      details: { name: removed.name, color: removed.color },
    });
    res.json(removed);
  });

  router.get("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyAccess(db, req, issue.companyId);
    const [ancestors, project, goal, mentionedProjectIds, documentPayload] = await Promise.all([
      svc.getAncestors(issue.id),
      issue.projectId ? projectsSvc.getById(issue.projectId) : null,
      issue.goalId ? goalsSvc.getById(issue.goalId) : null,
      svc.findMentionedProjectIds(issue.id),
      documentsSvc.getIssueDocumentPayload(issue),
    ]);
    const mentionedProjects = mentionedProjectIds.length > 0
      ? await projectsSvc.listByIds(issue.companyId, mentionedProjectIds)
      : [];
    res.json({ ...issue, ancestors, project: project ?? null, goal: goal ?? null, mentionedProjects, ...documentPayload });
  });

  router.post("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyAccess(db, req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const readState = await svc.markRead(issue.companyId, issue.id, req.actor.userId, new Date());
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.read_marked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId, lastReadAt: readState.lastReadAt },
    });
    res.json(readState);
  });

  router.get("/issues/:id/approvals", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyAccess(db, req, issue.companyId);
    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    res.json(approvals);
  });

  router.post("/issues/:id/approvals", validate(linkIssueApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.companyId))) return;

    const actor = getActorInfo(req);
    await issueApprovalsSvc.link(id, req.body.approvalId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.approval_linked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId: req.body.approvalId },
    });

    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    res.status(201).json(approvals);
  });

  router.delete("/issues/:id/approvals/:approvalId", async (req, res) => {
    const id = req.params.id as string;
    const approvalId = req.params.approvalId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.companyId))) return;

    await issueApprovalsSvc.unlink(id, approvalId);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.approval_unlinked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId },
    });

    res.json({ ok: true });
  });

  router.post("/companies/:companyId/issues", validate(createIssueSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    if (
      req.body.responsibleUserId !== undefined ||
      req.body.reviewerUserId !== undefined ||
      req.body.assigneeUserId ||
      (req.body.assigneeAgentId && req.actor.type !== "agent")
    ) {
      await assertCanAssignTasks(req, companyId);
    }
    if (req.body.agentCompletionPolicyOverride !== undefined) {
      if (req.actor.type !== "board") {
        throw forbidden("Only human operators may override task completion policy");
      }
      await assertCanAssignTasks(req, companyId);
    }
    if (req.actor.type === "agent" && (req.body.acceptanceCriteria?.length ?? 0) > 0) {
      throw forbidden("Agents cannot define their own task acceptance criteria");
    }

    // Validate FK references up-front so the client gets a typed 422 (with
    // field/id details) instead of a generic 404 from the service or a 500
    // from a DB-level FK constraint failure.  Out-of-company hits are treated
    // as "not found" — leaking existence across tenants would be a bug.
    const fkLookups: Array<{
      field: "assigneeAgentId" | "projectId" | "goalId" | "parentId" | "inheritExecutionWorkspaceFromIssueId" | "sourceDiscussionId";
      id: string;
      label: string;
      fetch: () => Promise<{ companyId: string } | null>;
    }> = [];
    if (req.body.assigneeAgentId) {
      fkLookups.push({
        field: "assigneeAgentId",
        id: req.body.assigneeAgentId,
        label: "Assignee agent",
        fetch: () => agentsSvc.getById(req.body.assigneeAgentId),
      });
    }
    if (req.body.projectId) {
      fkLookups.push({
        field: "projectId",
        id: req.body.projectId,
        label: "Project",
        fetch: () => projectsSvc.getById(req.body.projectId),
      });
    }
    if (req.body.goalId) {
      fkLookups.push({
        field: "goalId",
        id: req.body.goalId,
        label: "Goal",
        fetch: () => goalsSvc.getById(req.body.goalId),
      });
    }
    if (req.body.parentId) {
      fkLookups.push({
        field: "parentId",
        id: req.body.parentId,
        label: "Parent task",
        fetch: () => svc.getById(req.body.parentId),
      });
    }
    if (req.body.inheritExecutionWorkspaceFromIssueId) {
      fkLookups.push({
        field: "inheritExecutionWorkspaceFromIssueId",
        id: req.body.inheritExecutionWorkspaceFromIssueId,
        label: "Workspace inheritance task",
        fetch: () => svc.getById(req.body.inheritExecutionWorkspaceFromIssueId),
      });
    }
    if (req.body.sourceDiscussionId) {
      fkLookups.push({
        field: "sourceDiscussionId",
        id: req.body.sourceDiscussionId,
        label: "Source Discussion",
        fetch: () => db.select({ companyId: discussions.companyId })
          .from(discussions)
          .where(and(
            eq(discussions.id, req.body.sourceDiscussionId),
            eq(discussions.companyId, companyId),
          ))
          .then((rows) => rows[0] ?? null),
      });
    }
    for (const check of fkLookups) {
      const row = await check.fetch();
      if (!row || row.companyId !== companyId) {
        throw unprocessable(`${check.label} not found`, { field: check.field, id: check.id });
      }
    }

    if (hasWorkspaceOverrideFields(req.body)) {
      await assertCanOverrideTaskWorkspace(db, req, {
        companyId,
        projectId: req.body.projectId ?? null,
      });
    }

    const actor = getActorInfo(req);
    let wakeSkippedReason: WakeSkippedReason | "workspace_setup_failed" | null = null;

    if (req.actor.type === "agent" && req.actor.agentId && req.body.assigneeAgentId) {
      const [actorAgent, targetAgent, hasGlobalAssignGrant] = await Promise.all([
        agentsSvc.getById(req.actor.agentId),
        agentsSvc.getById(req.body.assigneeAgentId),
        access.hasPermission(companyId, "agent", req.actor.agentId, "tasks:assign"),
      ]);

      if (!actorAgent || actorAgent.companyId !== companyId) {
        throw forbidden("Agent authentication required");
      }
      if (!targetAgent || targetAgent.companyId !== companyId) {
        throw unprocessable("Assignee agent not found", { field: "assigneeAgentId", id: req.body.assigneeAgentId });
      }

      const decision = canDelegateToTarget({
        actorAgent: {
          id: actorAgent.id,
          companyId: actorAgent.companyId,
          role: actorAgent.role,
          reportsTo: actorAgent.reportsTo ?? null,
          status: actorAgent.status,
          permissions: actorAgent.permissions,
        },
        targetAgent: {
          id: targetAgent.id,
          companyId: targetAgent.companyId,
          role: targetAgent.role,
          reportsTo: targetAgent.reportsTo ?? null,
          status: targetAgent.status,
          permissions: targetAgent.permissions,
        },
        hasGlobalAssignGrant,
      });

      if (!decision.allowed) {
        res.status(403).json({
          error: "Cannot assign target agent",
          reason: decision.reason,
          allowedActions: decision.allowedActions,
        });
        return;
      }
      wakeSkippedReason = decision.wakeSkippedReason ?? null;
    }

    const issue = await svc.create(companyId, normalizeIssueDateFields({
      ...req.body,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      responsibleFallbackUserId: actor.actorType === "user" ? actor.actorId : null,
    }));

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        title: issue.title,
        identifier: issue.identifier,
        wakeSkippedReason,
        ...(workspaceOverrideAuditDetails(req.body)
          ? { workspaceOverride: workspaceOverrideAuditDetails(req.body) }
          : {}),
      },
    });

    // Eager workspace creation — if the project supports execution workspaces,
    // create one immediately so the user sees it right away (instead of waiting
    // for a heartbeat run to provision it).  Fire-and-forget: failures log but
    // never block issue creation.
    const shouldWakeAssignedAgent =
      Boolean(issue.assigneeAgentId) &&
      issue.status !== "backlog" &&
      shouldDispatchIssueWakeup(issue);

    if (issue.projectId && !issue.executionWorkspaceId) {
      const projectId = issue.projectId;
      const ensureWorkspace = () => createEagerWorkspaceForIssue(db, {
        companyId,
        issueId: issue.id,
        issueIdentifier: issue.identifier ?? issue.id,
        issueTitle: issue.title,
        projectId,
        issueExecutionWorkspaceId: issue.executionWorkspaceId,
        issueExecutionWorkspacePreference: issue.executionWorkspacePreference,
        issueExecutionWorkspaceSettings: issue.executionWorkspaceSettings,
      });
      if (shouldWakeAssignedAgent && !wakeSkippedReason) {
        try {
          await ensureWorkspace();
        } catch (err) {
          wakeSkippedReason = "workspace_setup_failed";
          logger.warn({ err, issueId: issue.id }, "eager workspace creation failed before assignment wakeup");
        }
      } else {
        void ensureWorkspace().catch((err) =>
          logger.warn({ err, issueId: issue.id }, "eager workspace creation failed (non-blocking)"),
        );
      }
    }

    if (
      !wakeSkippedReason &&
      issue.assigneeAgentId &&
      shouldWakeAssignedAgent
    ) {
      void enqueueIssueAssigneeWakeup(db, {
        companyId: issue.companyId,
        agentId: issue.assigneeAgentId,
        issueId: issue.id,
        source: "assignment",
        reason: "issue_assigned",
        mutation: "create",
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
      }).catch((err) => logger.warn({ err, issueId: issue.id }, "failed to wake assignee on create"));
    } else if (wakeSkippedReason) {
      logger.info({ issueId: issue.id, assigneeAgentId: issue.assigneeAgentId, wakeSkippedReason }, "skipped assignment wakeup");
    }

    res.status(201).json(wakeSkippedReason ? { ...issue, wakeSkippedReason } : issue);
  });

  router.patch("/issues/:id", validate(updateIssueSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    const assigneeWillChange =
      (req.body.assigneeAgentId !== undefined && req.body.assigneeAgentId !== existing.assigneeAgentId) ||
      (req.body.assigneeUserId !== undefined && req.body.assigneeUserId !== existing.assigneeUserId);
    const responsibleWillChange =
      req.body.responsibleUserId !== undefined &&
      req.body.responsibleUserId !== existing.responsibleUserId;
    const reviewerWillChange =
      req.body.reviewerUserId !== undefined &&
      req.body.reviewerUserId !== existing.reviewerUserId;
    const completionPolicyOverrideSupplied =
      req.body.agentCompletionPolicyOverride !== undefined;

    const isAgentReturningIssueToCreator =
      req.actor.type === "agent" &&
      !!req.actor.agentId &&
      existing.assigneeAgentId === req.actor.agentId &&
      req.body.assigneeAgentId === null &&
      typeof req.body.assigneeUserId === "string" &&
      !!existing.createdByUserId &&
      req.body.assigneeUserId === existing.createdByUserId;

    if (assigneeWillChange || responsibleWillChange || reviewerWillChange) {
      if (!(isAgentReturningIssueToCreator && !responsibleWillChange && !reviewerWillChange)) {
        await assertCanAssignTasks(req, existing.companyId);
      }
    }
    if (completionPolicyOverrideSupplied) {
      if (req.actor.type !== "board") {
        throw forbidden("Only human operators may override task completion policy");
      }
      const executionStarted = existing.startedAt !== null
        || ["in_progress", "in_review", "done", "cancelled"].includes(existing.status);
      if (executionStarted) {
        await assertRole(db, req, existing.companyId, "founder");
      } else {
        await assertCanAssignTasks(req, existing.companyId);
      }
    }
    if (req.actor.type === "agent" && req.body.acceptanceCriteria !== undefined) {
      throw forbidden("Agents cannot define their own task acceptance criteria");
    }
    if (!(await assertAgentRunCheckoutOwnership(req, res, existing))) return;

    // Round-11 #2: EARLY idempotent-replay detection for the combined
    // comment+reassign PATCH. If this exact submission key already produced a
    // comment, the ORIGINAL request already applied the reassign + logged
    // issue.updated — a retry must NOT re-PATCH the task, re-log the update, or
    // re-fire the reassign. It only RESUMES the comment's wakeups if the original
    // died before enqueuing them (marker null), mirroring the POST comment routes
    // (round-9 #3). Detected BEFORE svc.update so the task is never re-mutated.
    const earlySubmissionKey =
      typeof req.body.clientSubmissionId === "string" ? req.body.clientSubmissionId : undefined;
    if (earlySubmissionKey) {
      const replay = await svc.getCommentByClientSubmissionId(existing.companyId, id, earlySubmissionKey);
      if (replay) {
        // Round-16: re-build + re-enqueue this comment's wakeup TARGETS
        // idempotently (onConflictDoNothing on (comment, agent)). If the original
        // committed the comment but died before enqueueing, this recovers it; if
        // the rows already exist, the enqueue is a no-op. The worker then delivers
        // each exactly once — no marker, no double-wake. Never re-PATCHes the task.
        const reassignRequested =
          req.body.assigneeAgentId !== undefined || req.body.assigneeUserId !== undefined;
        const targets = await buildPatchCommentWakeupTargets({
          issue: existing,
          comment: replay,
          body: replay.body,
          actor: getActorInfo(req),
          assigneeChanged: reassignRequested,
          requestChanges: false,
        });
        await svc.enqueueCommentWakeups({
          companyId: existing.companyId,
          issueId: id,
          commentId: replay.id,
          targets,
        });
        res.json({ ...existing, comment: replay });
        return;
      }
    }

    // Strip `comment` and `clientSubmissionId` out of the fields passed to
    // svc.update — they are NOT issue columns (clientSubmissionId is the comment
    // idempotency key, threaded into addComment below; round-10 #2).
    const {
      comment: commentBody,
      hiddenAt: hiddenAtRaw,
      clientSubmissionId: commentClientSubmissionId,
      ...rawUpdateFields
    } = req.body;
    const updateFields = normalizeIssueDateFields(rawUpdateFields);
    const isRequestChangesTransition =
      existing.status === "in_review" && updateFields.status === "in_progress";
    const requestChangesFeedback = isRequestChangesTransition && typeof commentBody === "string"
      ? commentBody.trim()
      : null;
    if (isRequestChangesTransition && !requestChangesFeedback) {
      throw unprocessable("Requesting changes requires feedback", {
        code: "review_feedback_required",
        field: "comment",
      });
    }
    const persistedCommentBody = requestChangesFeedback ?? commentBody;
    // Round-12 #2: a keyed comment+reassign PATCH (the composer's combined
    // mutation) must persist the issue reassign (svc.update) and the KEYED comment
    // (addComment) in ONE transaction, so the keyed comment row exists if-and-only-
    // if the reassign committed. Otherwise a crash between the two writes leaves
    // the reassign applied with no keyed comment — and the early-replay check above
    // (which keys off the comment) would miss it, so a retry re-PATCHes the task
    // (clobbering a newer concurrent reassign + re-logging issue.updated). The
    // request-changes transition already runs in its own tx below; this covers the
    // plain keyed comment+reassign case.
    const hasKeyedComment =
      !isRequestChangesTransition &&
      typeof commentClientSubmissionId === "string" &&
      typeof persistedCommentBody === "string" &&
      persistedCommentBody.length > 0;
    if (hiddenAtRaw !== undefined) {
      updateFields.hiddenAt = hiddenAtRaw ? new Date(hiddenAtRaw) : null;
    }
    if (hasWorkspaceOverrideFields(updateFields)) {
      await assertCanOverrideTaskWorkspace(db, req, {
        companyId: existing.companyId,
        projectId: updateFields.projectId ?? existing.projectId ?? null,
      });
    }

    const actor = getActorInfo(req);
    const updateActor = req.actor.type === "agent"
      ? {
        actorType: "agent" as const,
        agentId: req.actor.agentId ?? null,
        // Org-agent API keys are outside the crew Manual/Assist/Drive dial.
        // Their task completion authority is governed by the task snapshot.
        effectiveDial: 2,
        expectedUpdatedAt: existing.updatedAt,
      }
      : {
        actorType: req.actor.type === "board" ? "board" as const : "user" as const,
        expectedUpdatedAt: existing.updatedAt,
      };
    let issue;
    let comment = null;
    try {
      if (isRequestChangesTransition) {
        const persisted = await db.transaction(async (txRaw) => {
          const txSvc = issueService(txRaw as unknown as Db);
          const updatedIssue = await txSvc.update(id, updateFields, updateActor);
          if (!updatedIssue) return { issue: null, comment: null };
          const feedbackComment = await txSvc.addComment(id, requestChangesFeedback!, {
            agentId: actor.agentId ?? undefined,
            userId: actor.actorType === "user" ? actor.actorId : undefined,
            // Round-18 #4: thread the submission key so a lost-response retry is
            // idempotent. Without it the feedback comment is unkeyed; on retry the
            // task is already in_progress (no longer a request-changes transition),
            // so the retry would take the ordinary keyed path and create a SECOND
            // feedback comment. The keyed comment lets the early-replay lookup catch
            // the retry instead.
            clientSubmissionId:
              typeof commentClientSubmissionId === "string" ? commentClientSubmissionId : undefined,
            // Round-17 #1: enqueue the review-changes wakeup IN THIS TX.
            buildWakeupTargets: (c) =>
              buildPatchCommentWakeupTargets({
                issue: updatedIssue,
                comment: c,
                body: requestChangesFeedback ?? "",
                actor,
                assigneeChanged: assigneeWillChange,
                requestChanges: true,
              }),
          });
          return { issue: updatedIssue, comment: feedbackComment };
        });
        issue = persisted.issue;
        comment = persisted.comment;
      } else if (hasKeyedComment) {
        // Round-12 #2 (root): reassign + keyed comment commit atomically. The
        // update keeps its optimistic-concurrency guard (updateActor carries
        // expectedUpdatedAt = existing.updatedAt → svc.update 409s if another
        // operator reassigned in the meantime), and the keyed comment insert is
        // now inside the SAME tx, so the two can never diverge. Round-17 #1: the
        // per-agent wakeup rows are enqueued in THIS tx too, so a committed
        // comment always carries them (no post-commit enqueue window).
        const persisted = await db.transaction(async (txRaw) => {
          const txSvc = issueService(txRaw as unknown as Db);
          const updatedIssue = await txSvc.update(id, updateFields, updateActor);
          if (!updatedIssue) return { issue: null, comment: null };
          const keyedComment = await txSvc.addComment(id, persistedCommentBody as string, {
            agentId: actor.agentId ?? undefined,
            userId: actor.actorType === "user" ? actor.actorId : undefined,
            clientSubmissionId: commentClientSubmissionId as string,
            buildWakeupTargets: (c) =>
              buildPatchCommentWakeupTargets({
                issue: updatedIssue,
                comment: c,
                body: persistedCommentBody ?? "",
                actor,
                assigneeChanged: assigneeWillChange,
                requestChanges: false,
              }),
          });
          return { issue: updatedIssue, comment: keyedComment };
        });
        issue = persisted.issue;
        comment = persisted.comment;
      } else {
        issue = await svc.update(id, updateFields, updateActor);
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) {
        logger.warn(
          {
            issueId: id,
            companyId: existing.companyId,
            assigneePatch: {
              assigneeAgentId:
                req.body.assigneeAgentId === undefined ? "__omitted__" : req.body.assigneeAgentId,
              assigneeUserId:
                req.body.assigneeUserId === undefined ? "__omitted__" : req.body.assigneeUserId,
            },
            currentAssignee: {
              assigneeAgentId: existing.assigneeAgentId,
              assigneeUserId: existing.assigneeUserId,
            },
            error: err.message,
            details: err.details,
          },
          "issue update rejected with 422",
        );
      }
      throw err;
    }
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    // Build activity details with previous values for changed fields
    const previous: Record<string, unknown> = {};
    for (const key of Object.keys(updateFields)) {
      if (key in existing && (existing as Record<string, unknown>)[key] !== (updateFields as Record<string, unknown>)[key]) {
        previous[key] = (existing as Record<string, unknown>)[key];
      }
    }
    const includeResponsibleTransition =
      Object.prototype.hasOwnProperty.call(req.body, "responsibleUserId") ||
      issue.responsibleUserId !== existing.responsibleUserId;
    const responsibleTransitionDetails = includeResponsibleTransition
      ? {
          responsibleUserId: issue.responsibleUserId,
          previousResponsibleUserId: existing.responsibleUserId,
        }
      : {};

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        ...updateFields,
        ...responsibleTransitionDetails,
        identifier: issue.identifier,
        ...(workspaceOverrideAuditDetails(updateFields)
          ? { workspaceOverride: workspaceOverrideAuditDetails(updateFields) }
          : {}),
        _previous: Object.keys(previous).length > 0 ? previous : undefined,
      },
    });

    // Sync routine run status when a linked issue reaches a terminal state
    if (
      issue.originKind === "routine_execution" &&
      issue.originRunId &&
      (issue.status === "done" || issue.status === "cancelled")
    ) {
      void routineService(db)
        .syncRunStatusForIssue(issue.id)
        .catch((err) => logger.warn({ err, issueId: issue.id }, "syncRunStatusForIssue failed"));
    }

    // Archive working-layer memory items scoped to this task when it reaches terminal state
    if (issue.status === "done" || issue.status === "cancelled") {
      void memoryLifecycleService(db)
        .onTaskCompleted(issue.companyId, issue.id)
        .catch((err) => logger.warn({ err, issueId: issue.id }, "onTaskCompleted memory lifecycle failed"));
    }

    if (persistedCommentBody && !comment) {
      // A comment posted through the PATCH path WITHOUT a client submission key
      // (no idempotency requested). The KEYED comment+reassign case is handled
      // atomically inside the transaction above (round-12 #2), so `comment` is
      // already set there and this fallback only ever runs for the unkeyed case.
      // Round-17 #1: enqueue its wakeups IN addComment's tx so a committed comment
      // always carries them.
      comment = await svc.addComment(id, persistedCommentBody, {
        agentId: actor.agentId ?? undefined,
        userId: actor.actorType === "user" ? actor.actorId : undefined,
        clientSubmissionId:
          typeof commentClientSubmissionId === "string" ? commentClientSubmissionId : undefined,
        buildWakeupTargets: (c) =>
          buildPatchCommentWakeupTargets({
            issue,
            comment: c,
            body: persistedCommentBody,
            actor,
            assigneeChanged: assigneeWillChange,
            requestChanges: isRequestChangesTransition,
          }),
      });
    }
    // A same-key retry replays the original comment — skip the comment's
    // post-insert side-effects (activity + mention wakeups) below so they don't
    // re-fire (round-10 #2). Reassignment/status effects stay idempotent via
    // their own change checks (assigneeWillChange is false once already applied).
    const commentReplayed = Boolean((comment as { replayed?: boolean } | null)?.replayed);

    if (comment && !commentReplayed) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          identifier: issue.identifier,
          issueTitle: issue.title,
        },
      });
    }

    const assigneeChanged = assigneeWillChange;

    // Round-17 #1: comment-tied wakeups are now enqueued INSIDE the comment-insert
    // transaction (addComment's buildWakeupTargets above), so a committed comment
    // always carries its pending wakeup rows — no post-commit enqueue window. The
    // only case handled here is a PURE status/reassign with NO comment: there is
    // no comment to key the durable outbox on, and a keyless one-shot reassign has
    // no durability contract, so it keeps a direct fire-and-forget dispatch.
    // (A race-loser replay set `comment.replayed`; buildWakeupTargets only ran on
    // the winner's fresh insert, so the loser never re-enqueues.)
    if (!comment) {
      const targets = await buildPatchCommentWakeupTargets({
        issue,
        comment: null,
        body: "",
        actor,
        assigneeChanged,
        requestChanges: isRequestChangesTransition,
      });
      void dispatchWakeupTargets(issue.companyId, targets).catch(() => {});
    }

    res.json({ ...issue, comment });
  });

  router.delete("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    const attachments = await svc.listAttachments(id);

    const issue = await svc.remove(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    for (const attachment of attachments) {
      try {
        await storage.deleteObject(
          await resolveStorageTenant(db, attachment.companyId),
          attachment.companyId,
          attachment.objectKey,
        );
      } catch (err) {
        logger.warn({ err, issueId: id, attachmentId: attachment.id }, "failed to delete attachment object during issue delete");
      }
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.deleted",
      entityType: "issue",
      entityId: issue.id,
    });

    res.json(issue);
  });

  router.post("/issues/:id/checkout", validate(checkoutIssueSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyAccess(db, req, issue.companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only checkout as itself" });
      return;
    }

    const checkoutRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !checkoutRunId) return;
    const updated = await svc.checkout(id, req.body.agentId, req.body.expectedStatuses, checkoutRunId);
    const actor = getActorInfo(req);

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.checked_out",
      entityType: "issue",
      entityId: issue.id,
      details: { agentId: req.body.agentId },
    });

    if (
      shouldWakeAssigneeOnCheckout({
        // mcp + commander are non-agent, non-board internal actors for the
        // purpose of assignee-wake — collapse both to "board" (never the
        // checkout agent).
        actorType:
          req.actor.type === "mcp" || req.actor.type === "commander"
            ? "board"
            : req.actor.type,
        actorAgentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
        checkoutAgentId: req.body.agentId,
        checkoutRunId,
      })
    ) {
      void heartbeat
        .wakeup(req.body.agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_checked_out",
          payload: { issueId: issue.id, mutation: "checkout" },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: { issueId: issue.id, source: "issue.checkout" },
        })
        .catch((err) => logger.warn({ err, issueId: issue.id }, "failed to wake assignee on issue checkout"));
    }

    res.json(updated);
  });

  router.post("/issues/:id/release", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    if (!(await assertAgentRunCheckoutOwnership(req, res, existing))) return;
    const actorRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !actorRunId) return;

    const released = await svc.release(
      id,
      req.actor.type === "agent" ? req.actor.agentId : undefined,
      actorRunId,
    );
    if (!released) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: released.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.released",
      entityType: "issue",
      entityId: released.id,
    });

    res.json(released);
  });

  router.get("/issues/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyAccess(db, req, issue.companyId);
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.get("/issues/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyAccess(db, req, issue.companyId);
    const comment = await svc.getComment(commentId);
    if (!comment || comment.issueId !== id) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    res.json(comment);
  });

  router.post("/issues/:id/comments", validate(addIssueCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyAccess(db, req, issue.companyId);
    if (!(await assertAgentRunCheckoutOwnership(req, res, issue))) return;

    // Idempotent retry: if this exact submission was already recorded, replay the
    // original comment. The comment commits BEFORE its control effects, so the
    // original send can die after the comment persisted but before reopen/cancel
    // ran; the replay must RESUME those effects, not skip them (PR #291 round-5
    // review). reopen/interrupt are idempotent + state-gated, so a replay whose
    // effects already completed is a no-op. Wakeups stay skipped on replay
    // (round-3) to avoid double-waking. The DB partial-unique index is the
    // concurrency backstop below.
    const clientSubmissionId =
      typeof req.body.clientSubmissionId === "string" ? req.body.clientSubmissionId : undefined;
    if (clientSubmissionId) {
      const replay = await svc.getCommentByClientSubmissionId(issue.companyId, id, clientSubmissionId);
      if (replay) {
        // Resume any control effects AND wakeups the original send did not
        // complete — each gated by its own marker (PR #291 round-6 #2 + round-7
        // #2/#3). A completed effect is skipped; a missing one is finished so a
        // reopen/interrupt or an @mention is never lost.
        const resumed = await resumeIncompleteCommentSideEffects({
          req,
          res,
          issue,
          comment: replay,
          reopenRequested: req.body.reopen === true,
          interruptRequested: req.body.interrupt === true,
        });
        if (!resumed.ok) return;
        res.status(200).json(replay);
        return;
      }
    }

    const actor = getActorInfo(req);
    const interruptRequested = req.body.interrupt === true;
    // Authz up front (no mutations); the reopen/interrupt effects run only after
    // the insert is won, below (round-4 review).
    if (!assertInterruptAuthorized(req, res, interruptRequested)) return;

    // Round-17 #1: pre-compute the control-effect OUTCOME so the wakeup targets can
    // be enqueued INSIDE addComment's transaction (a committed comment always
    // carries its pending wakeups). The reopen outcome is deterministic from the
    // pre-state (`reopen && isClosed`), and the interrupt target run is resolved
    // read-only here; the actual reopen/interrupt MUTATIONS still run after the
    // insert is won (below), unchanged.
    const isClosed = issue.status === "done" || issue.status === "cancelled";
    const willReopen = req.body.reopen === true && isClosed;
    const preReopenFromStatus = willReopen ? issue.status : null;
    const preInterruptedRunId = interruptRequested ? await resolveInterruptTargetRunId(issue) : null;
    // Round-18 #3: the wakeup describes reopen/interrupt effects that are applied
    // AFTER this comment tx commits, so DEFER the row until those effects are
    // durable (flipped ready below). A plain comment (no reopen/interrupt) has no
    // post-insert side effects → immediately drainable.
    const deferWakeups = willReopen || interruptRequested;

    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
      clientSubmissionId,
      wakeupDeferUntil: deferWakeups ? new Date(Date.now() + COMMENT_WAKEUP_DEFER_GRACE_MS) : null,
      buildWakeupTargets: (c) =>
        buildIssueCommentWakeupTargets({
          issue,
          currentIssue: issue,
          comment: c,
          body: req.body.body,
          actor,
          reopened: willReopen,
          reopenFromStatus: preReopenFromStatus,
          interruptedRunId: preInterruptedRunId,
        }),
    });

    // Lost the insert race (both same-key requests passed the pre-check): the
    // winner created the comment. RESUME any of its side effects that are not yet
    // marked complete (round-7 #2/#3) — the winner may have crashed before
    // reopening or waking — then return without re-firing completed ones.
    if ((comment as { replayed?: boolean }).replayed) {
      const resumed = await resumeIncompleteCommentSideEffects({
        req,
        res,
        issue,
        comment: comment as typeof comment & { body: string },
        reopenRequested: req.body.reopen === true,
        interruptRequested,
      });
      if (!resumed.ok) return;
      res.status(200).json(comment);
      return;
    }

    // Insert won → apply the deferred control effects exactly once.
    const control = await applyIssueCommentControlEffects({
      req,
      res,
      issue,
      actor,
      reopenRequested: req.body.reopen === true,
      interruptRequested,
    });
    if (!control.ok) return;
    // Stamp control-effects completion (round-6 #2) so a retry skips them.
    if (clientSubmissionId) await svc.markCommentControlEffectsCompleted(comment.id);
    const { currentIssue, reopened, reopenFromStatus, interruptedRunId } = control;

    // Round-18 #3: the reopen/interrupt control effects are now durable → flip the
    // deferred wakeup rows to drainable so the worker can wake the assignee (who
    // will now see the reopened task / cancelled run). If the process crashed
    // before this flip, the row's ready_at grace window is the backstop.
    if (deferWakeups) await svc.markCommentWakeupsReady(comment.id);

    await logActivity(db, {
      companyId: currentIssue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: currentIssue.id,
      details: {
        commentId: comment.id,
        bodySnippet: comment.body.slice(0, 120),
        identifier: currentIssue.identifier,
        issueTitle: currentIssue.title,
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
      },
    });

    // Round-17 #1: the comment's per-agent wakeups were enqueued INSIDE
    // addComment's transaction above (buildWakeupTargets, from the pre-computed
    // control-effect outcome), so a committed comment always carries its pending
    // wakeup rows. The durable worker delivers each exactly once (per-target rows +
    // (comment, agent) idempotency + the round-17 #2 idempotent-consumer key).

    res.status(201).json(comment);
  });

  router.post("/issues/:id/comments-with-attachments", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyAccess(db, req, issue.companyId);
    if (!(await assertAgentRunCheckoutOwnership(req, res, issue))) return;

    try {
      await runMultiFileUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
          res.status(422).json({ error: `At most ${MAX_ATTACHMENTS_PER_COMMENT} attachments are allowed` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const files = ((req as Request & { files?: Express.Multer.File[] }).files ?? []);
    // P2 (PR #291 round-3 review): task comments are a unified-composer upload
    // path — never trust the multipart mimetype. Validate the allowlist AND
    // sniff the real bytes so a caller cannot mislabel arbitrary content as an
    // allowed image/PDF/text type (mirrors the /assets/files composer guard).
    for (const file of files) sniffCommentAttachment(file);

    // Idempotent retry: replay the original comment + its attachments without
    // re-creating records or re-firing control effects/wakeups. The comment
    // commits BEFORE its files below, so the original send can die with the
    // comment durable but attachments missing — the retry re-sends the files,
    // and the replay must COMPLETE the missing ones (matched by content hash +
    // filename, multiset) instead of silently returning the partial set
    // (PR #291 review).
    //
    // The same completion path serves the route-level replay pre-check AND the
    // insert-race loser (addComment returns `replayed` when it lost the race),
    // so neither re-fires post-insert side-effects (PR #291 round-3 review).
    // Returns the (now-complete) attachment rows so the caller can resume wakeups
    // with them BEFORE responding — the wakeup must not be marked done until the
    // files are actually stored (round-8 #2).
    const completeReplayedCommentAttachments = async (replay: { id: string }) => {
      let replayAttachments = (await svc.listAttachments(id)).filter(
        (a) => a.issueCommentId === replay.id,
      );
      if (files.length > 0) {
        const replayActor = getActorInfo(req);
        // C6 (PR #291 review): serialize the completion so two concurrent
        // same-key retries cannot each create the same missing attachment.
        // The advisory lock lives inside the service transaction; `store`
        // runs there only for genuinely-missing files.
        const { created, all } = await svc.completeMissingCommentAttachments({
          companyId: issue.companyId,
          issueId: id,
          commentId: replay.id,
          createdByAgentId: replayActor.agentId,
          createdByUserId: replayActor.actorType === "user" ? replayActor.actorId : null,
          files: files.map((file) => ({
            contentType: validateAttachmentFile(file),
            buffer: file.buffer,
            originalFilename: file.originalname || null,
          })),
          store: async (file) =>
            storage.putFile({
              companyId: issue.companyId,
              organizationId: await resolveStorageTenant(db, issue.companyId),
              namespace: `issues/${id}`,
              originalFilename: file.originalFilename,
              contentType: file.contentType,
              body: file.buffer,
            }),
        });
        replayAttachments = all;
        for (const attachment of created) {
          await logActivity(db, {
            companyId: issue.companyId,
            actorType: replayActor.actorType,
            actorId: replayActor.actorId,
            agentId: replayActor.agentId,
            runId: replayActor.runId,
            action: "issue.attachment_added",
            entityType: "issue",
            entityId: id,
            details: {
              attachmentId: attachment.id,
              originalFilename: attachment.originalFilename,
              contentType: attachment.contentType,
              byteSize: attachment.byteSize,
              commentId: replay.id,
              completedOnRetry: true,
            },
          });
        }
      }
      return replayAttachments;
    };

    const clientSubmissionId =
      typeof req.body?.clientSubmissionId === "string" ? req.body.clientSubmissionId : undefined;
    if (clientSubmissionId) {
      const replay = await svc.getCommentByClientSubmissionId(issue.companyId, id, clientSubmissionId);
      if (replay) {
        // Round-8 #2: COMPLETE the missing attachments FIRST, then resume control
        // effects + wakeups carrying the completed attachment rows — so the
        // wakeup marker is never stamped before the files are stored and the
        // woken agent receives the attachment metadata.
        const replayAttachments = await completeReplayedCommentAttachments(replay);
        const resumed = await resumeIncompleteCommentSideEffects({
          req,
          res,
          issue,
          comment: replay,
          reopenRequested: parseMultipartBoolean(req.body?.reopen),
          interruptRequested: parseMultipartBoolean(req.body?.interrupt),
          attachments: replayAttachments,
        });
        if (!resumed.ok) return;
        res.status(200).json({ comment: replay, attachments: replayAttachments });
        return;
      }
    }

    const actor = getActorInfo(req);
    const bodyText = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    const body = bodyText || (files.length > 0
      ? `Attached ${files.length} file${files.length === 1 ? "" : "s"}`
      : "");
    if (!body) {
      res.status(400).json({ error: "Comment body or attachments are required" });
      return;
    }

    const interruptRequested = parseMultipartBoolean(req.body?.interrupt);
    // Authz up front (no mutations); reopen/interrupt effects run only after the
    // insert is won, below (round-4 review).
    if (!assertInterruptAuthorized(req, res, interruptRequested)) return;

    // Round-17 #1: pre-validate the files + PRE-GENERATE their ids and previews so
    // the comment wakeup — carrying attachment metadata — can be enqueued INSIDE
    // addComment's transaction (a committed comment always has its pending wakeups),
    // and pre-compute the control-effect outcome (deterministic reopen intent +
    // read-only interrupt-run resolution). The files are STORED after the insert is
    // won (external putFile can't run in the tx); the pre-generated ids are threaded
    // into createAttachment so the stored rows match the in-tx wakeup previews.
    const preparedFiles = files.map((file) => ({
      file,
      contentType: validateAttachmentFile(file),
      attachmentId: randomUUID(),
    }));
    const attachmentPreviews: CommentWakeAttachment[] = preparedFiles.map((p) => ({
      id: p.attachmentId,
      originalFilename: p.file.originalname || null,
      contentType: p.contentType,
      byteSize: p.file.buffer.length,
    }));
    const isClosed = issue.status === "done" || issue.status === "cancelled";
    const willReopen = parseMultipartBoolean(req.body?.reopen) && isClosed;
    const preReopenFromStatus = willReopen ? issue.status : null;
    const preInterruptedRunId = interruptRequested ? await resolveInterruptTargetRunId(issue) : null;
    // Round-18 #2/#3: the wakeup references the attachment rows (stored after the
    // comment tx) and any reopen/interrupt effect, so DEFER the row until they are
    // durable (flipped ready after the storage loop + control effects below). The
    // ready_at grace window is the crash backstop.
    const deferWakeups = preparedFiles.length > 0 || willReopen || interruptRequested;

    const comment = await svc.addComment(id, body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
      clientSubmissionId,
      wakeupDeferUntil: deferWakeups ? new Date(Date.now() + COMMENT_WAKEUP_DEFER_GRACE_MS) : null,
      buildWakeupTargets: (c) =>
        buildIssueCommentWakeupTargets({
          issue,
          currentIssue: issue,
          comment: c,
          body,
          actor,
          reopened: willReopen,
          reopenFromStatus: preReopenFromStatus,
          interruptedRunId: preInterruptedRunId,
          attachments: attachmentPreviews,
        }),
    });

    // Lost the insert race (both same-key requests passed the pre-check): the
    // winner created + linked the comment. RESUME any of its side effects not yet
    // marked complete (round-7 #2/#3) — the winner may have crashed before
    // reopening or waking — complete missing attachments through the serialized
    // path, and return without re-firing completed effects (round-3/4 review).
    if ((comment as { replayed?: boolean }).replayed) {
      // Round-8 #2: complete missing attachments FIRST, then resume side effects
      // carrying the completed rows, then respond.
      const replayAttachments = await completeReplayedCommentAttachments(comment);
      const resumed = await resumeIncompleteCommentSideEffects({
        req,
        res,
        issue,
        comment: comment as typeof comment & { body: string },
        reopenRequested: parseMultipartBoolean(req.body?.reopen),
        interruptRequested,
        attachments: replayAttachments,
      });
      if (!resumed.ok) return;
      res.status(200).json({ comment, attachments: replayAttachments });
      return;
    }

    // Insert won → apply the deferred control effects exactly once.
    const control = await applyIssueCommentControlEffects({
      req,
      res,
      issue,
      actor,
      reopenRequested: parseMultipartBoolean(req.body?.reopen),
      interruptRequested,
    });
    if (!control.ok) return;
    // Stamp control-effects completion (round-6 #2) so a retry skips them.
    if (clientSubmissionId) await svc.markCommentControlEffectsCompleted(comment.id);
    const { currentIssue, reopened, reopenFromStatus, interruptedRunId } = control;

    // Explicit element type: `attachments` is now captured in the claim-gated
    // dispatch closure below (round-12 #1), so TS can no longer infer the empty
    // literal's type from its later synchronous use.
    const attachments: Awaited<ReturnType<typeof svc.createAttachment>>[] = [];
    for (const prepared of preparedFiles) {
      const { file, contentType, attachmentId } = prepared;
      const stored = await storage.putFile({
        companyId: issue.companyId,
        organizationId: await resolveStorageTenant(db, issue.companyId),
        namespace: `issues/${id}`,
        originalFilename: file.originalname || null,
        contentType,
        body: file.buffer,
      });

      const attachment = await svc.createAttachment({
        // Round-17 #1: the pre-generated id already carried into the in-tx wakeup.
        id: attachmentId,
        issueId: id,
        issueCommentId: comment.id,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      attachments.push(attachment);

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.attachment_added",
        entityType: "issue",
        entityId: id,
        details: {
          attachmentId: attachment.id,
          originalFilename: attachment.originalFilename,
          contentType: attachment.contentType,
          byteSize: attachment.byteSize,
          commentId: comment.id,
        },
      });
    }

    await logActivity(db, {
      companyId: currentIssue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: currentIssue.id,
      details: {
        commentId: comment.id,
        bodySnippet: comment.body.slice(0, 120),
        identifier: currentIssue.identifier,
        issueTitle: currentIssue.title,
        attachmentCount: attachments.length,
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
      },
    });

    // Round-17 #1: the comment's per-agent wakeups (carrying the attachment
    // previews) were enqueued INSIDE addComment's transaction above, so a committed
    // comment always carries its pending wakeup rows. Round-18 #2/#3: they were
    // enqueued DEFERRED — now the attachment rows + control effects are durable, so
    // flip them ready. The worker then delivers each exactly once (per-target rows
    // + (comment, agent) idempotency + the round-17 #2 idempotent-consumer key); a
    // crash before this flip is covered by the ready_at grace backstop.
    if (deferWakeups) await svc.markCommentWakeupsReady(comment.id);

    res.status(201).json({
      comment,
      attachments: attachments.map(withContentPath),
    });
  });

  router.get("/issues/:id/attachments", async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyAccess(db, req, issue.companyId);
    const attachments = await svc.listAttachments(issueId);
    res.json(attachments.map(withContentPath));
  });

  router.get("/issues/:id/context-bundles", async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyAccess(db, req, issue.companyId);
    const bundles = await listIssueContextBundlesForIssue(db, issue.companyId, issueId);
    res.json(bundles);
  });

  router.patch("/issues/:id/context-bundles/items/:itemId", async (req, res) => {
    const issueId = req.params.id as string;
    const itemId = req.params.itemId as string;
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertBoard(req);
    await assertCompanyAccess(db, req, issue.companyId);

    if (typeof req.body?.included !== "boolean") {
      throw unprocessable("included must be a boolean");
    }

    const item = await setIssueContextBundleItemIncluded(db, {
      companyId: issue.companyId,
      targetIssueId: issueId,
      itemId,
      included: req.body.included,
    });
    if (!item) {
      res.status(404).json({ error: "Context bundle item not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      action: "issue.context_handoff_updated",
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      entityType: "issue",
      entityId: issueId,
      details: {
        itemId,
        included: req.body.included,
      },
    });

    res.json(item);
  });

  router.post("/companies/:companyId/issues/:issueId/attachments", async (req, res) => {
    const companyId = req.params.companyId as string;
    const issueId = req.params.issueId as string;
    await assertCompanyAccess(db, req, companyId);
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (issue.companyId !== companyId) {
      res.status(422).json({ error: "Issue does not belong to company" });
      return;
    }

    try {
      await runSingleFileUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    let contentType: string;
    try {
      contentType = validateAttachmentFile(file);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message, details: err.details });
        return;
      }
      throw err;
    }

    const parsedMeta = createIssueAttachmentMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid attachment metadata", details: parsedMeta.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      organizationId: await resolveStorageTenant(db, companyId),
      namespace: `issues/${issueId}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const attachment = await svc.createAttachment({
      issueId,
      issueCommentId: parsedMeta.data.issueCommentId ?? null,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.attachment_added",
      entityType: "issue",
      entityId: issueId,
      details: {
        attachmentId: attachment.id,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
      },
    });

    res.status(201).json(withContentPath(attachment));
  });

  router.get("/attachments/:attachmentId/content", async (req, res, next) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    await assertCompanyAccess(db, req, attachment.companyId);

    const object = await storage.getObject(
      await resolveStorageTenant(db, attachment.companyId),
      attachment.companyId,
      attachment.objectKey,
    );
    const safe = getSafeServingHeaders(
      attachment.contentType || object.contentType,
      attachment.originalFilename,
    );
    res.setHeader("Content-Type", safe.contentType);
    res.setHeader("Content-Length", String(attachment.byteSize || object.contentLength || 0));
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("Content-Disposition", safe.contentDisposition);
    res.setHeader("X-Content-Type-Options", safe.xContentTypeOptions);

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  router.delete("/attachments/:attachmentId", async (req, res) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    await assertCompanyAccess(db, req, attachment.companyId);

    try {
      await storage.deleteObject(
        await resolveStorageTenant(db, attachment.companyId),
        attachment.companyId,
        attachment.objectKey,
      );
    } catch (err) {
      logger.warn({ err, attachmentId }, "storage delete failed while removing attachment");
    }

    const removed = await svc.removeAttachment(attachmentId);
    if (!removed) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.attachment_removed",
      entityType: "issue",
      entityId: removed.issueId,
      details: {
        attachmentId: removed.id,
      },
    });

    res.json({ ok: true });
  });

  // --- Issue Documents ---

  router.get("/issues/:id/documents", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) { res.status(404).json({ error: "Issue not found" }); return; }
    await assertCompanyAccess(db, req, issue.companyId);
    const docs = await documentsSvc.listIssueDocuments(issue.id);
    res.json(docs);
  });

  router.get("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) { res.status(404).json({ error: "Issue not found" }); return; }
    await assertCompanyAccess(db, req, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) { res.status(400).json({ error: "Invalid document key" }); return; }
    const doc = await documentsSvc.getIssueDocumentByKey(issue.id, keyParsed.data);
    if (!doc) { res.status(404).json({ error: "Document not found" }); return; }
    res.json(doc);
  });

  router.put("/issues/:id/documents/:key", validate(upsertIssueDocumentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) { res.status(404).json({ error: "Issue not found" }); return; }
    await assertCompanyAccess(db, req, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) { res.status(400).json({ error: "Invalid document key" }); return; }
    const actor = getActorInfo(req);
    const result = await documentsSvc.upsertIssueDocument({
      issueId: issue.id,
      key: keyParsed.data,
      title: req.body.title ?? null,
      format: req.body.format,
      body: req.body.body,
      changeSummary: req.body.changeSummary ?? null,
      baseRevisionId: req.body.baseRevisionId ?? null,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: result.created ? "issue.document_created" : "issue.document_updated",
      entityType: "issue",
      entityId: issue.id,
      details: { key: result.document.key, documentId: result.document.id },
    });
    res.status(result.created ? 201 : 200).json(result.document);
  });

  router.get("/issues/:id/documents/:key/revisions", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) { res.status(404).json({ error: "Issue not found" }); return; }
    await assertCompanyAccess(db, req, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) { res.status(400).json({ error: "Invalid document key" }); return; }
    const revisions = await documentsSvc.listIssueDocumentRevisions(issue.id, keyParsed.data);
    res.json(revisions);
  });

  router.delete("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) { res.status(404).json({ error: "Issue not found" }); return; }
    await assertCompanyAccess(db, req, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) { res.status(400).json({ error: "Invalid document key" }); return; }
    const actor = getActorInfo(req);
    const deleted = await documentsSvc.deleteIssueDocument(issue.id, keyParsed.data);
    if (!deleted) { res.status(404).json({ error: "Document not found" }); return; }
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.document_deleted",
      entityType: "issue",
      entityId: issue.id,
      details: { key: deleted.key, documentId: deleted.id },
    });
    res.json({ ok: true });
  });

  return router;
}
