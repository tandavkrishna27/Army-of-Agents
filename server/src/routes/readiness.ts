/**
 * DEP-003 (E6 deployment harness): the readiness surface, distinct from liveness.
 *
 *   - `/api/health` + `/api/health/live` (health.ts) = LIVENESS only (process up).
 *   - `/api/ready` (here) = READINESS: the applied migration identity is COMPATIBLE
 *     with the image's `loadRequiredMigrationIdentity()` AND dependency health
 *     (PostgreSQL + MinIO) is good.
 *
 * The readiness-gate middleware 503s tenant/app routes until ready — NOT a crash;
 * `/api/health`, `/api/health/live`, and `/api/ready` themselves ALWAYS answer
 * (they are mounted before the gate). The gate is DORMANT unless explicitly enabled,
 * so a flag-off single-tenant startup is unchanged except for these additive routes.
 */
import { Router, type RequestHandler } from "express";
import type { SchemaCompatibility } from "../services/schema-compatibility.js";

export type DependencyStatus = "ok" | "unavailable" | "not_checked";

export interface ReadinessSnapshot {
  live: true;
  ready: boolean;
  schemaCompatible: boolean;
  dependencies: {
    postgres: DependencyStatus;
    minio: DependencyStatus;
  };
}

export type ReadinessProbe = () => Promise<ReadinessSnapshot>;

export interface ReadinessDependencies {
  schemaCompatibility: () => Promise<SchemaCompatibility>;
  checkPostgres: () => Promise<boolean>;
  /** Omitted -> MinIO is not part of this deployment (single-tenant); reported `not_checked`. */
  checkMinio?: () => Promise<boolean>;
}

/**
 * Compose a readiness probe from dependency checks. `live` is always true (the
 * process is up); `ready` requires schema compatibility AND every REQUIRED
 * dependency to be healthy. Liveness stays up even while readiness is down.
 */
export function buildReadinessProbe(deps: ReadinessDependencies): ReadinessProbe {
  return async () => {
    const [schema, postgresOk, minioOk] = await Promise.all([
      deps.schemaCompatibility(),
      deps.checkPostgres().catch(() => false),
      deps.checkMinio ? deps.checkMinio().catch(() => false) : Promise.resolve(true),
    ]);
    const minioRequired = deps.checkMinio !== undefined;
    const ready = schema.schemaCompatible && postgresOk && (minioRequired ? minioOk : true);
    return {
      live: true,
      ready,
      schemaCompatible: schema.schemaCompatible,
      dependencies: {
        postgres: postgresOk ? "ok" : "unavailable",
        minio: minioRequired ? (minioOk ? "ok" : "unavailable") : "not_checked",
      },
    };
  };
}

/** A trivially-ready probe for flag-off/single-tenant deployments (no gate active). */
export const alwaysReadyProbe: ReadinessProbe = async () => ({
  live: true,
  ready: true,
  schemaCompatible: true,
  dependencies: { postgres: "not_checked", minio: "not_checked" },
});

/** `GET /ready` -> 200 when ready, 503 (not a crash) when not. Always answers. */
export function readinessRoutes(probe: ReadinessProbe): Router {
  const router = Router();
  router.get("/ready", async (_req, res) => {
    const snapshot = await probe();
    res.status(snapshot.ready ? 200 : 503).json(snapshot);
  });
  return router;
}

export interface ReadinessGateOptions {
  probe: ReadinessProbe;
  /** Return true for paths that must ALWAYS answer (health/liveness/readiness). */
  bypass?: (path: string) => boolean;
}

/**
 * The readiness-gate middleware. 503s protected routes until ready. Bypassed paths
 * (health/liveness/readiness) always pass. Never crashes the process — an
 * unavailable readiness probe is itself treated as not-ready (fail-closed 503).
 */
export function readinessGate(options: ReadinessGateOptions): RequestHandler {
  return async (req, res, next) => {
    if (options.bypass?.(req.path)) {
      next();
      return;
    }
    let snapshot: ReadinessSnapshot;
    try {
      snapshot = await options.probe();
    } catch {
      res.status(503).json({ error: "not_ready", ready: false, reason: "readiness_probe_failed" });
      return;
    }
    if (snapshot.ready) {
      next();
      return;
    }
    res.status(503).json({
      error: "not_ready",
      ready: false,
      schemaCompatible: snapshot.schemaCompatible,
      dependencies: snapshot.dependencies,
    });
  };
}
