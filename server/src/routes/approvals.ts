import { Router } from "express";
import type { Db } from "@armyofagents/db";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  approvalService,
  heartbeatService,
  issueApprovalService,
  logActivity,
  notifyHireApproved,
  secretService,
  trustScoreService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { assertRole } from "../middleware/rbac.js";
import { redactEventPayload } from "../redaction.js";
import { buildApprovalHubEmit, emitHubItem } from "../services/hub-source-producers.js";
import { hubItemsService } from "../services/hub-items.js";

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

/**
 * FU-17 — the ROLE gate on the connector governance approval.
 *
 * Every connector mutation in `routes/mcp-connectors.ts` (create, PATCH, delete,
 * credentials, agent-assignment, catalog install) is
 * `assertRole(db, req, companyId, "founder")`. And amendment C2 blocks even the
 * FOUNDER from PATCH→active in `authenticated` mode, deliberately, so that
 * activation flows through the `install_mcp_connector` approval instead. That
 * makes this approval the connector governance gate — yet the resolve routes
 * carried only `assertBoard` + `assertCompanyAccess`, so the gate was strictly
 * WEAKER than the CRUD it protects: any board member, including a plain
 * `team_member`, could activate (or veto) an external MCP server.
 *
 * Founder decision (2026-07-24): `founder` and `team_lead` may resolve an
 * `install_mcp_connector` approval; `team_member` may not.
 *
 * SCOPED TO THE TYPE ON PURPOSE. `hire_agent` and the other board decisions are
 * genuinely board-resolvable and MUST stay that way — founder-gating every
 * approval would be a different, much larger governance change. That is why this
 * runs after `svc.getById`, on the type of the row actually being decided,
 * rather than as blanket route middleware.
 *
 * `request-revision` is included alongside approve/reject. The founder's decision
 * named approve/reject, but for THIS type request-revision is strictly worse than
 * a reject: `install_mcp_connector` is on `SYSTEM_INTERNAL_APPROVAL_TYPES`, so a
 * revision_requested connector approval can never be resubmitted (422) — parking
 * it there permanently bricks the install with no route back except recreating
 * the connector. A member who cannot approve but can irreversibly park still
 * controls the outcome, which is the same reasoning that put reject in scope.
 *
 * ON `assertRole`'s AGENT EARLY-RETURN: `assertRole` returns immediately for
 * `req.actor.type === "agent"`, which would be a hole here — except that every
 * call site below runs `assertBoard(req)` FIRST, and that 403s any non-board
 * actor (agent and mcp alike). The early-return is therefore unreachable on
 * these routes. Do not reorder these two calls.
 *
 * ON DEPARTMENT SCOPE: `assertRole` takes no department and asks only
 * `getEffectiveRole(companyId, userId)`, so ANY team lead of the company passes —
 * it is a company-wide role check, not a department-scoped one. That is the
 * correct semantics here because a connector is itself a company-wide object:
 * `company_mcp_connectors` has no `departmentId`, and per-agent scoping is a
 * separate founder-only assignment step. There is no department to scope the
 * decision to, so `assertDepartmentAccess` is not applicable. The founder's
 * decision — "team leads may approve" — is therefore implemented as written, and
 * the residual is understood: a lead of any one department can approve a
 * connector that all departments may then be granted.
 */
async function assertMayResolveApproval(
  db: Db,
  req: Parameters<typeof assertRole>[1],
  approval: { type: string; companyId: string },
): Promise<void> {
  if (approval.type !== "install_mcp_connector") return;
  // `assertRole` passes `founder` unconditionally, so listing `team_lead` yields
  // exactly "founder or team_lead".
  await assertRole(db, req, approval.companyId, "team_lead");
}

export function approvalRoutes(db: Db) {
  const router = Router();
  const svc = approvalService(db);
  const heartbeat = heartbeatService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const secretsSvc = secretService(db);
  const trustScoreSvc = trustScoreService(db);
  const strictSecretsMode = process.env.AOA_SECRETS_STRICT_MODE === "true";

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const status = req.query.status as string | undefined;
    const result = await svc.list(companyId, status);
    res.json(result.map((approval) => redactApprovalPayload(approval)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    await assertCompanyAccess(db, req, approval.companyId);
    res.json(redactApprovalPayload(approval));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const { issueIds: _issueIds, ...approvalInput } = req.body;
    const normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;

    const actor = getActorInfo(req);
    const approval = await db.transaction(async (tx) => {
      const txApprovalSvc = approvalService(tx as unknown as Db);
      const txIssueApprovalsSvc = issueApprovalService(tx as unknown as Db);
      const created = await txApprovalSvc.create(companyId, {
        ...approvalInput,
        payload: normalizedPayload,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        requestedByAgentId:
          approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null),
        status: "pending",
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });

      if (uniqueIssueIds.length > 0) {
        await txIssueApprovalsSvc.linkManyForApproval(created.id, uniqueIssueIds, {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        });
      }

      await logActivity(tx as unknown as Db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "approval.created",
        entityType: "approval",
        entityId: created.id,
        details: { type: created.type, issueIds: uniqueIssueIds },
      });
      await emitHubItem(tx as unknown as Db, buildApprovalHubEmit(created));
      return created;
    });

    res.status(201).json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    await assertCompanyAccess(db, req, approval.companyId);
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    // FU-17 — connector installs are founder/team_lead only. Type-scoped.
    await assertMayResolveApproval(db, req, existing);

    const decidedBy = req.actor.userId ?? "local-board";
    const approvalResult = await db.transaction(async (tx) => {
      const txApprovalSvc = approvalService(tx as unknown as Db);
      const txIssueApprovalsSvc = issueApprovalService(tx as unknown as Db);
      const approval = await txApprovalSvc.approve(id, existing.companyId, decidedBy, req.body.decisionNote);
      if (!approval) {
        return { approval: null, linkedIssueIds: [] as string[] };
      }
      const linkedIssues = await txIssueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      await logActivity(tx as unknown as Db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
        },
      });
      await hubItemsService(tx as unknown as Db).reconcile(approval.companyId, { sourceType: "approval", sourceId: approval.id });
      return { approval, linkedIssueIds };
    });
    const { approval, linkedIssueIds } = approvalResult;
    if (!approval) {
      // Service returned null — companyId WHERE didn't match (TOCTOU or
      // upstream guard bypass). Surface as 404 rather than crashing on
      // downstream property access.
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const primaryIssueId = linkedIssueIds[0] ?? null;
    const approvedHireAgentId = (approval as typeof approval & { __approvedHireAgentId?: string }).__approvedHireAgentId ?? null;

    // Update trust score when task-related approval is approved (agent work accepted without changes)
    if (approval.requestedByAgentId && linkedIssueIds.length > 0) {
      void trustScoreSvc.updateOnReview(approval.requestedByAgentId, true).catch((err) => {
        logger.warn({ err, agentId: approval.requestedByAgentId }, "failed to update trust score on approve");
      });
    }

    if (approval.requestedByAgentId) {
      try {
        const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "approval_approved",
          payload: {
            approvalId: approval.id,
            approvalStatus: approval.status,
            issueId: primaryIssueId,
            issueIds: linkedIssueIds,
          },
          requestedByActorType: "user",
          requestedByActorId: req.actor.userId ?? "board",
          contextSnapshot: {
            source: "approval.approved",
            approvalId: approval.id,
            approvalStatus: approval.status,
            issueId: primaryIssueId,
            issueIds: linkedIssueIds,
            taskId: primaryIssueId,
            wakeReason: "approval_approved",
          },
        });

        await logActivity(db, {
          companyId: approval.companyId,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          action: "approval.requester_wakeup_queued",
          entityType: "approval",
          entityId: approval.id,
          details: {
            requesterAgentId: approval.requestedByAgentId,
            wakeRunId: wakeRun?.id ?? null,
            linkedIssueIds,
          },
        });
      } catch (err) {
        logger.warn(
          {
            err,
            approvalId: approval.id,
            requestedByAgentId: approval.requestedByAgentId,
          },
          "failed to queue requester wakeup after approval",
        );
        await logActivity(db, {
          companyId: approval.companyId,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          action: "approval.requester_wakeup_failed",
          entityType: "approval",
          entityId: approval.id,
          details: {
            requesterAgentId: approval.requestedByAgentId,
            linkedIssueIds,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
    if (approvedHireAgentId) {
      void notifyHireApproved(db, {
        companyId: approval.companyId,
        agentId: approvedHireAgentId,
        source: "approval",
        sourceId: approval.id,
        approvedAt: approval.decidedAt ?? new Date(),
      }).catch(() => {});
    }
    res.json(redactApprovalPayload(approval));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    // FU-17 — a member who cannot approve but CAN reject still controls the
    // outcome, so the same gate applies here.
    await assertMayResolveApproval(db, req, existing);

    const decidedBy = req.actor.userId ?? "local-board";
    const approval = await db.transaction(async (tx) => {
      const txApprovalSvc = approvalService(tx as unknown as Db);
      const rejected = await txApprovalSvc.reject(id, existing.companyId, decidedBy, req.body.decisionNote);
      if (!rejected) return null;
      await logActivity(tx as unknown as Db, {
        companyId: rejected.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.rejected",
        entityType: "approval",
        entityId: rejected.id,
        details: { type: rejected.type },
      });
      await hubItemsService(tx as unknown as Db).reconcile(rejected.companyId, { sourceType: "approval", sourceId: rejected.id });
      return rejected;
    });
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }

    // Update trust score when task-related approval is rejected (agent work not accepted)
    if (approval.requestedByAgentId) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      if (linkedIssues.length > 0) {
        void trustScoreSvc.updateOnReview(approval.requestedByAgentId, false).catch((err) => {
          logger.warn({ err, agentId: approval.requestedByAgentId }, "failed to update trust score on reject");
        });
      }
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }
      await assertCompanyAccess(db, req, existing.companyId);
      // FU-17 — for install_mcp_connector this is IRREVERSIBLE (the type is on
      // SYSTEM_INTERNAL_APPROVAL_TYPES, so it can never be resubmitted), which
      // makes it a stronger veto than reject. Same gate.
      await assertMayResolveApproval(db, req, existing);

      const decidedBy = req.actor.userId ?? "local-board";
      const approval = await db.transaction(async (tx) => {
        const txApprovalSvc = approvalService(tx as unknown as Db);
        const revised = await txApprovalSvc.requestRevision(
          id,
          existing.companyId,
          decidedBy,
          req.body.decisionNote,
        );
        if (!revised) return null;
        await logActivity(tx as unknown as Db, {
          companyId: revised.companyId,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          action: "approval.revision_requested",
          entityType: "approval",
          entityId: revised.id,
          details: { type: revised.type },
        });
        await emitHubItem(tx as unknown as Db, buildApprovalHubEmit(revised));
        return revised;
      });
      if (!approval) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }

      // Update trust score when revision requested (agent work not accepted as-is)
      if (approval.requestedByAgentId) {
        const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
        if (linkedIssues.length > 0) {
          void trustScoreSvc.updateOnReview(approval.requestedByAgentId, false).catch((err) => {
            logger.warn({ err, agentId: approval.requestedByAgentId }, "failed to update trust score on revision request");
          });
        }
      }

      res.json(redactApprovalPayload(approval));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);

    // FU-18 — resubmit must be gated to "board OR the requesting agent".
    // `assertCompanyAccess` above only rejects `none` (401) and cross-company
    // agent/mcp keys; a same-company `mcp` API-key actor — not a board user at
    // all — otherwise reaches the handler and can rewrite `payload` wholesale
    // (the schema is `z.record(z.unknown())`). The sibling approve/reject/
    // request-revision routes run `assertBoard`, but a blanket `assertBoard`
    // here would 403 the agent-resubmits-its-own-approval path this route
    // deliberately supports. So allow a board member OR the agent that
    // originally requested the approval; refuse every other principal (mcp key,
    // foreign agent).
    const isBoard = req.actor.type === "board";
    const isRequestingAgent =
      req.actor.type === "agent" && req.actor.agentId === existing.requestedByAgentId;
    if (!isBoard && !isRequestingAgent) {
      res.status(403).json({ error: "Only the board or requesting agent can resubmit this approval" });
      return;
    }

    const normalizedPayload = req.body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.companyId,
            req.body.payload,
            { strictMode: strictSecretsMode },
          )
        : req.body.payload
      : undefined;
    const actor = getActorInfo(req);
    const approval = await db.transaction(async (tx) => {
      const txApprovalSvc = approvalService(tx as unknown as Db);
      const resubmitted = await txApprovalSvc.resubmit(id, existing.companyId, normalizedPayload);
      if (!resubmitted) return null;
      await logActivity(tx as unknown as Db, {
        companyId: resubmitted.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "approval.resubmitted",
        entityType: "approval",
        entityId: resubmitted.id,
        details: { type: resubmitted.type },
      });
      await emitHubItem(tx as unknown as Db, buildApprovalHubEmit(resubmitted));
      return resubmitted;
    });
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    res.json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    await assertCompanyAccess(db, req, approval.companyId);
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    await assertCompanyAccess(db, req, approval.companyId);
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  return router;
}
