// server/src/routes/desktop-devices.ts
//
// DSK-001 Lane D (D17) — the owner-scoped device listing.
//
// MOUNTED INSIDE THE DISTRIBUTED-EXECUTION FLAG BLOCK, deliberately. DSK-00 clause (a)
// then holds BY CONSTRUCTION rather than by a guard: with the flag off this router is
// never mounted and every path under it 404s. That is the opposite of F27, where
// `executionTargetRoutes` sits 97 lines outside the block and Lane C had to add an
// explicit `kind === "desktop"` refusal to compensate. A structural test in
// `desktop-disabled.negative.test.ts` asserts the mount stays inside.
//
// A LISTING IS A READ, and so is VERIFY. There is no revoke, rename, or re-enrol here.
// Device MUTATION is DSK-003's story, and adding a write to the first flag-gated surface
// would widen it before anything has exercised the read. The E11 M2 verify action added
// below changes NO state: it re-derives `sha256(SPKI DER)` from the STORED public key and
// checks it against the stored thumbprint. It reads enrolment facts; it is not a mutation.

import { Router, type Request } from "express";

import type { Db } from "@armyofagents/db";

import {
  listDesktopDevices,
  verifyDesktopDeviceEnrolmentKey,
} from "../services/execution-targets.js";
import { organizationAccessService } from "../services/organization-access.js";
import { assertBoard } from "./authz.js";
import { forbidden, notFound } from "../errors.js";
import { z } from "zod";

const uuidParam = z.string().uuid();

export function desktopDeviceRoutes(opts: { db: Db }): Router {
  const router = Router();
  const orgAccess = organizationAccessService(opts.db);

  /**
   * Same authz as every sibling execution-target route: org owner/admin only, gated on
   * the `execution_target:manage` permission. A device listing discloses which machines
   * an organization has enrolled, which is exactly the audience that permission names.
   */
  async function assertOrgAdmin(req: Request, orgId: string): Promise<void> {
    // rbac: paired-via-helper — orgAccess.canOrg below is the gate.
    assertBoard(req);
    const userId = req.actor.type === "board" ? (req.actor.userId ?? null) : null;
    if (!userId) throw forbidden("Sign in to view enrolled devices");
    const allowed = await orgAccess.canOrg(orgId, userId, "execution_target:manage");
    if (!allowed) throw forbidden("You are not an owner/admin of this organization");
  }

  router.get("/organizations/:orgId/desktop-devices", async (req, res, next) => {
    try {
      const orgId = uuidParam.parse(req.params.orgId);
      await assertOrgAdmin(req, orgId);
      res.json(await listDesktopDevices(opts.db, orgId));
    } catch (err) {
      next(err);
    }
  });

  /**
   * E11 M2 — VERIFY ENROLMENT KEY. Org-admin, read-only. Re-derives the stored key's
   * thumbprint and confirms it matches the stored thumbprint and that the key is a
   * structurally valid Ed25519 SPKI. Changes no state and asserts nothing about the
   * device being live or a distinct physical machine (machine attestation is E11-F005 /
   * open Q2, and is NOT built).
   *
   * The device lookup is scoped to `:orgId` in SQL, so an admin of one org verifying a
   * device that belongs to ANOTHER org gets a 404 — the org-admin gate on `:orgId` is not
   * enough on its own; the row must also belong to that org.
   */
  router.post(
    "/organizations/:orgId/desktop-devices/:deviceId/verify",
    async (req, res, next) => {
      try {
        const orgId = uuidParam.parse(req.params.orgId);
        const deviceId = uuidParam.parse(req.params.deviceId);
        await assertOrgAdmin(req, orgId);
        const result = await verifyDesktopDeviceEnrolmentKey(opts.db, orgId, deviceId);
        if (result === null) throw notFound("Device not found");
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
