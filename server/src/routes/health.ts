import { Router } from "express";
import type { Db } from "@armyofagents/db";
import type { DeploymentExposure, DeploymentMode } from "@armyofagents/shared";

export function healthRoutes(
  db?: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    distributedExecutionEnabled?: boolean;
  } = {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
    distributedExecutionEnabled: false,
  },
) {
  const router = Router();

  // DEP-003 (E6 deployment harness): pure LIVENESS. The process is up; this probe
  // performs NO schema-compatibility or dependency checks (that is readiness,
  // `/api/ready`) and never blocks, so a container liveness probe stays green even
  // while readiness is 503-gated behind a pending migration.
  router.get("/live", (_req, res) => {
    res.json({ status: "ok", live: true, revision: process.env.AOA_DEPLOY_SHA || null });
  });

  router.get("/", async (_req, res) => {
    if (!db) {
      res.json({ status: "ok" });
      return;
    }

    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    if (opts.deploymentMode === "authenticated") {
      const [{ count, sql }, { instanceUserRoles }] = await Promise.all([
        import("drizzle-orm"),
        import("@armyofagents/db"),
      ]);
      const roleCount = await db
        .select({ count: count() })
        .from(instanceUserRoles)
        .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
        .then((rows) => Number(rows[0]?.count ?? 0));
      bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";
    }

    res.json({
      status: "ok",
      revision: process.env.AOA_DEPLOY_SHA || null,
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
      ...(opts.distributedExecutionEnabled ? { distributedExecutionEnabled: true } : {}),
    });
  });

  return router;
}
