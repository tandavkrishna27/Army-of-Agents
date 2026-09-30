import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import {
  createEnvironmentSchema,
  probeEnvironmentSchema,
  updateEnvironmentSchema,
} from "@armyofagents/shared";
import {
  getLocalProbeTargetPath,
  probeEnvironmentConfig,
} from "../services/environment-probe.js";
import { environmentService, type EnvironmentService } from "../services/environments.js";
import { logActivity } from "../services/index.js";
import { secretService } from "../services/secrets.js";
import { runtimeProviderKeyService } from "../services/runtime-provider-keys.js";
import {
  assertBoard,
  assertCanManageInstanceSettings,
  assertCompanyAccess,
  getActorInfo,
} from "./authz.js";
import { getDeploymentMode } from "../config/deployment-mode.js";
import { assertEnvironmentRuntimeSupportedForDeployment } from "../services/cloud-environment-policy.js";

interface RoutesOptions {
  // Test seam: callers can inject a pre-built service. Production uses `db`.
  db?: Db;
  svc?: EnvironmentService;
}

export function environmentRoutes(opts: RoutesOptions) {
  const router = Router();
  const db = opts.db!;
  const svc = opts.svc ?? environmentService(opts.db!);
  const secretsSvc = opts.db ? secretService(opts.db) : null;
  const runtimeKeysSvc = opts.db ? runtimeProviderKeyService(opts.db) : null;

  async function runEnvironmentMutation<T>(
    operation: (services: {
      envSvc: EnvironmentService;
      secretsSvc: ReturnType<typeof secretService> | null;
    }) => Promise<T>,
  ): Promise<T> {
    if (opts.db && !opts.svc && typeof opts.db.transaction === "function") {
      return opts.db.transaction(async (tx) =>
        operation({
          envSvc: environmentService(tx as unknown as Db),
          secretsSvc: secretService(tx as unknown as Db),
        }),
      );
    }

    return operation({ envSvc: svc, secretsSvc });
  }

  function getEnvVarKeys(envVars: unknown): string[] {
    if (!envVars || typeof envVars !== "object" || Array.isArray(envVars)) return [];
    return Object.keys(envVars).sort();
  }

  function countSecretBindings(envVars: unknown): number {
    if (!envVars || typeof envVars !== "object" || Array.isArray(envVars)) return 0;
    return Object.values(envVars).filter((value) =>
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as { type?: unknown }).type === "secret_ref"
    ).length;
  }

  function getTargetType(target: unknown): string | null {
    if (!target || typeof target !== "object" || Array.isArray(target)) return null;
    const type = (target as { type?: unknown }).type;
    return typeof type === "string" ? type : null;
  }

  async function logEnvironmentActivity(
    req: Request,
    input: {
      companyId: string;
      action: "environment.created" | "environment.updated" | "environment.deleted";
      entityId: string;
      name: string;
      target: unknown;
      envVars: unknown;
      changedFields?: string[];
    },
  ): Promise<void> {
    if (!opts.db) return;
    const actor = getActorInfo(req);
    await logActivity(opts.db, {
      companyId: input.companyId,
      ...actor,
      action: input.action,
      entityType: "environment",
      entityId: input.entityId,
      details: {
        name: input.name,
        targetType: getTargetType(input.target),
        ...(input.changedFields ? { changedFields: input.changedFields } : {}),
        envVarKeys: getEnvVarKeys(input.envVars),
        secretBindingCount: countSecretBindings(input.envVars),
      },
    });
  }

  // POST probe unsaved environment config
  router.post(
    "/companies/:companyId/environments/probe",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertBoard(req);
        await assertCompanyAccess(db, req, companyId);
        const parsed = probeEnvironmentSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }
        assertEnvironmentRuntimeSupportedForDeployment(getDeploymentMode(), parsed.data);
        if (
          parsed.data.driver === "local" &&
          getLocalProbeTargetPath(parsed.data.config) !== null
        ) {
          assertCanManageInstanceSettings(req);
        }

        const result = await probeEnvironmentConfig({
          companyId,
          driver: parsed.data.driver,
          config: parsed.data.config,
          ...(runtimeKeysSvc ? { runtimeProviderKeys: runtimeKeysSvc } : {}),
        });
        res.status(result.ok ? 200 : 422).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET list
  router.get(
    "/companies/:companyId/environments",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertBoard(req);
        await assertCompanyAccess(db, req, companyId);
        const list = await svc.list(companyId);
        res.json(list);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET detail
  router.get(
    "/companies/:companyId/environments/:id",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        assertBoard(req);
        await assertCompanyAccess(db, req, companyId);
        const env = await svc.get(companyId, id);
        if (!env) {
          res.status(404).json({ error: "Environment not found" });
          return;
        }
        res.json(env);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST create
  router.post(
    "/companies/:companyId/environments",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertBoard(req);
        await assertCompanyAccess(db, req, companyId);
        const parsed = createEnvironmentSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }
        assertEnvironmentRuntimeSupportedForDeployment(getDeploymentMode(), parsed.data);
        const normalizedEnvVars = secretsSvc
          ? await secretsSvc.normalizeEnvConfigForPersistence(companyId, parsed.data.envVars, { strictMode: true })
          : parsed.data.envVars;
        const input = { ...parsed.data, envVars: normalizedEnvVars };
        const created = await runEnvironmentMutation(async ({ envSvc, secretsSvc: txSecretsSvc }) => {
          const env = await envSvc.create(companyId, input);
          if (txSecretsSvc) {
            await txSecretsSvc.syncEnvBindingsForTarget(companyId, {
              targetType: "environment",
              targetId: env!.id,
              pathPrefix: "env",
            }, normalizedEnvVars ?? {});
          }
          return env;
        });
        await logEnvironmentActivity(req, {
          companyId,
          action: "environment.created",
          entityId: created!.id,
          name: created!.name,
          target: created!.target,
          envVars: normalizedEnvVars ?? {},
        });
        res.status(201).json(created);
      } catch (err) {
        next(err);
      }
    },
  );

  // PATCH update
  router.patch(
    "/companies/:companyId/environments/:id",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        assertBoard(req);
        await assertCompanyAccess(db, req, companyId);
        const parsed = updateEnvironmentSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }
        const normalizedEnvVars = secretsSvc && parsed.data.envVars !== undefined
          ? await secretsSvc.normalizeEnvConfigForPersistence(companyId, parsed.data.envVars, { strictMode: true })
          : parsed.data.envVars;
        const input = parsed.data.envVars === undefined
          ? parsed.data
          : { ...parsed.data, envVars: normalizedEnvVars };
        const updated = await runEnvironmentMutation(async ({ envSvc, secretsSvc: txSecretsSvc }) => {
          if (getDeploymentMode() === "cloud_auth") {
            const existing = await envSvc.get(companyId, id);
            if (!existing) return null;
            assertEnvironmentRuntimeSupportedForDeployment(getDeploymentMode(), {
              driver: input.driver ?? existing.driver,
              config: input.config ?? existing.config,
              target: Object.prototype.hasOwnProperty.call(input, "target") ? input.target : existing.target,
              executionTargetId: Object.prototype.hasOwnProperty.call(input, "executionTargetId")
                ? input.executionTargetId
                : existing.executionTargetId,
            });
          }
          const env = await envSvc.update(companyId, id, input);
          if (env && txSecretsSvc && parsed.data.envVars !== undefined) {
            await txSecretsSvc.syncEnvBindingsForTarget(companyId, {
              targetType: "environment",
              targetId: env.id,
              pathPrefix: "env",
            }, normalizedEnvVars ?? {});
          }
          return env;
        });
        if (!updated) {
          res.status(404).json({ error: "Environment not found" });
          return;
        }
        await logEnvironmentActivity(req, {
          companyId,
          action: "environment.updated",
          entityId: updated.id,
          name: updated.name,
          target: updated.target,
          envVars: parsed.data.envVars === undefined ? updated.envVars : normalizedEnvVars ?? {},
          changedFields: Object.keys(parsed.data).sort(),
        });
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE
  router.delete(
    "/companies/:companyId/environments/:id",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        assertBoard(req);
        await assertCompanyAccess(db, req, companyId);
        const deleted = await runEnvironmentMutation(async ({ envSvc, secretsSvc: txSecretsSvc }) => {
          const env = await envSvc.delete(companyId, id);
          if (env && txSecretsSvc) {
            await txSecretsSvc.syncEnvBindingsForTarget(companyId, {
              targetType: "environment",
              targetId: id,
              pathPrefix: "env",
            }, {});
          }
          return env;
        });
        if (!deleted) {
          res.status(404).json({ error: "Environment not found" });
          return;
        }
        await logEnvironmentActivity(req, {
          companyId,
          action: "environment.deleted",
          entityId: deleted.id,
          name: deleted.name,
          target: deleted.target,
          envVars: deleted.envVars,
        });
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
