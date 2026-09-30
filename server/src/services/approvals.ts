import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { approvalComments, approvals, issues } from "@armyofagents/db";
import { notFound, unprocessable } from "../errors.js";
import { loadConfig } from "../config.js";
import { agentService } from "./agents.js";
import { preflightCrewDispatch } from "./crew-budget.js";
import { dispatchCreatedCrewTasks } from "./crew-task-service.js";
import { logActivity } from "./activity-log.js";
import { mcpConnectorService } from "./mcp-connectors-crud.js";
import { resolveConnectorStatus } from "./mcp-connector-status.js";

/**
 * Approval types NO CLIENT MAY EVER SUPPLY A PAYLOAD FOR.
 *
 * Membership rule: the type is minted only by server-internal code and its
 * payload names the object a decision acts on. Neither is in
 * `CREATABLE_APPROVAL_TYPES`, so creation is already blocked — but `resubmit`
 * REWRITES `payload` wholesale (`z.record(z.unknown())`), which would re-open
 * the same vector one hop later. Exported so the guard's membership is testable
 * without reaching into the service closure.
 *
 * If you add a system-internal approval type, add it here in the same commit.
 */
export const SYSTEM_INTERNAL_APPROVAL_TYPES: ReadonlySet<string> = new Set([
  "crew_dispatch",
  "install_mcp_connector",
]);

/**
 * The slice of `mcpConnectorService` the two helpers below need. Structural, so
 * the truth table can be unit-tested with plain object stubs and no DB.
 */
export type ConnectorApprovalTarget = {
  getById: (id: string) => Promise<
    | {
      companyId: string;
      status: string;
      requiresSecret?: boolean | null;
      secretRef?: string | null;
    }
    | null
  >;
  update: (id: string, patch: { status: string }) => Promise<unknown>;
  updateIfStatus: (
    id: string,
    expectedStatus: string,
    patch: { status: string },
  ) => Promise<unknown>;
  updateIfStatusAndSecret: (
    id: string,
    expectedStatus: string,
    expectSecretBound: boolean,
    patch: { status: string },
  ) => Promise<unknown>;
};

/**
 * C2 — approving a connector must NOT unconditionally activate it.
 *
 * Governance (approved?) and credentials (secret required? bound?) are
 * ORTHOGONAL axes. The previous implementation collapsed them: it flipped ANY
 * non-active connector straight to `active`, so approving a connector that
 * requires a secret it does not have activated it UNCREDENTIALED — the one thing
 * the design forbids. This delegates the decision to `resolveConnectorStatus`,
 * which is unconditionally incapable of returning "active" while
 * `requiresSecret && !hasSecret`, so nothing here decides `active` on its own.
 *
 * `deploymentMode` is passed through rather than assumed. With `approved: true`
 * the resolver's governance branch is already satisfied for every mode, so today
 * this argument cannot change the outcome — it is threaded anyway so this call
 * stays correct-by-construction if the resolver ever grows a mode-specific rule
 * (e.g. a `cloud_auth` tier), instead of silently hard-coding an assumption.
 *
 * SAFETY PROPERTIES (preserved from the inline block this replaces — approve()
 * is called by the MCP approval tool with NO wrapping transaction, so a throw
 * after the approval status flip would strand the approval as "approved" with no
 * activation):
 *  - null-tolerant: connector deleted between create and approve → no-op
 *  - company-scoped: `update` keys on id ALONE, so tenancy is checked here
 *  - idempotent: no write when the status is already the resolved one
 *  - no new throw paths
 */
export async function applyConnectorApproval(
  svc: ConnectorApprovalTarget,
  companyId: string,
  connectorId: string,
  deploymentMode: string,
): Promise<void> {
  // FINDING 6 — bounded optimistic retry. The derived status depends on BOTH the
  // connector's approval status AND whether a secret is bound, and a concurrent
  // credential-bind can change `secretRef` between our read and our write. We
  // guard the UPDATE on both axes; on a lost race we RE-READ and RE-DERIVE rather
  // than overwriting with a stale derivation (guarding on status ALONE let a
  // stale `needs_credentials` clobber a just-bound secret and strand the
  // connector). A single concurrent bind converges in one retry; the small cap is
  // belt-and-suspenders against pathological churn.
  for (let attempt = 0; attempt < 4; attempt++) {
    const connector = await svc.getById(connectorId);
    if (!connector || connector.companyId !== companyId) return;

    // `disabled` is TERMINAL here — approving must never resurrect it. Reachable in
    // `authenticated`: create → `pending_approval` + an approval row → the founder
    // PATCHes `{status:"disabled"}` (allowed; the C2 gate only blocks *non*-disabled)
    // → the board later approves the still-open approval. Without this line the
    // resolver answers `active` and a connector the founder switched off starts
    // being delivered to agents again.
    //
    // The founder's explicit disable is a LATER and more specific signal than a
    // pending install request, so it wins. This also mirrors the credential-binding
    // route, which short-circuits `disabled` for the same reason, and is symmetric
    // with `applyConnectorRejection` deliberately not touching an `active` connector.
    if (connector.status === "disabled") return;

    // An empty-string secretRef names no secret, so it is NOT a bound credential;
    // `!= null` alone would read "" as bound and activate an unusable connector.
    const hasSecret = Boolean(connector.secretRef);
    const next = resolveConnectorStatus({
      deploymentMode,
      approved: true,
      // `!== false` (not `=== true`) fails CLOSED: anything that is not explicitly
      // false is treated as "needs a secret", so a malformed value cannot activate an
      // uncredentialed connector. The column is `notNull().default(false)`, so this is
      // defensive only — but the failure it prevents is silent activation.
      requiresSecret: connector.requiresSecret !== false,
      hasSecret,
    });

    if (connector.status === next) return; // already converged — nothing to write

    // Guarded on BOTH the status AND the secret-boundness we derived from: if a
    // concurrent bind added a secret (or a founder disabled the row) since our
    // read, this matches 0 rows and we loop to re-derive from the new state rather
    // than stranding the connector. Failing closed (no activation) is the safe
    // direction if the retries are exhausted.
    const updated = await svc.updateIfStatusAndSecret(connectorId, connector.status, hasSecret, {
      status: next,
    });
    if (updated) return; // won the race
  }

  // Exhausted: fail CLOSED. We only ever write through the secret-aware guard, so
  // a connector is never left `active` without a bound secret; the founder can
  // re-bind (which re-derives) to converge.

  // NO activity-log entry here, deliberately. This runs AFTER the approval status
  // flip, and approve() is called by the MCP approval tool with no wrapping
  // transaction — a logging failure would throw and strand the approval as
  // "approved" with no activation. The approval row itself is the audit record.
}

/**
 * C2 — rejection must cover `needs_credentials` too.
 *
 * The previous guard matched only `pending_approval`. Once approval became
 * credential-aware, an approved-but-uncredentialed connector sits in
 * `needs_credentials`, and rejecting it was a SILENT NO-OP: the connector stayed
 * on a path that reaches `active` the moment a secret is bound.
 *
 * `active` is deliberately NOT covered: reject closes an *install* request, it is
 * not a kill switch for a connector already in service (PATCH → disabled is that).
 * Rejected connectors are disabled rather than deleted so the audit trail — and
 * the founder-visible "this was rejected" state — survives.
 *
 * Same safety properties as `applyConnectorApproval`: null-tolerant,
 * company-scoped, idempotent, and it never throws after the status flip.
 */
export async function applyConnectorRejection(
  svc: ConnectorApprovalTarget,
  companyId: string,
  connectorId: string,
): Promise<void> {
  const connector = await svc.getById(connectorId);
  if (!connector || connector.companyId !== companyId) return;

  if (connector.status === "pending_approval" || connector.status === "needs_credentials") {
    await svc.update(connectorId, { status: "disabled" });
  }
}

/**
 * The shared claim-first status transition for an approval — the SAME guards
 * (company scope + status IN (pending, revision_requested) + RETURNING the
 * claimed row) whether run on the pool `db` or inside a `db.transaction(tx)`.
 * Extracted so the connector transaction branch and the pooled hire/crew path
 * cannot drift (Codex plan review). Returns the claimed row, or `undefined` when
 * the WHERE matched nothing (TOCTOU / tenancy mismatch).
 */
async function transitionApproval(
  dbLike: Pick<Db, "update">,
  args: {
    id: string;
    companyId: string;
    status: "approved" | "rejected";
    decidedByUserId: string;
    decisionNote: string | null;
    now: Date;
  },
): Promise<typeof approvals.$inferSelect | undefined> {
  return dbLike
    .update(approvals)
    .set({
      status: args.status,
      decidedByUserId: args.decidedByUserId,
      decisionNote: args.decisionNote,
      decidedAt: args.now,
      updatedAt: args.now,
    })
    .where(
      and(
        eq(approvals.id, args.id),
        eq(approvals.companyId, args.companyId),
        inArray(approvals.status, ["pending", "revision_requested"]),
      ),
    )
    .returning()
    .then((rows) => rows[0]);
}

export function approvalService(db: Db) {
  const agentsSvc = agentService(db);
  const canResolveStatuses = new Set(["pending", "revision_requested"]);

  async function getExistingApproval(id: string) {
    const existing = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    return existing;
  }

  return {
    list: (companyId: string, status?: string) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (status) conditions.push(eq(approvals.status, status));
      return db.select().from(approvals).where(and(...conditions));
    },

    getById: (id: string) =>
      db
        .select()
        .from(approvals)
        .where(eq(approvals.id, id))
        .then((rows) => rows[0] ?? null),

    create: (companyId: string, data: Omit<typeof approvals.$inferInsert, "companyId">) =>
      db
        .insert(approvals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    approve: async (
      id: string,
      companyId: string,
      decidedByUserId: string,
      decisionNote?: string | null,
    ) => {
      const existing = await getExistingApproval(id);
      if (!canResolveStatuses.has(existing.status)) {
        throw unprocessable("Only pending or revision requested approvals can be approved");
      }

      // W1c: for a crew_dispatch approval, run the budget/pause preflight BEFORE the
      // status flip. approve() is called both inside a txn (HTTP route) AND directly
      // without one (MCP approval tool — server/src/mcp/tools/approval-tools.ts). Gating
      // before the UPDATE keeps "blocked → approval stays pending, retryable" true for
      // every caller; a throw after the flip would strand the approval when there is no
      // wrapping txn (tasks stuck in planning, approval closed). Payload is immutable
      // across the status flip, so reading it from `existing` is equivalent to `updated`.
      // Same reasoning, Plan 3a Task 7: resolve the deployment mode BEFORE the flip.
      // `loadConfig()` reads the config file and can throw on a malformed env
      // (parseTrustProxy / parseOptionalPortEnv), and the connector side-effect runs
      // AFTER the flip where a throw would strand the approval as "approved" with no
      // activation. `type` is immutable across the flip — the crew_dispatch block above
      // already relies on that — so reading it from `existing` is equivalent.
      const connectorDeploymentMode =
        existing.type === "install_mcp_connector" ? loadConfig().deploymentMode : null;

      let crewDispatchCandidates: Array<{
        id: string;
        assigneeAgentId: string | null;
        workMode: string | null;
        status: string | null;
      }> = [];
      if (existing.type === "crew_dispatch") {
        const payload = existing.payload as Record<string, unknown>;
        const crewDispatchThreadId = typeof payload.threadId === "string" ? payload.threadId : null;
        const crewDispatchTaskIds = Array.isArray(payload.taskIds)
          ? payload.taskIds.filter((x): x is string => typeof x === "string")
          : [];
        if (crewDispatchThreadId && crewDispatchTaskIds.length > 0) {
          const tasks = (await db
            .select({
              id: issues.id,
              assigneeAgentId: issues.assigneeAgentId,
              workMode: issues.workMode,
              status: issues.status,
            })
            .from(issues)
            .where(and(eq(issues.companyId, companyId), inArray(issues.id, crewDispatchTaskIds)))) as Array<{
            id: string;
            assigneeAgentId: string | null;
            workMode: string | null;
            status: string | null;
          }>;
          // Only tasks still parked in their created state (planning + todo) are dispatch
          // candidates — anything the founder already flipped/moved is left alone
          // (Codex #267 P2; the guarded UPDATE below is the authoritative re-check).
          crewDispatchCandidates = tasks.filter(
            (t) => t.workMode === "planning" && t.status === "todo",
          );
          // Codex #267 P2: skip the preflight when nothing remains dispatchable —
          // approving a stale approval is then a pure no-op close, and a paused thread
          // or budget hard-stop must not leave it stuck pending.
          if (crewDispatchCandidates.length > 0) {
            const preflight = await preflightCrewDispatch(db, {
              companyId,
              agentId: "",
              threadId: crewDispatchThreadId,
            });
            if (!preflight.allowed) {
              throw unprocessable(
                `Cannot dispatch crew work: ${preflight.reason ?? preflight.reasonCode}`,
              );
            }
          }
        }
      }

      // install_mcp_connector: the status flip AND the connector activation MUST
      // be atomic. The two MCP callers pass a pooled `db` → without a transaction
      // the flip commits, then a failure in applyConnectorApproval strands the
      // install (approved, connector still pending_approval — unrecoverable in
      // authenticated mode). Wrap both in ONE transaction. On the HTTP path `db`
      // is already the route tx → this opens a savepoint (behavior unchanged).
      // hire_agent / crew_dispatch never reach here — zero regression to them.
      if (existing.type === "install_mcp_connector") {
        return db.transaction(async (tx) => {
          const updated = await transitionApproval(tx, {
            id,
            companyId,
            status: "approved",
            decidedByUserId,
            decisionNote: decisionNote ?? null,
            now: new Date(),
          });
          if (!updated) return null;
          const payload = updated.payload as Record<string, unknown>;
          const connectorId = typeof payload.connectorId === "string" ? payload.connectorId : null;
          if (connectorId && connectorDeploymentMode !== null) {
            await applyConnectorApproval(
              mcpConnectorService(tx as unknown as Db),
              companyId,
              connectorId,
              connectorDeploymentMode,
            );
          }
          return updated;
        });
      }

      const now = new Date();
      const updated = await transitionApproval(db, {
        id,
        companyId,
        status: "approved",
        decidedByUserId,
        decisionNote: decisionNote ?? null,
        now,
      });

      // Defense-in-depth: if the WHERE didn't match (companyId mismatch), no
      // row was updated. Return null so the caller can't act on stale data.
      // The route layer already runs load+assertCompanyAccess, so this only
      // fires if a future caller forgets that gate.
      if (!updated) {
        return null;
      }

      let hireApprovedAgentId: string | null = null;
      if (updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.activatePendingApproval(payloadAgentId);
          hireApprovedAgentId = payloadAgentId;
        } else {
          const reportsTo = typeof payload.reportsTo === "string" ? payload.reportsTo : null;
          const parentType = typeof payload.parentType === "string"
            ? payload.parentType
            : (reportsTo ? "agent" : null);
          const parentId = typeof payload.parentId === "string"
            ? payload.parentId
            : (reportsTo ?? null);
          const created = await agentsSvc.create(updated.companyId, {
            name: String(payload.name ?? "New Agent"),
            role: String(payload.role ?? "general"),
            title: typeof payload.title === "string" ? payload.title : null,
            reportsTo,
            parentType,
            parentId,
            capabilities: typeof payload.capabilities === "string" ? payload.capabilities : null,
            adapterType: String(payload.adapterType ?? "process"),
            adapterConfig:
              typeof payload.adapterConfig === "object" && payload.adapterConfig !== null
                ? (payload.adapterConfig as Record<string, unknown>)
                : {},
            budgetMonthlyCents:
              typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0,
            metadata:
              typeof payload.metadata === "object" && payload.metadata !== null
                ? (payload.metadata as Record<string, unknown>)
                : null,
            status: "idle",
            spentMonthlyCents: 0,
            permissions: undefined,
            lastHeartbeatAt: null,
          });
          hireApprovedAgentId = created?.id ?? null;
        }
        if (hireApprovedAgentId) {
          Object.defineProperty(updated, "__approvedHireAgentId", {
            value: hireApprovedAgentId,
            enumerable: false,
          });
        }
      }

      // W1c: crew-dispatch approval side-effect. The budget/pause preflight already ran
      // BEFORE the status flip above (so a blocked dispatch can never close the approval,
      // regardless of whether the caller wraps approve() in a txn), and the candidate set
      // (payload tasks still parked as planning + todo) was computed there too. Here we
      // flip the candidates to 'standard' and dispatch them. Eng-review finding A: only
      // the tasks THIS approval flips are dispatched — anything the founder already
      // flipped/moved is skipped, so approving never enqueues a duplicate wakeup.
      if (updated.type === "crew_dispatch" && crewDispatchCandidates.length > 0) {
        const toDispatch: Array<{ id: string; assigneeAgentId: string | null; workMode: string | null }> = [];
        for (const t of crewDispatchCandidates) {
          // Guard the flip on the CURRENT row state (TOCTOU, Codex #267 P2): the WHERE
          // re-checks planning+todo, so a concurrent founder move between the SELECT and
          // this UPDATE misses (0 rows) and the task is neither flipped nor dispatched.
          // Raw update (no issueService.update wake side-effect) — dispatch is explicit below.
          const flipped = (await db
            .update(issues)
            .set({ workMode: "standard", updatedAt: new Date() })
            .where(
              and(
                eq(issues.id, t.id),
                eq(issues.companyId, companyId),
                eq(issues.workMode, "planning"),
                eq(issues.status, "todo"),
              ),
            )
            .returning({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })) as Array<{
            id: string;
            assigneeAgentId: string | null;
          }>;
          if (flipped.length === 0) continue; // moved concurrently — do not dispatch
          // Codex #267 P2: dispatch to the CURRENT assignee returned by the guarded UPDATE,
          // not the (possibly stale) SELECT snapshot — a founder may have reassigned the task
          // between the SELECT and this UPDATE, and we must wake the agent it belongs to now.
          const assigneeAgentId = flipped[0].assigneeAgentId;
          // Codex #267 P2: this raw flip bypasses issueService's issue.updated activity, and
          // crew_dispatch approvals aren't linked via issue_approvals, so the generic
          // approval.approved log carries no task ids. Log the planning→standard dispatch
          // per task so the mutation is auditable (repo rule: mutating actions are logged).
          await logActivity(db, {
            companyId,
            actorType: "user",
            actorId: decidedByUserId,
            action: "crew_dispatch.task_dispatched",
            entityType: "issue",
            entityId: t.id,
            details: {
              approvalId: id,
              fromWorkMode: "planning",
              toWorkMode: "standard",
              assigneeAgentId,
            },
          });
          toDispatch.push({ id: t.id, assigneeAgentId, workMode: "standard" });
        }

        await dispatchCreatedCrewTasks(db, companyId, toDispatch);
      }

      // (install_mcp_connector is handled atomically by the early-return above,
      // inside a transaction — it never reaches this shared post-flip path.)

      return updated;
    },

    reject: async (
      id: string,
      companyId: string,
      decidedByUserId: string,
      decisionNote?: string | null,
    ) => {
      const existing = await getExistingApproval(id);
      if (!canResolveStatuses.has(existing.status)) {
        throw unprocessable("Only pending or revision requested approvals can be rejected");
      }

      // install_mcp_connector: reject MUST be atomic too — a rejection that commits
      // while applyConnectorRejection fails leaves the connector pending_approval
      // (its "rejected" state lost), or lets a needs_credentials row later bind →
      // active, since connector status is treated as proof of prior approval. Wrap
      // both in one transaction (savepoint on the HTTP path). Codex plan review.
      if (existing.type === "install_mcp_connector") {
        return db.transaction(async (tx) => {
          const updated = await transitionApproval(tx, {
            id,
            companyId,
            status: "rejected",
            decidedByUserId,
            decisionNote: decisionNote ?? null,
            now: new Date(),
          });
          if (!updated) return null;
          const payload = updated.payload as Record<string, unknown>;
          const connectorId = typeof payload.connectorId === "string" ? payload.connectorId : null;
          if (connectorId) {
            await applyConnectorRejection(mcpConnectorService(tx as unknown as Db), companyId, connectorId);
          }
          return updated;
        });
      }

      const now = new Date();
      const updated = await transitionApproval(db, {
        id,
        companyId,
        status: "rejected",
        decidedByUserId,
        decisionNote: decisionNote ?? null,
        now,
      });

      // Defense-in-depth: companyId mismatch → no row updated → return null.
      if (!updated) {
        return null;
      }

      if (updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.terminate(payloadAgentId);
        }
      }

      // W1c: crew_dispatch reject is intentionally a NO-OP on the tasks. Auto-created
      // tasks stay on the Crew Board as 'planning' (parked) — the founder can flip them
      // to Standard or delete them later. Rejecting only closes the dispatch approval.

      // (install_mcp_connector reject is handled atomically by the early-return
      // above, inside a transaction — it never reaches this shared post-flip path.
      // applyConnectorRejection sets pending_approval AND needs_credentials →
      // disabled, keeping an audit trail rather than deleting.)

      return updated;
    },

    requestRevision: async (
      id: string,
      companyId: string,
      decidedByUserId: string,
      decisionNote?: string | null,
    ) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "pending") {
        throw unprocessable("Only pending approvals can request revision");
      }

      const now = new Date();
      const updated = await db
        .update(approvals)
        .set({
          status: "revision_requested",
          decidedByUserId,
          decisionNote: decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(and(eq(approvals.id, id), eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .returning()
        .then((rows) => rows[0]);

      // Defense-in-depth: companyId mismatch → no row updated → return null.
      return updated ?? null;
    },

    resubmit: async (id: string, companyId: string, payload?: Record<string, unknown>) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "revision_requested") {
        throw unprocessable("Only revision requested approvals can be resubmitted");
      }
      // Codex #267 P1: crew_dispatch is system-internal. Resubmit rewrites payload, so
      // allowing it would re-open the caller-controlled-taskIds dispatch vector even
      // though creation is already blocked. Only the system sets a crew_dispatch payload.
      //
      // Plan 3a Task 12: `install_mcp_connector` is system-internal in exactly the
      // same sense and was missed when this guard was written. It is not in
      // CREATABLE_APPROVAL_TYPES (it is not even in APPROVAL_TYPES) — the ONLY
      // producer is `createConnector`. Its payload's `connectorId` is the sole input
      // selecting which row `applyConnectorApproval` flips to `active`, so a caller
      // who can rewrite it makes the founder a confused deputy: the approval keeps
      // displaying `serverName: "notion"` while approving activates whatever
      // connector id was swapped in — including a stdio one that spawns a process on
      // the AoA host, and including one whose OWN approval is still pending or has
      // already been rejected.
      if (SYSTEM_INTERNAL_APPROVAL_TYPES.has(existing.type)) {
        throw unprocessable(`System-internal ${existing.type} approvals cannot be resubmitted`);
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "pending",
          payload: payload ?? existing.payload,
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: now,
        })
        .where(and(eq(approvals.id, id), eq(approvals.companyId, companyId), eq(approvals.status, "revision_requested")))
        .returning()
        .then((rows) => rows[0]);
    },

    listComments: async (approvalId: string) => {
      const existing = await getExistingApproval(approvalId);
      return db
        .select()
        .from(approvalComments)
        .where(
          and(
            eq(approvalComments.approvalId, approvalId),
            eq(approvalComments.companyId, existing.companyId),
          ),
        )
        .orderBy(asc(approvalComments.createdAt));
    },

    addComment: async (
      approvalId: string,
      body: string,
      actor: { agentId?: string; userId?: string },
    ) => {
      const existing = await getExistingApproval(approvalId);
      return db
        .insert(approvalComments)
        .values({
          companyId: existing.companyId,
          approvalId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body,
        })
        .returning()
        .then((rows) => rows[0]);
    },
  };
}
