import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { eq, and } from "drizzle-orm";
import { discussions, threadInboxItems, internalAgentConfig } from "@armyofagents/db";
import { z } from "zod";
import {
  createDiscussionSchema,
  createDiscussionEntrySchema,
  updateDiscussionSchema,
  approveItemsSchema,
  createAnnotationSchema,
  THREAD_PHASES,
  THREAD_PARTICIPANT_PRINCIPAL_TYPES,
  THREAD_PARTICIPANT_ROLES,
  THREAD_LINK_KINDS,
} from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { discussionService, logActivity, permissionService } from "../services/index.js";
import { HttpError } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { assertHumanRole, assertMemoryApproval, assertRole } from "../middleware/rbac.js";
import { threadService, resolveMentionTargets, assertCanPostToThread } from "../services/threads.js";
import type { Actor } from "../services/threads.js";
import { threadScopeVersionService } from "../services/thread-scope-versions.js";
import { enqueueIssueAssigneeWakeup } from "../services/issue-assignee-wakeup.js";
import { logger } from "../middleware/logger.js";
import { shouldDispatchIssueWakeup } from "./issues-planning-mode-dispatch.js";
import { attachInboxItemToThread, promoteInboxItemToNewThread } from "../services/inbox-attach.js";

// ── Thread lifecycle request-body schemas ────────────────────────────────────
const phaseSchema = z.object({ phase: z.enum(THREAD_PHASES) });
const transferSchema = z.object({ toUserId: z.string().min(1) });
const addParticipantSchema = z.object({
  principalType: z.enum(THREAD_PARTICIPANT_PRINCIPAL_TYPES),
  principalId: z.string().min(1),
  role: z.enum(THREAD_PARTICIPANT_ROLES),
});
const createScopeDraftSchema = z.object({
  summary: z.string().min(1).optional(),
  assumptions: z.array(z.unknown()).optional(),
  decisions: z.array(z.unknown()).optional(),
  openQuestions: z.array(z.unknown()).optional(),
  mode: z.enum(["generate", "manual"]).optional(),
});
const updateScopeDraftSchema = createScopeDraftSchema.omit({ mode: true }).partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one scope field is required" },
);
const acceptScopeDraftSchema = z.object({
  itemIds: z.array(z.string()).default([]),
});
const reviewScopeItemsSchema = z.object({
  items: z.array(z.object({
    itemId: z.string().uuid(),
    status: z.enum(["draft", "accepted", "rejected"]),
  })).min(1),
});
const updateScopeItemSchema = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().nullable().optional(),
  payload: z.record(z.unknown()).optional(),
  sourceEntryIds: z.array(z.string().uuid()).optional(),
  status: z.enum(["draft", "accepted", "rejected"]).optional(),
});

function scopeVersionFailureStatus(reason: string): number {
  const statusMap: Record<string, number> = {
    not_found: 404,
    item_not_found: 404,
    stale: 409,
    not_draft: 409,
    rejected: 409,
    nothing_accepted: 422,
    unsupported_action: 422,
    invalid_status: 422,
    already_applied: 409,
  };
  return statusMap[reason] ?? 400;
}

async function logScopeActivity(
  db: Db,
  req: Parameters<typeof getActorInfo>[0],
  companyId: string,
  action: string,
  discussionId: string,
  details: Record<string, unknown>,
) {
  const actor = getActorInfo(req);
  try {
    await logActivity(db, {
      companyId,
      action,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      entityType: "discussion",
      entityId: discussionId,
      details,
    });
  } catch (err) {
    logger.warn(
      { err, action, discussionId, companyId },
      "scope activity log failed (non-fatal; mutation already applied)",
    );
  }
}

export function discussionRoutes(db: Db) {
  const router = Router();
  const svc = discussionService(db);

  // 1.1 List discussions
  router.get("/companies/:companyId/discussions", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);

    const filters = {
      status: req.query.status as string | undefined,
      scopeType: req.query.scopeType as string | undefined,
      scopeId: req.query.scopeId as string | undefined,
      hasPendingItems:
        req.query.hasPendingItems === "true"
          ? true
          : req.query.hasPendingItems === "false"
            ? false
            : undefined,
      inputType: req.query.inputType as string | undefined,
    };

    const result = await svc.list(companyId, filters);
    res.json({
      discussions: result,
      total: result.length,
      limit: 50,
      offset: 0,
    });
  });

  // ── Inbox endpoints (must precede /:discussionId to avoid static-vs-param shadowing) ──

  // T.I1 List pending inbox items (the Unlisted lane)
  router.get(
    "/companies/:companyId/discussions/inbox",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder", "team_lead");

      const { desc } = await import("drizzle-orm");

      const items = await db
        .select()
        .from(threadInboxItems)
        .where(
          and(
            eq(threadInboxItems.companyId, companyId),
            eq(threadInboxItems.status, "pending"),
          ),
        )
        .orderBy(desc(threadInboxItems.createdAt));

      res.json({ items, total: items.length });
    },
  );

  // T.I1b POST /companies/:companyId/discussions/inbox — manual paste producer (Task 0.6, Decision #14)
  // Enqueues a raw paste into thread_inbox_items.  Distinct from the triage POST
  // (/inbox/:itemId/triage) — this creates a NEW inbox row from a manual human paste.
  // RBAC: founder + team_lead (mirrors GET inbox auth).
  router.post(
    "/companies/:companyId/discussions/inbox",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder", "team_lead");

      const { rawContent, originSource } = req.body as {
        rawContent?: unknown;
        originSource?: unknown;
      };

      if (typeof rawContent !== "string" || rawContent.trim() === "") {
        res.status(400).json({ error: "rawContent is required and must be a non-empty string" });
        return;
      }

      const { enqueueInboxItem } = await import("../services/inbox-producer.js");
      const actor = getActorInfo(req);
      const resolvedSource =
        typeof originSource === "string" && originSource.trim() !== ""
          ? originSource
          : actor.actorId;

      const result = await enqueueInboxItem(db, {
        companyId,
        originMedium: "paste",
        originSource: resolvedSource,
        rawContent,
      });

      res.status(201).json(result);
    },
  );

  // 1.2 Get discussion detail
  router.get(
    "/companies/:companyId/discussions/:discussionId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);

      const discussion = await svc.getById(companyId, discussionId);
      if (!discussion) {
        res.status(404).json({ error: "Discussion not found" });
        return;
      }
      res.json(discussion);
    },
  );

  router.get(
    "/companies/:companyId/discussions/:discussionId/scope-versions",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);

      try {
        const versions = await threadScopeVersionService(db).listVersions(companyId, discussionId);
        res.json({ versions, total: versions.length });
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  router.post(
    "/companies/:companyId/discussions/:discussionId/scope-versions/draft",
    validate(createScopeDraftSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);
      assertBoard(req);
      await assertHumanRole(db, req, companyId, "founder", "team_lead");

      const actor = getActorInfo(req);
      try {
        const result = await threadScopeVersionService(db).createDraftFromThread(
          companyId,
          discussionId,
          { userId: actor.actorId, agentId: actor.agentId ?? undefined, isHuman: actor.actorType === "user" },
          req.body,
        );
        await logScopeActivity(db, req, companyId, "discussion.scope_version_draft_created", discussionId, {
          scopeVersionId: result.version?.id ?? null,
          status: result.status,
        });
        res.status(result.status === "created" ? 201 : 200).json(result);
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  router.get(
    "/companies/:companyId/discussions/:discussionId/scope-versions/:scopeVersionId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      const scopeVersionId = req.params.scopeVersionId as string;
      await assertCompanyAccess(db, req, companyId);

      const version = await threadScopeVersionService(db).getVersion(companyId, discussionId, scopeVersionId);
      if (!version) {
        res.status(404).json({ error: "Scope version not found" });
        return;
      }
      res.json(version);
    },
  );

  router.patch(
    "/companies/:companyId/discussions/:discussionId/scope-versions/:scopeVersionId",
    validate(updateScopeDraftSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      const scopeVersionId = req.params.scopeVersionId as string;
      await assertCompanyAccess(db, req, companyId);
      assertBoard(req);
      await assertHumanRole(db, req, companyId, "founder", "team_lead");

      const version = await threadScopeVersionService(db).updateDraft(companyId, discussionId, scopeVersionId, req.body);
      if (!version) {
        res.status(404).json({ error: "Scope draft not found" });
        return;
      }
      await logScopeActivity(db, req, companyId, "discussion.scope_version_updated", discussionId, {
        scopeVersionId,
        fields: Object.keys(req.body ?? {}),
      });
      res.json(version);
    },
  );

  router.post(
    "/companies/:companyId/discussions/:discussionId/scope-versions/:scopeVersionId/items/review",
    validate(reviewScopeItemsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      const scopeVersionId = req.params.scopeVersionId as string;
      await assertCompanyAccess(db, req, companyId);
      assertBoard(req);
      await assertRole(db, req, companyId, "founder", "team_lead");

      const actor = getActorInfo(req);
      try {
        const result = await threadScopeVersionService(db).reviewItems(
          companyId,
          discussionId,
          scopeVersionId,
          req.body,
          { userId: actor.actorId, agentId: actor.agentId ?? undefined, isHuman: actor.actorType === "user" },
        );
        if (!result.ok) {
          res.status(scopeVersionFailureStatus(result.reason)).json({ error: result.message });
          return;
        }
        await logScopeActivity(db, req, companyId, "discussion.scope_items_reviewed", discussionId, {
          scopeVersionId,
          itemCount: req.body.items.length,
          statuses: req.body.items.map((item: { status: string }) => item.status),
        });
        res.json(result);
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  router.patch(
    "/companies/:companyId/discussions/:discussionId/scope-versions/:scopeVersionId/items/:itemId",
    validate(updateScopeItemSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      const scopeVersionId = req.params.scopeVersionId as string;
      const itemId = req.params.itemId as string;
      await assertCompanyAccess(db, req, companyId);
      assertBoard(req);
      await assertRole(db, req, companyId, "founder", "team_lead");

      const actor = getActorInfo(req);
      try {
        const result = await threadScopeVersionService(db).updateItem(
          companyId,
          discussionId,
          scopeVersionId,
          itemId,
          req.body,
          { userId: actor.actorId, agentId: actor.agentId ?? undefined, isHuman: actor.actorType === "user" },
        );
        if (!result.ok) {
          res.status(scopeVersionFailureStatus(result.reason)).json({ error: result.message });
          return;
        }
        await logScopeActivity(db, req, companyId, "discussion.scope_item_updated", discussionId, {
          scopeVersionId,
          itemId,
          fields: Object.keys(req.body ?? {}),
        });
        res.json(result);
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  router.post(
    "/companies/:companyId/discussions/:discussionId/scope-versions/:scopeVersionId/items/:itemId/create",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      const scopeVersionId = req.params.scopeVersionId as string;
      const itemId = req.params.itemId as string;
      await assertCompanyAccess(db, req, companyId);
      assertBoard(req);
      await assertRole(db, req, companyId, "founder", "team_lead");

      const actor = getActorInfo(req);
      try {
        const memoryStatus =
          req.body?.memoryStatus === "approved" || req.body?.memoryStatus === "pending"
            ? req.body.memoryStatus
            : undefined;
        const options = memoryStatus
          ? {
              memoryStatus,
              ...(memoryStatus === "approved"
                ? {
                    approveMemory: (memoryItem: { layer?: string | null; departmentId?: string | null }) =>
                      assertMemoryApproval(db, req, companyId, memoryItem),
                  }
                : {}),
            }
          : undefined;
        const result = await threadScopeVersionService(db).createOutputItem(
          companyId,
          discussionId,
          scopeVersionId,
          itemId,
          { userId: actor.actorId, agentId: actor.agentId ?? undefined, isHuman: actor.actorType === "user" },
          ...(options ? [options] : []),
        );
        if (!result.ok) {
          res.status(scopeVersionFailureStatus(result.reason)).json({ error: result.message });
          return;
        }

        if (result.createdTask && shouldDispatchIssueWakeup(result.createdTask) && result.createdTask.assigneeAgentId) {
          await enqueueIssueAssigneeWakeup(db, {
            companyId,
            issueId: result.createdTask.id,
            agentId: result.createdTask.assigneeAgentId,
            source: "assignment",
            reason: "scope_item_create",
            requestedByActorType: actor.actorType === "agent" ? "agent" : "user",
            requestedByActorId: actor.actorId,
          });
        }
        await logScopeActivity(db, req, companyId, "discussion.scope_item_output_created", discussionId, {
          scopeVersionId,
          itemId,
          resultIssueId: result.createdTask?.id ?? null,
          resultMemoryId: result.createdMemoryId ?? null,
          artifactLinkId: result.artifactLinkId ?? null,
          memoryStatus: memoryStatus ?? null,
        });
        res.json(result);
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  router.post(
    "/companies/:companyId/discussions/:discussionId/scope-versions/:scopeVersionId/apply",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      const scopeVersionId = req.params.scopeVersionId as string;
      await assertCompanyAccess(db, req, companyId);
      assertBoard(req);
      await assertRole(db, req, companyId, "founder", "team_lead");

      const actor = getActorInfo(req);
      try {
        const result = await threadScopeVersionService(db).applyAcceptedDraft(
          companyId,
          discussionId,
          scopeVersionId,
          { userId: actor.actorId, agentId: actor.agentId ?? undefined, isHuman: actor.actorType === "user" },
        );
        if (!result.ok) {
          res.status(scopeVersionFailureStatus(result.reason)).json({ error: result.message });
          return;
        }

        for (const task of result.createdTasks) {
          if (shouldDispatchIssueWakeup(task) && task.assigneeAgentId) {
            await enqueueIssueAssigneeWakeup(db, {
              companyId,
              issueId: task.id,
              agentId: task.assigneeAgentId,
              source: "assignment",
              reason: "scope_version_apply",
              requestedByActorType: actor.actorType === "agent" ? "agent" : "user",
              requestedByActorId: actor.actorId,
            });
          }
        }
        await logScopeActivity(db, req, companyId, "discussion.scope_version_applied", discussionId, {
          scopeVersionId,
          createdTaskIds: result.createdTasks.map((task) => task.id),
          appliedItemIds: result.appliedItems.map((item) => item.id),
        });
        res.json(result);
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  router.post(
    "/companies/:companyId/discussions/:discussionId/scope-versions/:scopeVersionId/accept",
    validate(acceptScopeDraftSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      const scopeVersionId = req.params.scopeVersionId as string;
      await assertCompanyAccess(db, req, companyId);
      assertBoard(req);
      await assertRole(db, req, companyId, "founder", "team_lead");

      const actor = getActorInfo(req);
      const result = await threadScopeVersionService(db).acceptDraft(
        companyId,
        discussionId,
        scopeVersionId,
        { itemIds: req.body.itemIds },
        { userId: actor.actorId, agentId: actor.agentId ?? undefined, isHuman: actor.actorType === "user" },
      );

      if (!result.ok) {
        res.status(scopeVersionFailureStatus(result.reason)).json({ error: result.message });
        return;
      }

      for (const task of result.createdTasks) {
        if (shouldDispatchIssueWakeup(task) && task.assigneeAgentId) {
          await enqueueIssueAssigneeWakeup(db, {
            companyId,
            issueId: task.id,
            agentId: task.assigneeAgentId,
            source: "assignment",
            reason: "scope_version_accept",
            requestedByActorType: actor.actorType === "agent" ? "agent" : "user",
            requestedByActorId: actor.actorId,
          });
        }
      }
      await logScopeActivity(db, req, companyId, "discussion.scope_version_accepted", discussionId, {
        scopeVersionId,
        selectedItemIds: req.body.itemIds ?? [],
        createdTaskIds: result.createdTasks.map((task) => task.id),
        appliedItemIds: result.appliedItems.map((item) => item.id),
      });
      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/discussions/:discussionId/scope-versions/:scopeVersionId/reject",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      const scopeVersionId = req.params.scopeVersionId as string;
      await assertCompanyAccess(db, req, companyId);
      assertBoard(req);
      await assertRole(db, req, companyId, "founder", "team_lead");

      const actor = getActorInfo(req);
      const result = await threadScopeVersionService(db).rejectDraft(
        companyId,
        discussionId,
        scopeVersionId,
        { userId: actor.actorId, agentId: actor.agentId ?? undefined, isHuman: actor.actorType === "user" },
      );
      if (!result.ok) {
        res.status(404).json({ error: "Scope draft not found" });
        return;
      }
      await logScopeActivity(db, req, companyId, "discussion.scope_version_rejected", discussionId, {
        scopeVersionId,
      });
      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/discussions/:discussionId/scope-versions/:scopeVersionId/complete",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      const scopeVersionId = req.params.scopeVersionId as string;
      await assertCompanyAccess(db, req, companyId);
      assertBoard(req);
      await assertRole(db, req, companyId, "founder", "team_lead");

      const actor = getActorInfo(req);
      const result = await threadScopeVersionService(db).completeVersion(
        companyId,
        discussionId,
        scopeVersionId,
        { userId: actor.actorId, agentId: actor.agentId ?? undefined, isHuman: actor.actorType === "user" },
      );
      if (!result.ok) {
        res.status(404).json({ error: "Scope version not found" });
        return;
      }
      await logScopeActivity(db, req, companyId, "discussion.scope_version_completed", discussionId, {
        scopeVersionId,
      });
      res.json(result);
    },
  );

  // 1.3 Create discussion
  router.post(
    "/companies/:companyId/discussions",
    validate(createDiscussionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder", "team_lead");

      const actor = getActorInfo(req);

      // Round-14 #2 + round-15: resolve the opening message's @mentions BEFORE
      // svc.create (multi-word-aware roster read), then thread them INTO svc.create
      // so the summon is enqueued in the discussion_mention_outbox IN THE SAME
      // transaction as the first entry. This makes the durable outbox worker the
      // SOLE summon path here too — exactly like addEntry — so a transient summon
      // failure retries instead of permanently skipping the mentioned agent (the
      // old fire-and-forget processMentions only logged on failure). Resolving
      // pre-commit still fails cleanly on a roster-query blip (nothing created →
      // safe retry; the create endpoint has no idempotency key). The content is the
      // same one svc.create will insert (req.body.entry).
      const openingContent =
        typeof (req.body?.entry as { rawContent?: unknown } | undefined)?.rawContent === "string"
          ? (req.body.entry.rawContent as string)
          : "";
      const openingMentions = openingContent
        ? await resolveMentionTargets(db, companyId, openingContent)
        : [];

      try {
        const discussion = await svc.create(companyId, req.body, actor.actorId, openingMentions);
        // No direct processMentions here (round-15): svc.create enqueued the
        // opening summon transactionally; the outbox worker drains it exactly once.
        res.status(201).json(discussion);
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // 1.4 Update discussion
  router.patch(
    "/companies/:companyId/discussions/:discussionId",
    validate(updateDiscussionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder", "team_lead");

      try {
        const updated = await svc.update(companyId, discussionId, req.body);
        if (!updated) {
          res.status(404).json({ error: "Discussion not found" });
          return;
        }

        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "discussion.updated",
          entityType: "discussion",
          entityId: discussionId,
          details: req.body,
        });

        res.json(updated);
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // 1.5 Add entry to discussion
  router.post(
    "/companies/:companyId/discussions/:discussionId/entries",
    validate(createDiscussionEntrySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);

      const actor = getActorInfo(req);
      const threadActor = await buildActor(req, companyId);
      try {
        // Idempotent retry: replay the original entry without re-posting or
        // re-firing mention summons. The DB partial-unique index is the backstop.
        const clientSubmissionId =
          typeof (req.body as { clientSubmissionId?: unknown }).clientSubmissionId === "string"
            ? (req.body as { clientSubmissionId: string }).clientSubmissionId
            : undefined;
        if (clientSubmissionId) {
          // P1 (PR #291 review): authorize the thread BEFORE returning a replay.
          // getEntryByClientSubmissionId scopes only by discussionId + key, so
          // without this a company member (or removed participant) who knows a
          // prior key could read an entry from a private thread, and another
          // company's discussionId would skip the company check. Run the SAME
          // authorization addEntry enforces so an unauthorized caller gets the
          // identical 404 they'd get posting, whether or not a replay exists.
          await assertCanPostToThread(db, companyId, discussionId, threadActor);
          const replay = await svc.getEntryByClientSubmissionId(discussionId, clientSubmissionId);
          if (replay) {
            res.status(200).json(replay);
            return;
          }
        }

        const entry = await svc.addEntry(
          companyId,
          discussionId,
          req.body,
          actor.actorId,
          threadActor,
        );

        // C4 (PR #291 review): a simultaneous same-key submission that lost the
        // insert race (or slipped past the pre-check) comes back flagged as a
        // replay. The winning request already fired the entry's side-effects, so
        // the loser must NOT re-run processMentions — otherwise the mentioned
        // crew is summoned twice (hop-counter bump / double participation).
        const { replayed, ...entryRow } =
          entry as typeof entry & { replayed?: boolean };
        if (replayed) {
          res.status(200).json(entryRow);
          return;
        }

        // @mention summons are now enqueued to discussion_mention_outbox INSIDE
        // addEntry's transaction and drained exactly-once by the mention-outbox
        // worker (PR #291 round-6 #3). The old route-level fire-and-forget
        // processMentions call was lost on failure and skipped by a same-key
        // replay — the durable outbox guarantees the summon survives both.
        res.status(201).json(entryRow);
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // 1.6 Reprocess entry — founder only
  router.post(
    "/companies/:companyId/discussions/:discussionId/entries/:entryId/reprocess",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      const entryId = req.params.entryId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder");

      try {
        const result = await svc.reprocessEntry(companyId, entryId);

        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "discussion.entry.reprocessed",
          entityType: "discussion_entry",
          entityId: entryId,
          details: { discussionId },
        });

        res.json(result);
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // 1.6b Reprocess all entries in a discussion — founder only
  router.post(
    "/companies/:companyId/discussions/:discussionId/reprocess",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder");

      try {
        const result = await svc.reprocessAllEntries(companyId, discussionId);

        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "discussion.reprocessed",
          entityType: "discussion",
          entityId: discussionId,
          details: result,
        });

        res.json(result);
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // 1.7 Update extracted item
  router.patch(
    "/companies/:companyId/discussions/:discussionId/entries/:entryId/items/:itemId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      const itemId = req.params.itemId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder", "team_lead");

      try {
        const updated = await svc.updateItem(companyId, itemId, req.body);

        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "discussion.item.updated",
          entityType: "discussion_extracted_item",
          entityId: itemId,
          details: { discussionId, fields: Object.keys(req.body) },
        });

        res.json(updated);
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // 1.8 Approve discussion items — founder only
  router.post(
    "/companies/:companyId/discussions/:discussionId/approve",
    validate(approveItemsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder");

      const actor = getActorInfo(req);

      type ItemAction = {
        itemId: string;
        action: string;
        edits?: Record<string, unknown>;
      };
      const items = req.body.items as ItemAction[];
      const dependencies = req.body.dependencies as
        | Array<{ dependentItemId: string; dependencyItemId: string }>
        | undefined;

      try {
        // Step 1: Apply edits to items with action="edited" before approval
        const editedItems = items.filter((i) => i.action === "edited" && i.edits);
        for (const item of editedItems) {
          await svc.updateItem(companyId, item.itemId, item.edits!);
        }

        // Step 2: Approve items (approved + edited both get approved)
        const approveIds = items
          .filter((i) => i.action === "approved" || i.action === "edited")
          .map((i) => i.itemId);

        const rejectIds = items
          .filter((i) => i.action === "rejected")
          .map((i) => i.itemId);

        let approveResult = {
          createdTaskIds: [] as string[],
          createdMemoryIds: [] as string[],
          approvedCount: 0,
        };
        let rejectResult = { rejectedCount: 0 };

        if (approveIds.length > 0) {
          approveResult = await svc.approveItems(
            companyId,
            discussionId,
            approveIds,
            actor.actorId,
          );
        }

        if (rejectIds.length > 0) {
          rejectResult = await svc.rejectItems(
            companyId,
            discussionId,
            rejectIds,
            actor.actorId,
          );
        }

        // Step 3: Create task dependencies if specified
        // Dependencies reference itemIds — we need to map them to the created taskIds.
        // The approveItems service returns createdTaskIds in order, but we need the
        // item→task mapping. For now, we look up the resultTaskId from the items.
        if (dependencies && dependencies.length > 0 && approveResult.createdTaskIds.length > 0) {
          const { dependencyService } = await import("../services/index.js");
          const depSvc = dependencyService(db);

          // Fetch the item→task mapping for all approved items
          const { eq, inArray } = await import("drizzle-orm");
          const { discussionExtractedItems } = await import("@armyofagents/db");

          const allItemIds = dependencies.flatMap((d) => [
            d.dependentItemId,
            d.dependencyItemId,
          ]);
          const uniqueItemIds = [...new Set(allItemIds)];

          const itemTaskMap = await db
            .select({
              id: discussionExtractedItems.id,
              resultTaskId: discussionExtractedItems.resultTaskId,
            })
            .from(discussionExtractedItems)
            .where(inArray(discussionExtractedItems.id, uniqueItemIds));

          const taskMap = new Map(
            itemTaskMap
              .filter((r) => r.resultTaskId != null)
              .map((r) => [r.id, r.resultTaskId!]),
          );

          for (const dep of dependencies) {
            const dependentTaskId = taskMap.get(dep.dependentItemId);
            const dependencyTaskId = taskMap.get(dep.dependencyItemId);
            if (dependentTaskId && dependencyTaskId) {
              await depSvc.addDependency(
                companyId,
                dependentTaskId,
                dependencyTaskId,
              );
            }
          }
        }

        res.json({
          approved: approveResult.approvedCount,
          rejected: rejectResult.rejectedCount,
          tasksCreated: approveResult.createdTaskIds,
          memoryItemsCreated: approveResult.createdMemoryIds,
        });
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // 1.9 Add annotation
  router.post(
    "/companies/:companyId/discussions/:discussionId/entries/:entryId/annotations",
    validate(createAnnotationSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const entryId = req.params.entryId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder", "team_lead");

      const actor = getActorInfo(req);
      try {
        const annotation = await svc.addAnnotation(
          companyId,
          entryId,
          req.body,
          actor.actorId,
        );
        res.status(201).json(annotation);
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // 1.10 Link entry to different discussion — founder only
  router.post(
    "/companies/:companyId/discussions/link",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder");

      const { entryId, targetDiscussionId } = req.body;
      if (!entryId || !targetDiscussionId) {
        res
          .status(400)
          .json({ error: "entryId and targetDiscussionId are required" });
        return;
      }

      try {
        const result = await svc.linkEntry(
          companyId,
          entryId,
          targetDiscussionId,
        );

        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "discussion.entry.linked",
          entityType: "discussion_entry",
          entityId: entryId,
          details: {
            sourceDiscussionId: result.sourceDiscussionId,
            targetDiscussionId: result.targetDiscussionId,
          },
        });

        res.json({
          entryId: result.entryId,
          previousDiscussionId: result.sourceDiscussionId,
          newDiscussionId: result.targetDiscussionId,
        });
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // ── Thread lifecycle routes (Threads v1 Plan 2) ───────────────────────────

  /**
   * Build an Actor from request context.
   * Role is resolved from permissionService for non-founders.
   * In local_trusted mode (source=local_implicit) or instance admins,
   * the effective role defaults to "founder".
   */
  async function buildActor(req: Parameters<typeof getActorInfo>[0], companyId: string): Promise<Actor> {
    const info = getActorInfo(req);
    const isHuman = req.actor.type === "board";

    // local_implicit or instance admin (board only) → treat as founder.
    // Defense-in-depth: the Actor type is flat (source/isInstanceAdmin exist on
    // all actor kinds), so gate on type:"board" rather than relying on the
    // runtime invariant that auth.ts only sets these on board actors (matches
    // the internal-agent.ts / cli-auth.ts idiom).
    if (
      req.actor.type === "board" &&
      (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)
    ) {
      return { userId: info.actorId, role: "founder", isHuman };
    }
    if (req.actor.type === "agent") {
      return {
        userId: info.actorId,
        role: "team_member",
        isHuman: false,
        principalType: "agent",
      };
    }

    // Non-board bearer tokens (mcp) are NEVER founder/team_lead for thread
    // access: a founder-created MCP key replays the founder's userId, which
    // would otherwise resolve to "founder" via getEffectiveRole and grant
    // read-anyone + privileged writes + agent dispatch on the threads surface.
    // Confine them to team_member (participant/owner-scoped). Interactive
    // founder access is via board sessions only. (Mirrors conversation-authz.ts.)
    if (req.actor.type !== "board") {
      return {
        userId: info.actorId,
        role: "team_member",
        isHuman: false,
        principalType: "user",
      };
    }

    const perms = permissionService(db);
    const role = await perms.getEffectiveRole(companyId, info.actorId);
    return { userId: info.actorId, role, isHuman };
  }

  const tSvc = threadService(db);

  // T.1 Advance thread phase
  router.patch(
    "/companies/:companyId/discussions/:discussionId/phase",
    validate(phaseSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);

      // D16 authz gate: advancing to "assign" at L2 triggers auto-approve + task
      // creation + dispatch, which spends budget. The Approve button requires
      // founder/team_lead (see assertRole call below at ~line 1257). This gate
      // makes the two spend-doors require the same role.
      //
      // We resolve effective autonomy here (thread.autonomyLevel ?? company
      // autonomyLevel) the same way advancePhase does, so the authz decision
      // is consistent. A 404 on the thread fetch is allowed to fall through —
      // advancePhase will throw its own notFound which is caught below.
      const targetPhase = req.body.phase as string;
      if (targetPhase === "assign") {
        const [threadRow] = await db
          .select({ autonomyLevel: discussions.autonomyLevel })
          .from(discussions)
          .where(and(eq(discussions.id, discussionId), eq(discussions.companyId, companyId)));

        if (threadRow !== undefined) {
          const [companyCfg] = await db
            // D18: mirror advancePhase — the agent-work dial, not Commander's.
            .select({ autonomyLevel: internalAgentConfig.crewAutonomyLevel })
            .from(internalAgentConfig)
            .where(eq(internalAgentConfig.companyId, companyId))
            .limit(1);
          const companyAutonomyLevel = companyCfg?.autonomyLevel ?? 0;
          const effectiveAutonomy =
            threadRow.autonomyLevel != null ? threadRow.autonomyLevel : companyAutonomyLevel;

          // At L2, this advance WOULD auto-approve and spend — require the same
          // role as the Approve route (founder or team_lead).
          if (effectiveAutonomy >= 2) {
            await assertHumanRole(db, req, companyId, "founder", "team_lead");
          }
        }
      }

      const actor = await buildActor(req, companyId);
      try {
        const result = await tSvc.advancePhase(companyId, discussionId, req.body.phase, actor);
        res.json(result);
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  // T.2 Claim a thread
  router.post(
    "/companies/:companyId/discussions/:discussionId/claim",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = await buildActor(req, companyId);
      try {
        const result = await tSvc.claim(companyId, discussionId, actor);
        res.json(result);
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  // T.3 Transfer thread ownership
  router.post(
    "/companies/:companyId/discussions/:discussionId/transfer",
    validate(transferSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = await buildActor(req, companyId);
      try {
        const result = await tSvc.transferOwnership(companyId, discussionId, req.body.toUserId, actor);
        res.json(result);
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  // Phase 1 Phase E batch 2 (T22): Share-link generation + revocation.
  // Founder-only. Tokens are opaque 32-byte url-safe random strings; uniqueness
  // is enforced by the column-level UNIQUE constraint on discussions.share_token.
  router.post(
    "/companies/:companyId/discussions/:discussionId/share-token",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder");
      try {
        // Use Web Crypto for a URL-safe random token. Node 19+/browsers expose
        // `crypto.randomUUID()`; we want a longer 32-byte token so use
        // `randomBytes` via node:crypto. (Phase E batch 3 bumped from 24 → 32
        // bytes for additional entropy; share tokens are still base64url and
        // backward-compatible because the schema column has no length cap.)
        const { randomBytes } = await import("node:crypto");
        const token = randomBytes(32).toString("base64url");
        const [updated] = await db
          .update(discussions)
          .set({ shareToken: token, updatedAt: new Date() })
          .where(and(eq(discussions.id, discussionId), eq(discussions.companyId, companyId)))
          .returning({ id: discussions.id, shareToken: discussions.shareToken });
        if (!updated) {
          res.status(404).json({ error: "Discussion not found" });
          return;
        }
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "thread.share_token_generated",
          entityType: "discussion",
          entityId: discussionId,
          details: {},
        });
        res.status(201).json({ token: updated.shareToken });
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  router.delete(
    "/companies/:companyId/discussions/:discussionId/share-token",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder");
      try {
        const [updated] = await db
          .update(discussions)
          .set({ shareToken: null, updatedAt: new Date() })
          .where(and(eq(discussions.id, discussionId), eq(discussions.companyId, companyId)))
          .returning({ id: discussions.id });
        if (!updated) {
          res.status(404).json({ error: "Discussion not found" });
          return;
        }
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "thread.share_token_revoked",
          entityType: "discussion",
          entityId: discussionId,
          details: {},
        });
        res.json({ ok: true });
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // T.4 Add participant to thread
  router.post(
    "/companies/:companyId/discussions/:discussionId/participants",
    validate(addParticipantSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = await buildActor(req, companyId);
      try {
        const result = await tSvc.addParticipant(companyId, discussionId, req.body, actor);
        res.status(201).json(result);
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  // T.5 Promote thread to goal
  router.post(
    "/companies/:companyId/discussions/:discussionId/promote-to-goal",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder");
      const actor = await buildActor(req, companyId);
      try {
        const result = await tSvc.promoteToGoal(companyId, discussionId, req.body, actor);
        res.json(result);
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  // T.6 Assign scope items to tasks
  router.post(
    "/companies/:companyId/discussions/:discussionId/assign",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder");
      const actor = await buildActor(req, companyId);
      try {
        const result = await tSvc.assignScopeItems(companyId, discussionId, actor);
        res.json(result);
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  // T.7 Scope tab read model: summary + plan + grouped items + router recommendation.
  router.get(
    "/companies/:companyId/discussions/:discussionId/scope",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = await buildActor(req, companyId);
      try {
        const detail = await svc.getById(companyId, discussionId);
        if (!detail) { res.status(404).json({ error: "Discussion not found" }); return; }
        const planSteps = await tSvc.getPlanSteps(companyId, discussionId, actor);
        const items = (detail.entries ?? []).flatMap(
          (e: { extractedItems?: unknown[] }) => e.extractedItems ?? [],
        );
        const { recommendDepartment } = await import(
          "../services/internal-agent/aoa-agents/router-recommendation.js"
        );
        const { projects } = await import("@armyofagents/db");
        const { eq: dEq, and: dAnd } = await import("drizzle-orm");
        let departments: Array<{ id: string; name: string }> = [];
        try {
          departments = await db
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(dAnd(dEq(projects.companyId, companyId), dEq(projects.type, "department")));
        } catch {
          // fallback: recommendation runs with empty department list
        }
        const recommendation = recommendDepartment(items as never[], departments);
        res.json({
          summaryText: (detail as any).summaryText ?? null,
          summaryNext: (detail as any).summaryNext ?? null,
          planSteps,
          items,
          recommendation,
        });
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  // T.8 Edit the living Plan (owner | co_owner | founder — service-gated).
  const planBodySchema = z.object({
    steps: z.array(z.object({
      title: z.string().min(1),
      linkedItemId: z.string().uuid().nullable().optional(),
      collapsed: z.boolean().optional(),
    })),
  });

  router.put(
    "/companies/:companyId/discussions/:discussionId/scope/plan",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      assertBoard(req);
      await assertCompanyAccess(db, req, companyId);
      const actor = await buildActor(req, companyId);
      const parsed = planBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
        return;
      }
      try {
        const result = await tSvc.updatePlanSteps(companyId, discussionId, parsed.data.steps, actor);
        res.json(result);
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  // Plan 3 Task 8: thread-level crew kill-switch.
  // POST /companies/:companyId/discussions/:discussionId/crew/pause
  // POST /companies/:companyId/discussions/:discussionId/crew/resume
  // Role: founder (only founder can halt crew for a thread).
  router.post(
    "/companies/:companyId/discussions/:discussionId/crew/pause",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder");
      await db.update(discussions).set({ crewPaused: true, updatedAt: new Date() }).where(and(eq(discussions.id, discussionId), eq(discussions.companyId, companyId)));
      res.json({ crewPaused: true });
    },
  );

  router.post(
    "/companies/:companyId/discussions/:discussionId/crew/resume",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder");
      await db.update(discussions).set({ crewPaused: false, updatedAt: new Date() }).where(and(eq(discussions.id, discussionId), eq(discussions.companyId, companyId)));
      res.json({ crewPaused: false });
    },
  );

  // ── Plan 5: Inbox/Unlisted lane endpoints ─────────────────────────────────

  // T.I2 Triage an inbox item — attach, dismiss, or promote to thread
  const triageBodySchema = z.object({
    action: z.enum(["attach", "dismiss", "make_thread"]),
    threadId: z.string().uuid().optional(),
  }).refine(
    (data) => data.action !== "attach" || !!data.threadId,
    { message: "threadId is required when action is attach", path: ["threadId"] },
  );

  router.post(
    "/companies/:companyId/discussions/inbox/:itemId/triage",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const itemId = req.params.itemId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder", "team_lead");

      const parsed = triageBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
        return;
      }

      const { action, threadId } = parsed.data;

      // Fetch the item to validate it belongs to this company
      const [item] = await db
        .select()
        .from(threadInboxItems)
        .where(
          and(
            eq(threadInboxItems.id, itemId),
            eq(threadInboxItems.companyId, companyId),
          ),
        );

      if (!item) {
        res.status(404).json({ error: "Inbox item not found" });
        return;
      }

      // Fix C3: Prevent re-triaging already-processed items
      if (item.status !== "pending") {
        res.status(409).json({ error: "Inbox item has already been triaged" });
        return;
      }

      const actor = getActorInfo(req);

      if (action === "dismiss") {
        await db
          .update(threadInboxItems)
          .set({ status: "dismissed" })
          .where(
            and(
              eq(threadInboxItems.id, itemId),
              eq(threadInboxItems.companyId, companyId),
            ),
          );

        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "thread.inbox_item.dismissed",
          entityType: "thread_inbox_item",
          entityId: itemId,
          details: {},
        });

        res.json({ itemId, status: "dismissed" });
        return;
      }

      if (action === "attach") {
        // Fix C2: Validate target thread belongs to same company (pre-flight;
        // attachInboxItemToThread also validates — keeping this for a fast 404
        // before entering any transaction).
        const [targetThread] = await db
          .select({ id: discussions.id })
          .from(discussions)
          .where(and(eq(discussions.id, threadId!), eq(discussions.companyId, companyId)));
        if (!targetThread) {
          res.status(404).json({ error: "Thread not found" });
          return;
        }

        // Delegate to the 0.3 write-path — posts rawContent as a discussion_entries
        // row AND atomically claims the inbox row (Codex #6 fix).
        const attachResult = await attachInboxItemToThread(db, {
          companyId,
          inboxItemId: itemId,
          threadId: threadId!,
          actor,
        });

        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "thread.inbox_item.attached",
          entityType: "thread_inbox_item",
          entityId: itemId,
          details: { threadId, entryId: attachResult.entryId },
        });

        // Idempotent: alreadyHandled means the item was previously claimed in the
        // same transaction — still 200, no duplicate entry inserted.
        res.json({
          itemId,
          status: "attached",
          threadId,
          entryId: attachResult.entryId,
          alreadyHandled: attachResult.alreadyHandled,
        });
        return;
      }

      if (action === "make_thread") {
        // Delegate to the 0.3 write-path — creates the thread, posts rawContent as
        // the first discussion_entries row, and claims the inbox row atomically
        // (Codex #6 fix). The 0.3 service handles the C1 transaction safety that
        // the previous code implemented manually.
        //
        // PromoteResult.alreadyHandled: a concurrent promote (rare — the router's
        // atomic claim in routeInboxItem guards most concurrent paths) already
        // claimed+created this item. Return 200 with the current item state so
        // the caller can discover the existing thread via the inbox item.
        const promoteResult = await promoteInboxItemToNewThread(db, {
          companyId,
          inboxItemId: itemId,
          actor,
        });

        if (promoteResult.alreadyHandled) {
          res.status(200).json({
            itemId,
            status: "attached",
            threadId: null,
            entryId: null,
            alreadyHandled: true,
          });
          return;
        }

        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "thread.inbox_item.promoted",
          entityType: "thread_inbox_item",
          entityId: itemId,
          details: { newDiscussionId: promoteResult.threadId },
        });

        res.status(201).json({
          itemId,
          status: "attached",
          threadId: promoteResult.threadId,
          entryId: promoteResult.entryId,
        });
        return;
      }

      // Should never reach here — zod enum guards all actions
      res.status(400).json({ error: "Unknown triage action" });
    },
  );

  // ── Plan 6: Spin-off thread ───────────────────────────────────────────────

  const spinOffBodySchema = z.object({
    scopeItemId: z.string().uuid(),
    title: z.string().optional(),
  });

  // T.SO1 Spin off a child thread from a scope item
  router.post(
    "/companies/:companyId/discussions/:discussionId/spin-off",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = await buildActor(req, companyId);

      const parsed = spinOffBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
        return;
      }

      try {
        const result = await tSvc.spinOff(companyId, discussionId, parsed.data, actor);
        res.status(201).json(result);
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  // ── Plan 6: Scope-item dependencies ──────────────────────────────────────

  const scopeDepBodySchema = z.object({
    blockerItemId: z.string().uuid(),
    blockedItemId: z.string().uuid(),
  });

  // T.SD1 Add a scope-item dependency
  router.post(
    "/companies/:companyId/discussions/:discussionId/scope-deps",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);
      assertBoard(req);
      await assertRole(db, req, companyId, "founder");
      const actor = await buildActor(req, companyId);

      const parsed = scopeDepBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
        return;
      }

      try {
        const result = await tSvc.addScopeItemDependency(companyId, discussionId, parsed.data, actor);
        res.status(201).json(result);
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  // T.SD2 Graduate scope-item deps → task_dependencies
  router.post(
    "/companies/:companyId/discussions/:discussionId/scope-deps/graduate",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);
      assertBoard(req);
      await assertRole(db, req, companyId, "founder");
      const actor = await buildActor(req, companyId);

      try {
        // Route handler performs the two-step lookup and passes pre-computed rows
        // to the service (avoids complex aliased joins in the service layer).
        const { eq: drizzleEq, inArray: drizzleInArray } = await import("drizzle-orm");
        const { scopeItemDependencies, discussionExtractedItems, discussionEntries } =
          await import("@armyofagents/db");

        // Step 1: get all entry IDs for this discussion
        const entryIds = await db
          .select({ id: discussionEntries.id })
          .from(discussionEntries)
          .where(drizzleEq(discussionEntries.discussionId, discussionId))
          .then((rows) => rows.map((r) => r.id));

        if (entryIds.length === 0) {
          res.json({ graduated: 0 });
          return;
        }

        // Step 2: get all scope deps for items in this discussion
        const allItemIds = await db
          .select({ id: discussionExtractedItems.id, resultTaskId: discussionExtractedItems.resultTaskId })
          .from(discussionExtractedItems)
          .where(drizzleInArray(discussionExtractedItems.discussionEntryId, entryIds))
          .then((rows) => rows);

        const itemTaskMap = new Map(allItemIds.map((r) => [r.id, r.resultTaskId]));
        const itemIdList = allItemIds.map((r) => r.id);

        if (itemIdList.length === 0) {
          res.json({ graduated: 0 });
          return;
        }

        const sidRows = await db
          .select({ id: scopeItemDependencies.id, blockerItemId: scopeItemDependencies.blockerItemId, blockedItemId: scopeItemDependencies.blockedItemId })
          .from(scopeItemDependencies)
          .where(drizzleInArray(scopeItemDependencies.blockerItemId, itemIdList))
          .then((rows) => rows);

        // Build pre-computed rows with both sides' resultTaskIds
        const precomputed = sidRows.map((row) => ({
          id: row.id,
          blockerItemId: row.blockerItemId,
          blockedItemId: row.blockedItemId,
          blockerResultTaskId: itemTaskMap.get(row.blockerItemId) ?? null,
          blockedResultTaskId: itemTaskMap.get(row.blockedItemId) ?? null,
        }));

        const result = await tSvc.graduateScopeItemDependencies(
          companyId, discussionId, actor, precomputed,
        );
        res.json(result);
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  // ── Plan 6: Per-item routing ───────────────────────────────────────────────

  const routingBodySchema = z.object({
    departmentId: z.string().uuid().optional(),
    assigneeAgentId: z.string().uuid().optional(),
    assigneeUserId: z.string().optional(),
  });

  // T.R1 PATCH per-item routing (service-level guard; hide-don't-403)
  router.patch(
    "/companies/:companyId/discussions/:discussionId/items/:itemId/routing",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const itemId = req.params.itemId as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = await buildActor(req, companyId);

      const parsed = routingBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
        return;
      }

      try {
        const result = await tSvc.routeItem(companyId, itemId, parsed.data, actor);
        res.json(result);
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  // ── Plan 6: Cross-thread links ────────────────────────────────────────────

  const createLinkSchema = z.object({
    toThreadId: z.string().uuid(),
    kind: z.enum(THREAD_LINK_KINDS),
  });

  // T.L1 Create a cross-thread link
  router.post(
    "/companies/:companyId/discussions/:fromId/links",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const fromId = req.params.fromId as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = await buildActor(req, companyId);

      const parsed = createLinkSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
        return;
      }

      try {
        const link = await tSvc.createLink(companyId, fromId, parsed.data.toThreadId, parsed.data.kind, actor);
        res.status(201).json(link);
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  // T.L2 List cross-thread links for a thread (bidirectional)
  router.get(
    "/companies/:companyId/discussions/:id/links",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = await buildActor(req, companyId);

      try {
        const links = await tSvc.listLinks(companyId, id, actor);
        res.json({ links, total: links.length });
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  // ── P1-T7: Secure scope-proposal Approve handler ─────────────────────────
  //
  // POST /companies/:companyId/discussions/:discussionId/proposals/:proposalEntryId/approve
  //
  // Authorization model (MUST NOT trust the click):
  //   1. `assertCompanyAccess` — ensures the request principal can access this company.
  //   2. `assertRole(db, req, companyId, "founder", "team_lead")` — only founder or
  //      team_lead roles may create tasks (matches the existing write-route pattern).
  //   3. The service additionally verifies the proposal belongs to this thread+company
  //      (defense-in-depth: prevents cross-tenant abuse even if auth somehow passes).
  //
  // Business rules enforced by threadDeliverablesService.approveProposal:
  //   - Already approved → 200 idempotent (no duplicate tasks).
  //   - Rejected → 409.
  //   - Stale (thread has newer entries than the proposal's cursor stamp) → 409.
  //   - Not found / wrong thread → 404.
  //
  // On success: tasks are created (and auto-dispatched via heartbeat if assigned),
  // the entry is marked approved, and an activity-log entry is written.

  router.post(
    "/companies/:companyId/discussions/:discussionId/proposals/:proposalEntryId/approve",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      const proposalEntryId = req.params.proposalEntryId as string;

      // ── Auth: 1. Company access ────────────────────────────────────────────
      await assertCompanyAccess(db, req, companyId);

      // ── Auth: 2. Role check — founder or team_lead can create tasks ────────
      // This is the primary authorization gate. It rejects with 403 for
      // team_member, unauthenticated, and agent actors (agents have separate paths).
      await assertHumanRole(db, req, companyId, "founder", "team_lead");

      // ── Auth: 3. Resolve approver identity ────────────────────────────────
      const actor = getActorInfo(req);
      const approver = { userId: actor.actorId };

      // ── Invoke service (handles validate + stale + create + mark approved) ──
      const { threadDeliverablesService: getDeliverablesService } = await import(
        "../services/thread-deliverables.js"
      );
      const delSvc = getDeliverablesService(db);

      try {
        const result = await delSvc.approveProposal({
          threadId: discussionId,
          companyId,
          proposalEntryId,
          approver,
        });

        if (!result.ok) {
          // Business-rule failures: map to appropriate HTTP status codes.
          const statusMap: Record<string, number> = {
            not_found: 404,
            wrong_thread: 404,
            rejected: 409,
            stale: 409,
          };
          const status = statusMap[result.reason] ?? 400;
          res.status(status).json({ error: result.message, reason: result.reason });
          return;
        }

        if (result.alreadyApproved) {
          // Idempotent no-op — 200 with a clear signal.
          res.json({ alreadyApproved: true, tasksCreated: [] });
          return;
        }

        // ── Audit log ──────────────────────────────────────────────────────
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "thread.scope_proposal.approved",
          entityType: "discussion_entry",
          entityId: proposalEntryId,
          details: {
            threadId: discussionId,
            taskIds: result.taskIds,
            taskCount: result.taskIds.length,
          },
        });

        // Dispatch each task that has an agent assignee through the kind-aware
        // chokepoint (crew → AoA dispatcher, org → heartbeat).
        // Mirrors the assignment-wakeup pattern in routes/issues.ts POST /issues.
        for (const task of result.createdTasks) {
          if (task.assigneeAgentId && shouldDispatchIssueWakeup({ workMode: task.workMode })) {
            void enqueueIssueAssigneeWakeup(db, {
              companyId,
              agentId: task.assigneeAgentId,
              issueId: task.id,
              source: "assignment",
              reason: "deliverable_created",
              mutation: "create",
            }).catch((err) =>
              logger.warn({ err, issueId: task.id }, "failed to wake deliverable assignee on approve"),
            );
          }
        }

        res.status(201).json({
          alreadyApproved: false,
          tasksCreated: result.taskIds,
        });
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // Plan 7 catch-up: GET …/discussions/:discussionId/entries?sinceSeq=N
  // Returns entries with seq > N ordered by seq, for reconnect-refetch.
  // RBAC enforced inside threadService.entriesSince (hide-don't-403).
  router.get(
    "/companies/:companyId/discussions/:discussionId/entries",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const discussionId = req.params.discussionId as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = await buildActor(req, companyId);

      const rawSince = Array.isArray(req.query.sinceSeq)
        ? req.query.sinceSeq[0]
        : req.query.sinceSeq;
      // Absent → default to 0 (full catch-up). Present → must be a non-negative
      // integer; reject floats/garbage with 400 instead of silently truncating.
      let sinceSeq = 0;
      if (rawSince !== undefined && rawSince !== "") {
        const seq = Number(rawSince);
        if (!Number.isInteger(seq) || seq < 0) {
          res.status(400).json({ error: "sinceSeq must be a non-negative integer" });
          return;
        }
        sinceSeq = seq;
      }

      try {
        const entries = await tSvc.entriesSince(companyId, discussionId, sinceSeq, actor);
        res.json({ entries, total: entries.length, sinceSeq });
      } catch (err) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        throw err;
      }
    },
  );

  return router;
}
