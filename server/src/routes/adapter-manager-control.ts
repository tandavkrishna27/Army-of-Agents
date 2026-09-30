// server/src/routes/adapter-manager-control.ts
//
// DEP-011 reaper Slice B (B1) — the control-plane READ-ONLY lease-truth endpoint the
// adapter-manager (AM) PULLs to decide which of the sandboxes it owns are orphans.
//
// The AM holds the E2B key + the fleet `list` but has NO `DATABASE_URL`; the control-
// plane has the DB but not the key. So B is a read-only PULL: the AM asks "which of
// these leases are terminal/superseded?" over control-net. This is the AM's FIRST
// outbound client (B2). This endpoint is its server side.
//
// ★ DOUBLE-GATED — a CODE invariant, not a deploy note (B1-F1). The route carries NO
// authentication (the AM is not worker-enrolled — no session key / device proof — so it
// cannot use `verifyWorkerOperationProof`). Staging MUST set distributedExecutionEnabled
// to run the distributed system, so mounting on THAT flag alone would expose an
// unauthenticated cross-tenant lease-oracle on control-net the instant staging enables
// distributed execution. So — exactly like the DEP-005 `_test/reap` route
// (worker-control.ts) — it is DOUBLE-gated: app.ts mounts it only inside the
// `distributedExecutionEnabled` block AND the pre-handler below 404s unless the
// independent, default-off `AOA_ADAPTER_MANAGER_TRUTH_ROUTE_ENABLED` is "1". With EITHER
// flag off the route 404s ⇒ enabling distributed execution can never BY ITSELF expose
// it. Slice 5 still MUST add mTLS / peer-allowlist on control-net before flipping the
// truth-route flag — the double-gate makes the endpoint UNREACHABLE until then, but the
// durable auth is mTLS.
//
// ★ Reads ONLY identifiers/enums (the pinned column projection in `classifyLeaseTruth`);
// NO secret column ever crosses this boundary. Tenant-scoped, never cross-tenant: org
// ids come from the REQUEST and each per-org batch runs under `runInTenantReadOnly`
// (forced RLS filters every query) — the boundary forbids org enumeration, so there is
// no SELECT DISTINCT anywhere.

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@armyofagents/db";
import { type LeaseTruthVerdict } from "@armyofagents/db";
import { validate } from "../middleware/validate.js";
import { runInTenantReadOnly } from "../db/tenant-context.js";
import { readDistributedExecutionDeploymentFlag } from "../config/distributed-execution.js";
import { TRUTH_SHARED_SECRET_HEADER, truthBearerAccepted } from "./adapter-manager-control-auth.js";

/** The independent, default-off second gate on the unauthenticated lease-truth route
 * (B1-F1). Read via `process.env[CONST]` so the string never appears as a
 * `process.env.AOA_…` literal. */
export const TRUTH_ROUTE_ENABLED_ENV = "AOA_ADAPTER_MANAGER_TRUTH_ROUTE_ENABLED";

/** The frozen request body — leaseId ONLY (B1-F2): jobId/attempt/targetGeneration are
 * redundant with immutable DB columns the CP already holds by leaseId, and a
 * caller-supplied generation next to the classifier is a mass-kill trap. Pinned by the
 * `tests/fixtures/reaper-lease-truth/v1` fixture (dual-asserted with the AM client). */
export const leaseTruthRequestSchema = z.object({
  orgs: z.array(
    z.object({
      organizationId: z.string().uuid(),
      leases: z.array(z.object({ leaseId: z.string().uuid() })),
    }),
  ),
});

export type LeaseTruthRequest = z.infer<typeof leaseTruthRequestSchema>;

/** The frozen response body — `{ verdicts: { <leaseId>: verdict } }`. `leases.id` is a
 * globally-unique UUID, so merging every org's verdicts into ONE map is collision-free. */
export interface LeaseTruthResponse {
  readonly verdicts: Record<string, LeaseTruthVerdict>;
}

export function adapterManagerControlRoutes(opts: { appDb: Db }): Router {
  const router = Router();

  router.post(
    "/adapter-manager-control/lease-truth",
    // ── The gate. BEFORE `validate`, mirroring worker-control.ts:948-953, so a dormant
    // route is indistinguishable from an absent one for any body. THREE arms — all must
    // hold, else 404 (belt-and-suspenders: app.ts already mounts only inside the
    // distributed block; this holds even if that mounting ever changes):
    //   (1) distributed execution enabled, (2) the independent TRUTH_ROUTE_ENABLED flag,
    //   (3) DEP-012 Slice 4+5 (P3) — a matching AM↔CP shared-secret bearer. `truthBearerAccepted`
    //       is FAIL-CLOSED: an UNSET configured secret ⇒ reject (NEVER `header === env`,
    //       which falls OPEN when both are undefined). So enabling the route WITHOUT
    //       configuring the secret leaves it 404 (the negative test).
    (req, res, next) => {
      if (
        !readDistributedExecutionDeploymentFlag(process.env) ||
        process.env[TRUTH_ROUTE_ENABLED_ENV]?.trim() !== "1" ||
        !truthBearerAccepted(process.env, req.get(TRUTH_SHARED_SECRET_HEADER))
      ) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      next();
    },
    validate(leaseTruthRequestSchema),
    async (req, res, next) => {
      try {
        const body = req.body as LeaseTruthRequest;
        const verdicts: Record<string, LeaseTruthVerdict> = {};
        for (const org of body.orgs) {
          const leaseIds = org.leases.map((l) => l.leaseId);
          if (leaseIds.length === 0) continue;
          // Per-org read-only tenant transaction — org id comes from the REQUEST, never a
          // SELECT DISTINCT. Forced RLS scopes every query to this org; a wrong-tenant or
          // unknown leaseId returns zero rows → `classifyLeaseTruth` reports it `absent`.
          const orgVerdicts = await runInTenantReadOnly(opts.appDb, org.organizationId, (repos) =>
            repos.jobControl.classifyLeaseTruth(leaseIds),
          );
          for (const [leaseId, verdict] of orgVerdicts) verdicts[leaseId] = verdict;
        }
        const response: LeaseTruthResponse = { verdicts };
        res.status(200).json(response);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
