// Execution-target registry CRUD + worker self-register/heartbeat (Phase 5,
// Task 13). Router-factory `({ db })` pattern — see
// server/src/routes/environments.ts:29 (environmentRoutes) — db is injected,
// no global getDb(). executionTargets table comes from @armyofagents/db.
import { Router, type Request, type Response, type NextFunction } from "express";
import type { Db } from "@armyofagents/db";
import { executionTargets } from "@armyofagents/db";
import {
  createExecutionTargetSchema,
  workerExecutionTargetHeartbeatSchema,
  type CreateExecutionTargetInput,
  type WorkerExecutionTargetHeartbeatInput,
  WORKER_CONTROL_HEADERS,
} from "@armyofagents/shared";
import {
  createWorkerToken,
  hashWorkerToken,
  listExecutionTargets,
  registerWorkerHeartbeat,
  revokeExecutionTargetWorkerToken,
  resolveWorkerHeartbeatAuthority,
  ratifyPlatformExecutionTargetPlacementProfile,
  ratifyTenantExecutionTargetPlacementProfile,
  rotateExecutionTargetWorkerToken,
  stripWorkerSecret,
} from "../services/execution-targets.js";
import { organizationAccessService } from "../services/organization-access.js";
import { assertBoard, assertCanManageInstanceSettings } from "./authz.js";
import { conflict, forbidden, notFound, unauthorized } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { isUniqueViolation } from "../services/db-errors.js";
import { z } from "zod";
import { deviceProofHeaders } from "./worker-proof-headers.js";
import {
  createWorkerSessionAuthenticator,
  registerProofBoundHeartbeat,
  revokeTenantWorkerAuthority,
  WorkerSessionError,
  type VerifiedTargetPrincipal,
} from "../middleware/worker-session-auth.js";
import { sendWorkerProtocolError } from "../services/worker-protocol-http.js";
import { loadWorkerSelfModel } from "../services/execution-targets.js";
import {
  admitSelfModelRead,
  selfModelRefusalWireCode,
} from "../services/worker-self-model-admission.js";
import { registeredTargetProfileV1Schema } from "@armyofagents/worker-protocol";
import {
  SELF_HELLO_DESCRIPTOR,
  createWorkerHelloRefreshService,
  selfHelloRequestSchema,
  type SelfHelloRequest,
} from "../services/worker-hello-refresh.js";

const uuidParam = z.string().uuid();
const selfModelReadBody = z.object({
  protocolVersion: z.literal(1),
  /** The self-model version the worker already holds; a match answers 304. */
  knownSelfModelHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();

const placementProfileBody = z.object({
  registeredProfile: z.record(z.string(), z.unknown()),
  providerConstraintProfile: z.record(z.string(), z.unknown()),
}).strict();

/**
 * Worker self-auth (Finding #3). The bearer credential is a rotatable worker
 * token minted at registration; only its SHA-256 hash is stored on the target
 * row. We hash the presented token and resolve it to exactly one target id.
 * The row id itself is NO LONGER a credential.
 */
function requireWorkerHeartbeatAuthority(db: Db, workerSession?: {
  appDb: Db;
  operatorDb: Db;
  sessionSigningKey: string;
  now?: () => Date;
}) {
  const sessionAuthenticator = workerSession
    ? createWorkerSessionAuthenticator(workerSession)
    : null;
  return async (req: Request, res: Response, next: NextFunction) => {
    if (sessionAuthenticator) res.locals.workerProtocolV1 = true;
    try {
      const header = req.header("authorization") ?? "";
      const match = /^Bearer\s+(.+)$/i.exec(header.trim());
      const token = match?.[1]?.trim();
      if (!token) {
        next(unauthorized());
        return;
      }
      const legacyAuthority = await resolveWorkerHeartbeatAuthority(db, token);
      if (legacyAuthority) {
        (req as Request & {
          workerHeartbeatAuthority?: {
            kind: "legacy"; targetId: string; organizationId: string;
          };
        }).workerHeartbeatAuthority = { kind: "legacy", ...legacyAuthority };
        next();
        return;
      }
      const proof = deviceProofHeaders(req);
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
      const correlationId = req.header(WORKER_CONTROL_HEADERS.requestId);
      if (!sessionAuthenticator || !proof || !rawBody || !correlationId) {
        next(unauthorized());
        return;
      }
      const principal = await sessionAuthenticator.authenticate({
        authorization: header,
        rawBody,
        proof,
        method: req.method,
        path: req.originalUrl,
        correlationId,
      });
      (req as Request & { workerHeartbeatAuthority?: { kind: "session"; principal: VerifiedTargetPrincipal } })
        .workerHeartbeatAuthority = { kind: "session", principal };
      next();
    } catch (err) {
      next(err instanceof WorkerSessionError ? unauthorized() : err);
    }
  };
}

export function executionTargetRoutes(opts: {
  db: Db;
  workerSession?: { appDb: Db; operatorDb: Db; sessionSigningKey: string; now?: () => Date };
}) {
  const router = Router();
  const orgAccess = organizationAccessService(opts.db);

  // Shared by both routes below. The orgAccess.canOrg check inside this same
  // helper (not the caller) is the real gate — assertBoard is just the
  // actor-type guard.
  async function assertOrgAdmin(req: Request, orgId: string): Promise<void> {
    // rbac: paired-via-helper — orgAccess.canOrg below is the gate.
    assertBoard(req);
    const userId = req.actor.type === "board" ? (req.actor.userId ?? null) : null;
    if (!userId) throw forbidden("Sign in to manage execution targets");
    const allowed = await orgAccess.canOrg(orgId, userId, "execution_target:manage");
    if (!allowed) throw forbidden("You are not an owner/admin of this organization");
  }

  // Owner registers a dedicated target (semi-manual: paste slug + endpoint).
  // RBAC: caller must be founder/org-admin of :orgId.
  router.post("/organizations/:orgId/execution-targets", validate(createExecutionTargetSchema), async (req, res, next) => {
    try {
      const orgId = uuidParam.parse(req.params.orgId);
      await assertOrgAdmin(req, orgId);
      const input = req.body as CreateExecutionTargetInput;
      // DSK-00 (D16/F27). This router is mounted OUTSIDE the distributed-execution flag
      // block in app.ts, so without this guard an org admin could register an ACTIVE
      // `desktop` target on a deployment where desktop does not exist — and a run pinned
      // to it used to execute on the CONTROL-PLANE host (F28, fixed separately).
      //
      // `opts.workerSession` is already exactly the flag: app.ts derives it as
      // `distributedExecutionEnabled && tenantAppDb && operatorDb && signingKey`, so
      // truthy means distributed execution is genuinely usable. No new plumbing.
      //
      // 403 rather than 400, matching the two existing refusals in this file (":265",
      // ":293"): a disabled capability is "you may not", not "your input is malformed".
      //
      // Rejecting at CREATE, never by filtering GET — D16 rejects filtering because it
      // hides an already-enabled row instead of neutralising it, which is strictly worse
      // for incident review.
      if (input.kind === "desktop" && !opts.workerSession) {
        throw forbidden(
          "Desktop execution targets require distributed execution to be enabled.",
        );
      }
      // Mint a rotatable worker credential: persist only its hash, return the
      // plaintext ONCE. The row id is no longer a credential (Finding #3).
      const workerToken = createWorkerToken();
      const scope = input.ownerUserId ? "owner" : "organization";
      const targetAuthorityKey = input.ownerUserId
        ? `owner:${orgId}:${input.ownerUserId}`
        : `organization:${orgId}`;
      const [row] = await opts.db
        .insert(executionTargets)
        .values({
          organizationId: orgId,
          ...input,
          scope,
          targetAuthorityKey,
          workerTokenHash: hashWorkerToken(workerToken),
        })
        .returning();
      // Audit trail: registering an execution destination is security-sensitive
      // and must be visible to incident review. activity_log is company-scoped
      // (company_id NOT NULL) and has no organization column, so this org-scoped
      // mutation cannot be a row there; emit a structured log line instead (same
      // pattern as the operator break-glass org-wide audit fix). A durable
      // org-scoped audit feed is tracked for the M6 org-scoped audit feed.
      const operatorUserId = req.actor.type === "board" ? (req.actor.userId ?? null) : null;
      logger.info(
        {
          action: "execution_target.register",
          organizationId: orgId,
          executionTargetId: row!.id,
          operatorUserId,
          scope: "org_scoped",
        },
        "execution target registered",
      );
      res.status(201).json({ ...stripWorkerSecret(row!), workerToken });
    } catch (err) {
      if (isUniqueViolation(err, "execution_targets_org_slug_uq")) {
        next(conflict("An execution target with this slug already exists in the organization."));
        return;
      }
      next(err);
    }
  });

  router.get("/organizations/:orgId/execution-targets", async (req, res, next) => {
    try {
      const orgId = uuidParam.parse(req.params.orgId);
      await assertOrgAdmin(req, orgId);
      res.json(await listExecutionTargets(opts.db, orgId));
    } catch (err) {
      next(err);
    }
  });

  router.post("/organizations/:orgId/execution-targets/:targetId/rotate-token", async (req, res, next) => {
    try {
      const orgId = uuidParam.parse(req.params.orgId);
      const targetId = uuidParam.parse(req.params.targetId);
      await assertOrgAdmin(req, orgId);
      const rotated = await rotateExecutionTargetWorkerToken(opts.db, {
        organizationId: orgId,
        targetId,
      });
      if (!rotated) throw notFound("Execution target not found");

      const operatorUserId = req.actor.type === "board" ? (req.actor.userId ?? null) : null;
      logger.info(
        {
          action: "execution_target.worker_token.rotated",
          organizationId: orgId,
          executionTargetId: targetId,
          operatorUserId,
          scope: "org_scoped",
          reasonCode: "worker_authority_revoked",
        },
        "execution target worker token rotated",
      );
      res.json({ ...rotated.target, workerToken: rotated.workerToken });
    } catch (err) {
      next(err);
    }
  });

  router.post("/organizations/:orgId/execution-targets/:targetId/revoke", async (req, res, next) => {
    try {
      const orgId = uuidParam.parse(req.params.orgId);
      const targetId = uuidParam.parse(req.params.targetId);
      await assertOrgAdmin(req, orgId);
      const target = opts.workerSession
        ? await revokeTenantWorkerAuthority({
            appDb: opts.workerSession.appDb,
            organizationId: orgId,
            executionTargetId: targetId,
          }).then((generation) => generation === null ? null : {
            id: targetId,
            organizationId: orgId,
            status: "disabled",
            deviceGeneration: generation,
          })
        : await revokeExecutionTargetWorkerToken(opts.db, {
            organizationId: orgId,
            targetId,
          });
      if (!target) throw notFound("Execution target not found");

      const operatorUserId = req.actor.type === "board" ? (req.actor.userId ?? null) : null;
      logger.info(
        {
          action: "execution_target.worker_token.revoked",
          organizationId: orgId,
          executionTargetId: targetId,
          operatorUserId,
          scope: "org_scoped",
        },
        "execution target worker token revoked",
      );
      res.json(target);
    } catch (err) {
      next(err);
    }
  });

  router.put(
    "/organizations/:orgId/execution-targets/:targetId/placement-profile",
    validate(placementProfileBody),
    async (req, res, next) => {
      try {
        const orgId = uuidParam.parse(req.params.orgId);
        const targetId = uuidParam.parse(req.params.targetId);
        await assertOrgAdmin(req, orgId);
        if (!opts.workerSession) throw forbidden("Distributed execution registry is disabled");
        const input = req.body as z.infer<typeof placementProfileBody>;
        const target = await ratifyTenantExecutionTargetPlacementProfile({
          appDb: opts.workerSession.appDb,
          organizationId: orgId,
          executionTargetId: targetId,
          ...input,
        });
        logger.info({
          action: "execution_target.placement_profile.ratified",
          organizationId: orgId,
          executionTargetId: targetId,
          profileHash: target.registeredProfileHash,
          scope: "org_scoped",
        }, "execution target placement profile ratified");
        res.json(target);
      } catch (err) {
        next(err);
      }
    },
  );

  router.put(
    "/operator/execution-targets/:targetId/placement-profile",
    validate(placementProfileBody),
    async (req, res, next) => {
      try {
        assertCanManageInstanceSettings(req);
        if (!opts.workerSession) throw forbidden("Distributed execution registry is disabled");
        const targetId = uuidParam.parse(req.params.targetId);
        const input = req.body as z.infer<typeof placementProfileBody>;
        const target = await ratifyPlatformExecutionTargetPlacementProfile({
          operatorDb: opts.workerSession.operatorDb,
          executionTargetId: targetId,
          ...input,
        });
        logger.info({
          action: "execution_target.placement_profile.ratified",
          executionTargetId: targetId,
          profileHash: target.registeredProfileHash,
          scope: "platform",
        }, "platform execution target placement profile ratified");
        res.json(target);
      } catch (err) {
        next(err);
      }
    },
  );

  // WRK-008 slice 1 — a worker reads its OWN self-model: the registered target
  // profile + the provider-constraint profile, the two artefacts WorkerSelfModel
  // needs before it can advertise capacity, self-check an offer and take a lease.
  //
  // The URL carries NO target identifier, no org id and no slug. The target comes
  // from the authenticated principal, so "could this caller reach another tenant's
  // profile?" is answered by CONSTRUCTION rather than by a check that could drift.
  // `self` in the path makes that explicit to a reader.
  //
  // POST, not GET, and that is load-bearing: `rawBody` is only captured when the body
  // is non-empty (app.ts), and the worker-session auth path REQUIRES `rawBody` to
  // recompute the device proof's body digest. A GET therefore could never authenticate
  // as a worker session - which is why all ten frozen worker ops are POST too.
  //
  // Conditional: body `knownSelfModelHash` returns 304 when the worker already
  // holds the current self-model, so a worker can re-check cheaply on every poll
  // cycle instead of caching a self-model across a generation bump. Both halves are
  // covered by that hash, so a constraint-profile change cannot slip past it.
  //
  // Both payloads are served AS STORED - no re-shaping, no field selection.
  //
  // Precisely why, because it is easy to overstate: key ORDER is irrelevant, since
  // `canonicalizeJsonV1` sorts keys before the digest is computed, and a JSONB round
  // trip does not preserve order anyway. What the worker's
  // `verifyAndBrandProviderConstraintProfileV1` actually requires is that every FIELD
  // and VALUE survive intact - it recomputes the digest over every key except
  // `digest`, so a dropped, added or coerced field fails the brand and the worker
  // refuses its own self-model. Serving the stored object untouched is how that is
  // guaranteed rather than reasoned about.
  // Mounted ONLY when distributed execution is genuinely usable. `opts.workerSession`
  // is already exactly that flag (app.ts derives it as
  // `distributedExecutionEnabled && tenantAppDb && operatorDb && signingKey`), and the
  // route is absent rather than present-and-always-refusing, so "unreachable when the
  // composition is off" is true by absence instead of by behaviour.
  if (opts.workerSession) router.post(
    "/execution-targets/self/placement-profile",
    requireWorkerHeartbeatAuthority(opts.db, opts.workerSession),
    validate(selfModelReadBody),
    async (req, res, next) => {
      try {
        const authority = (req as Request & {
          workerHeartbeatAuthority?:
            | { kind: "legacy"; targetId: string; organizationId: string }
            | { kind: "session"; principal: VerifiedTargetPrincipal };
        }).workerHeartbeatAuthority!;

        // Every refusal below answers with the SAME coarse `unauthorized`, including
        // "no such target" and "never configured". A caller learns it may not read a
        // self-model, never which of the reasons applied — otherwise this route
        // becomes an oracle for target existence, generation and revocation state.
        // A credential/lifecycle refusal is terminal; "an operator has not configured
        // this target yet" is RETRYABLE. See `selfModelRefusalWireCode` for why telling
        // an authenticated owner a fact about its own target discloses nothing.
        const deny = (code: "unauthorized" | "internal_unavailable" = "unauthorized") => {
          sendWorkerProtocolError(req, res, code, opts.workerSession?.now?.() ?? new Date());
        };

        // Refuse the weaker credential BEFORE touching the database. The decision
        // function refuses it too (that is where it is mutation-tested); doing it here
        // as well means a legacy token never causes a read on behalf of a caller that
        // was never going to be served.
        if (authority.kind !== "session") {
          deny();
          return;
        }

        const selfModel = await loadWorkerSelfModel(opts.db, authority.principal.targetId);
        if (!selfModel) {
          deny();
          return;
        }

        const decision = admitSelfModelRead({
          authorityKind: authority.kind,
          principalTargetGeneration: authority.principal.targetGeneration,
          profileDeviceGeneration: selfModel.deviceGeneration,
          revokedAt: selfModel.revokedAt,
          targetStatus: selfModel.targetStatus,
          hasRegisteredProfile: selfModel.registeredProfile !== null,
          hasProviderConstraintProfile: selfModel.providerConstraintProfile !== null,
        });
        if (!decision.admit) {
          deny(selfModelRefusalWireCode(decision.reason));
          return;
        }

        const { knownSelfModelHash: known } = req.body as z.infer<typeof selfModelReadBody>;
        if (known !== undefined && selfModel.selfModelHash !== null && known === selfModel.selfModelHash) {
          res.status(304).end();
          return;
        }

        res.status(200).json({
          protocolVersion: 1,
          selfModelHash: selfModel.selfModelHash,
          registeredProfile: selfModel.registeredProfile,
          providerConstraintProfile: selfModel.providerConstraintProfile,
          serverTime: (opts.workerSession?.now?.() ?? new Date()).toISOString(),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // WRK-011 (Sprint 2.75) — a worker REFRESHES its enrolled self-model. A worker that
  // still holds a live session and can still sign with its enrolled device key presents a
  // provisioned hello; if it stays inside the admin-ratified ceiling, `profile_snapshot`,
  // `profile_hash` and a fresh session move together in ONE transaction (the mint before
  // commit, so a mint throw rolls the UPDATE back). This closes E4-F010 — the only channel
  // by which an already-enrolled worker can become matchable without an operator re-paste.
  //
  // Mounted beside the self-model read (NOT under /worker-control/): it is a LOCAL op with a
  // LOCAL descriptor, not an eleventh frozen worker-control operation (E4-D02). Same URL
  // discipline as the self-model read — no identifier in path or body; identity comes from
  // the authenticated principal, so cross-tenant reach is answered by construction.
  //
  // ★ DORMANCY IS WEAKER HERE than under /worker-control/ (design §3.3): executionTargetRoutes
  // is mounted OUTSIDE the distributed-execution flag block (app.ts), so this route's absence
  // when the composition is off rests on ONE conditional registration — the `if (opts.workerSession)`
  // below — not on a structural non-mount. `desktop-disabled.negative.test.ts` proves it by
  // SOURCE SCAN (the strongest available proof given app.ts:588), and says so.
  if (opts.workerSession) router.post(
    "/execution-targets/self/hello",
    requireWorkerHeartbeatAuthority(opts.db, opts.workerSession),
    validate(selfHelloRequestSchema),
    async (req, res, next) => {
      try {
        const workerSession = opts.workerSession!;
        const nowFn = () => workerSession.now?.() ?? new Date();
        const authority = (req as Request & {
          workerHeartbeatAuthority?:
            | { kind: "legacy"; targetId: string; organizationId: string }
            | { kind: "session"; principal: VerifiedTargetPrincipal };
        }).workerHeartbeatAuthority!;

        // Every refusal answers the SAME coarse code (§5.3): the reason reaches the operator
        // log, never the wire, so this route cannot become an oracle for target existence or
        // configuration state.
        const deny = (code: "unauthorized" | "malformed" | "internal_unavailable" = "unauthorized") => {
          sendWorkerProtocolError(req, res, code, nowFn());
        };

        // Size gate before any DB read (the descriptor's maxRequestBytes is strictly below the
        // global 20mb limit, so this guard is reachable rather than dead code — §Step 3).
        const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
        if (rawBody && rawBody.length > SELF_HELLO_DESCRIPTOR.maxRequestBytes) {
          deny("malformed");
          return;
        }

        // Layer 0 (§5.1): a legacy rotatable worker token carries NO device proof and may not
        // perform a durable snapshot WRITE. Refuse it before touching the database. M1.
        if (authority.kind !== "session") {
          deny();
          return;
        }

        const { hello } = req.body as SelfHelloRequest;

        // The admin-ratified ceiling: capabilityCeiling + policyHash from the registered
        // target profile. Absent/unparseable ⇒ `ratified: null` ⇒ profile_unratified.
        const selfModel = await loadWorkerSelfModel(opts.db, authority.principal.targetId);
        const parsedProfile = selfModel?.registeredProfile
          ? registeredTargetProfileV1Schema.safeParse(selfModel.registeredProfile)
          : null;
        const ratified = parsedProfile?.success
          ? { capabilityCeiling: parsedProfile.data.capabilityCeiling, policyHash: parsedProfile.data.policyHash }
          : null;

        const service = createWorkerHelloRefreshService({
          appDb: workerSession.appDb,
          sessionSigningKey: workerSession.sessionSigningKey,
          now: nowFn,
        });
        const outcome = await service.refresh({ principal: authority.principal, hello, ratified });

        if (outcome.outcome === "refreshed") {
          // Same response header enrolment/renewal set, so the daemon transport reads a
          // refreshed session exactly as it reads an enrolled or renewed one.
          res.setHeader(WORKER_CONTROL_HEADERS.session, outcome.session);
          // D-5 structured audit record: the target is the unit of admin intent, so a device
          // flipping itself matchable inside a ratified ceiling must be visible to review.
          logger.info({
            action: "worker.hello.refreshed",
            organizationId: authority.principal.organizationId,
            executionTargetId: authority.principal.targetId,
            workerId: authority.principal.workerId,
            oldProfileHash: authority.principal.profileHash,
            newProfileHash: outcome.profileHash,
            reportedCapabilities: hello.reportedCapabilities,
            scope: "org_scoped",
          }, "worker hello refreshed");
          res.status(200).json({
            protocolVersion: 1,
            profileHash: outcome.profileHash,
            serverTime: nowFn().toISOString(),
          });
          return;
        }
        if (outcome.outcome === "unchanged") {
          res.status(204).end();
          return;
        }
        if (outcome.outcome === "refused") {
          logger.warn({
            action: "worker.hello.refresh_denied",
            executionTargetId: authority.principal.targetId,
            reasonCode: `worker_hello_refresh_${outcome.logReason}`,
          }, "worker hello refresh denied");
          // Coarse `unauthorized` on the wire for EVERY refused reason (§5.3, Step 1
          // exhaustiveness); the two-valued+ discriminant lives only in the log above.
          deny("unauthorized");
          return;
        }
        // A mint/DB defect is a server answer (503), not a fact about the caller.
        logger.error({
          action: "worker.hello.refresh.failed",
          reasonCode: "worker_hello_refresh_internal_unavailable",
        }, "worker hello refresh unavailable");
        deny("internal_unavailable");
      } catch (err) {
        next(err);
      }
    },
  );

  // Worker self-heartbeat: the worker token is bound to ONE target id. The
  // middleware resolves req.workerTargetId; the URL carries NO slug/org so a
  // caller can never address another tenant's row. Fail closed with 404 when
  // the id no longer exists.
  router.post(
    "/execution-targets/heartbeat",
    requireWorkerHeartbeatAuthority(opts.db, opts.workerSession),
    validate(workerExecutionTargetHeartbeatSchema),
    async (req, res, next) => {
    try {
      const input = req.body as WorkerExecutionTargetHeartbeatInput;
      const authority = (req as Request & {
        workerHeartbeatAuthority?:
          | { kind: "legacy"; targetId: string; organizationId: string }
          | { kind: "session"; principal: VerifiedTargetPrincipal };
      }).workerHeartbeatAuthority!;
      const updated = authority.kind === "legacy"
        ? (await registerWorkerHeartbeat(opts.db, {
            targetId: authority.targetId,
            organizationId: authority.organizationId,
            status: input.status,
            capabilities: input.capabilities,
          })).updated
        : (await registerProofBoundHeartbeat({
            appDb: opts.workerSession!.appDb,
            operatorDb: opts.workerSession!.operatorDb,
            principal: authority.principal,
            status: input.status ?? "active",
          }) ? 1 : 0);
      if (updated === 0) {
        if (authority.kind === "session") {
          sendWorkerProtocolError(req, res, "unauthorized", opts.workerSession?.now?.() ?? new Date());
          return;
        }
        res.status(404).json({ error: "execution target not found" });
        return;
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
    },
  );

  return router;
}
