import { Router } from "express";
import { z } from "zod";
import type { Db } from "@armyofagents/db";
import { validate } from "../middleware/validate.js";
import { activityService } from "../services/activity.js";
import {
  accessibleCompanyIdsForActor,
  assertBoard,
  assertCanManageInstanceSettings,
  assertCompanyAccess,
} from "./authz.js";
import { issueService } from "../services/index.js";
import { sanitizeRecord } from "../redaction.js";
import {
  ReservedActivityNamespaceError,
  assertUnreservedActivityNamespace,
} from "../services/activity-namespace.js";

const createActivitySchema = z
  .object({
    actorType: z.enum(["agent", "user", "system", "autonomy"]).optional().default("system"),
    actorId: z.string().min(1),
    action: z.string().min(1),
    entityType: z.string().min(1),
    entityId: z.string().min(1),
    agentId: z.string().uuid().optional().nullable(),
    details: z.record(z.unknown()).optional().nullable(),
  })
  .superRefine((event, ctx) => {
    // DELEGATED, not re-implemented. This route used to inline the marketplace
    // reservation, so the HTTP writer and the service writer were two copies of
    // one rule that could drift apart — and a reservation that holds in one
    // writer and not the other is worth nothing. A `security.denied.*` row is
    // EVIDENCE THAT A CONTROL REFUSED SOMETHING; if an authenticated board
    // client could POST one, "there is a denial record" would stop implying "a
    // control denied". One predicate, three writers, one test.
    try {
      assertUnreservedActivityNamespace(event);
    } catch (err) {
      if (!(err instanceof ReservedActivityNamespaceError)) throw err;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: err.message });
    }
  });

/**
 * Query shape for the operator-plane denial reader. Everything is optional and
 * nothing widens: `companyId` narrows to one tenant, and `limit` is re-clamped
 * in the service so a bad value cannot mean "no limit" even if a future caller
 * bypasses this schema.
 *
 * ★ `limit` is a PAGE SIZE, not a scan bound. It bounds the result set only —
 * `activity_log` has no index on `action`, so the query is a seq scan + sort per
 * page. That is measured and filed; do not restate it as a protection.
 *
 * ★ `before`/`beforeId` are the KEYSET CURSOR, and `beforeId` is required
 * whenever `before` is a page boundary rather than a wall-clock choice —
 * `created_at` is not unique, so a timestamp-only cursor drops rows on a tie.
 * Passing `beforeId` alone is rejected rather than ignored: a cursor half that
 * silently does nothing is how a pager loses the oldest evidence.
 *
 * ★ `before` is NOT parsed into a `Date` anywhere on this path. It is carried as
 * text and cast to `timestamptz` in SQL, because a `Date` holds milliseconds
 * while the rows are ordered at microseconds — see `SecurityDenialQuery.before`
 * for the measurement. `since` may safely be a `Date`: it is a wall-clock bound
 * an operator chooses, not a value round-tripped out of a previous page.
 */
const securityDenialQuerySchema = z
  .object({
    crossing: z.string().min(1).optional(),
    surface: z.string().min(1).optional(),
    actorId: z.string().min(1).optional(),
    entityType: z.string().min(1).optional(),
    entityId: z.string().min(1).optional(),
    companyId: z.string().uuid().optional(),
    since: z.string().datetime().optional(),
    before: z.string().datetime().optional(),
    beforeId: z.string().uuid().optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.beforeId && !value.before) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["beforeId"],
        message: "beforeId requires before: pass both halves of the cursor from the last row of the previous page",
      });
    }
  });

export function activityRoutes(db: Db) {
  const router = Router();
  const svc = activityService(db);
  const issueSvc = issueService(db);

  router.get("/companies/:companyId/activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);

    const filters = {
      companyId,
      agentId: req.query.agentId as string | undefined,
      actorType: req.query.actorType as "agent" | "user" | "system" | "autonomy" | undefined,
      actorId: req.query.actorId as string | undefined,
      entityType: req.query.entityType as string | undefined,
      entityId: req.query.entityId as string | undefined,
    };
    const result = await svc.list(filters);
    res.json(result);
  });

  /**
   * ★ THE OPERATOR READER FOR `security.denied.*` — E0-F013 Decision 2,
   * acceptance condition (a). See `activityService.securityDenials` for why this
   * exists, why it is cross-tenant, and why it is deliberately NOT a
   * company-scoped surface.
   *
   * The gate is `assertCanManageInstanceSettings` — the OPERATOR plane
   * (`req.actor.operator` / the `local_implicit` self-hosted board), not
   * `isInstanceAdmin`, which is clamped to false in cloud_auth to kill the
   * data-plane bypass. That choice is what keeps this route reachable by a real
   * cloud operator while remaining closed to every company member, including
   * founders, in every deployment mode.
   *
   * Paging is a keyset cursor: take `cursor` + `id` from the LAST row of a page
   * and pass them back as `before` + `beforeId` to get the next older page.
   * Without it, only the newest `limit` matches are reachable at all — see
   * `activityService.securityDenials`. Page on `cursor`, never on `createdAt`.
   */
  router.get("/instance/security-denials", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const parsed = securityDenialQuerySchema.parse(req.query);
    const result = await svc.securityDenials({
      ...parsed,
      since: parsed.since ? new Date(parsed.since) : undefined,
      // `before` is deliberately passed through as text — see the schema above.
    });
    res.json(result);
  });

  router.post("/companies/:companyId/activity", validate(createActivitySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const event = await svc.create({
      companyId,
      ...req.body,
      details: req.body.details ? sanitizeRecord(req.body.details) : null,
    });
    res.status(201).json(event);
  });

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs
  router.param("id", async (req, res, next, rawId) => {
    try {
      if (/^[A-Z]+-\d+$/i.test(rawId)) {
        const issue = await issueSvc.getByIdentifier(rawId, accessibleCompanyIdsForActor(req.actor));
        if (issue) {
          req.params.id = issue.id;
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/issues/:id/activity", async (req, res) => {
    const id = req.params.id as string;
    const issue = await issueSvc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyAccess(db, req, issue.companyId);
    // Scope the read to the SAME company the gate above authorized. Before
    // E0-F013 (c) the gate used `issue.companyId` and the read used no company
    // at all, so the two disagreed for any row whose entity keys were chosen by
    // a caller rather than by the task.
    const result = await svc.forIssue(issue.companyId, id);
    res.json(result);
  });

  router.get("/issues/:id/runs", async (req, res) => {
    const id = req.params.id as string;
    const issue = await issueSvc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyAccess(db, req, issue.companyId);
    const result = await svc.runsForIssue(issue.companyId, id);
    res.json(result);
  });

  router.get("/heartbeat-runs/:runId/issues", async (req, res) => {
    const runId = req.params.runId as string;
    const companyId = await svc.companyIdForRun(runId);
    if (!companyId) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    await assertCompanyAccess(db, req, companyId);
    const result = await svc.issuesForRun(runId);
    res.json(result);
  });

  return router;
}
