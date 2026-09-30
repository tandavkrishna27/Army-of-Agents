import { Router } from "express";
import type { Db } from "@armyofagents/db";
import {
  SECRET_PROVIDERS,
  type SecretProvider,
  createRuntimeProviderKeySchema,
  createSecretBindingSchema,
  createSecretProviderConfigSchema,
  createSecretSchema,
  remoteSecretImportCommitSchema,
  remoteSecretImportPreviewSchema,
  rotateSecretSchema,
  updateRuntimeProviderKeySchema,
  updateSecretProviderConfigSchema,
  updateSecretSchema,
} from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity, secretService } from "../services/index.js";
import { runtimeProviderKeyService } from "../services/runtime-provider-keys.js";
import { reindexCompany } from "../services/embeddings-backfill.js";
import { PROVIDER_SECRET_NAMES } from "../services/internal-agent/providers/index.js";
import { logger } from "../middleware/logger.js";

const secretsLog = logger.child({ service: "secrets-routes" });

export function secretRoutes(db: Db) {
  const router = Router();
  const svc = secretService(db);
  const runtimeKeysSvc = runtimeProviderKeyService(db);
  const configuredDefaultProvider = process.env.AOA_SECRETS_PROVIDER;
  const defaultProvider = (
    configuredDefaultProvider && SECRET_PROVIDERS.includes(configuredDefaultProvider as SecretProvider)
      ? configuredDefaultProvider
      : "local_encrypted"
  ) as SecretProvider;

  router.get("/companies/:companyId/secret-providers", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    res.json(svc.listProviders());
  });

  router.get("/companies/:companyId/secret-provider-configs", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    res.json(await svc.listProviderConfigs(companyId));
  });

  router.post(
    "/companies/:companyId/secret-provider-configs",
    validate(createSecretProviderConfigSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const created = await svc.createProviderConfig(companyId, req.body, {
        userId: req.actor.userId ?? "board",
        agentId: null,
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "secret_provider_config.created",
        entityType: "secret_provider_config",
        entityId: created.id,
        details: { provider: created.provider, displayName: created.displayName },
      });
      res.status(201).json(created);
    },
  );

  router.patch(
    "/secret-provider-configs/:id",
    validate(updateSecretProviderConfigSchema),
    async (req, res) => {
      assertBoard(req);
      const existing = await svc.getProviderConfigById(req.params.id as string);
      if (!existing) {
        res.status(404).json({ error: "Provider vault not found" });
        return;
      }
      await assertCompanyAccess(db, req, existing.companyId);
      const updated = await svc.updateProviderConfig(existing.id, req.body);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "secret_provider_config.updated",
        entityType: "secret_provider_config",
        entityId: existing.id,
        details: { provider: existing.provider },
      });
      res.json(updated);
    },
  );

  router.delete("/secret-provider-configs/:id", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getProviderConfigById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    const deleted = await svc.deleteProviderConfig(existing.id);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret_provider_config.deleted",
      entityType: "secret_provider_config",
      entityId: existing.id,
      details: { provider: existing.provider },
    });
    res.json(deleted ?? { ok: true });
  });

  router.post("/secret-provider-configs/:id/check", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getProviderConfigById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    const result = await svc.checkProviderConfig(existing.id);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret_provider_config.checked",
      entityType: "secret_provider_config",
      entityId: existing.id,
      details: { provider: existing.provider, status: result.status },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/secrets", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const secrets = await svc.list(companyId);
    res.json(secrets);
  });

  router.get("/companies/:companyId/runtime-provider-keys", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    res.json(await runtimeKeysSvc.list(companyId));
  });

  router.post(
    "/companies/:companyId/runtime-provider-keys",
    validate(createRuntimeProviderKeySchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const created = await runtimeKeysSvc.create(companyId, req.body);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "runtime_provider_key.created",
        entityType: "runtime_provider_key",
        entityId: created.id,
        details: { provider: created.provider, displayName: created.displayName, isDefault: created.isDefault },
      });
      res.status(201).json(created);
    },
  );

  router.patch("/runtime-provider-keys/:id", validate(updateRuntimeProviderKeySchema), async (req, res) => {
    assertBoard(req);
    const existing = await runtimeKeysSvc.getById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Provider key not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    const updated = await runtimeKeysSvc.update(existing.id, req.body);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "runtime_provider_key.updated",
      entityType: "runtime_provider_key",
      entityId: existing.id,
      details: { provider: existing.provider, changedFields: Object.keys(req.body).sort() },
    });
    res.json(updated);
  });

  router.delete("/runtime-provider-keys/:id", async (req, res) => {
    assertBoard(req);
    const existing = await runtimeKeysSvc.getById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Provider key not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    await runtimeKeysSvc.remove(existing.id);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "runtime_provider_key.deleted",
      entityType: "runtime_provider_key",
      entityId: existing.id,
      details: { provider: existing.provider },
    });
    res.json({ ok: true });
  });

  router.post("/companies/:companyId/secrets", validate(createSecretSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);

    const created = await svc.create(
      companyId,
      {
        name: req.body.name,
        key: req.body.key,
        provider: req.body.provider ?? defaultProvider,
        providerConfigId: req.body.providerConfigId,
        managedMode: req.body.managedMode,
        value: req.body.value,
        description: req.body.description,
        externalRef: req.body.externalRef,
        providerVersionRef: req.body.providerVersionRef,
      },
      { userId: req.actor.userId ?? "board", agentId: null },
    );

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.created",
      entityType: "secret",
      entityId: created.id,
      details: { name: created.name, provider: created.provider },
    });

    // When the OpenAI embedding key is added, drain the backlog best-effort.
    // Compare against the secret NAME (P2, Codex): the UI sends name="llm:openai"
    // while secretService normalizes `created.key` to "LLM_OPENAI", so the old
    // `created.key === "llm:openai"` check never matched and reindex never fired.
    // Reuse the same name set the provider resolver uses so they stay in sync.
    if (PROVIDER_SECRET_NAMES.openai?.includes(created.name)) {
      void reindexCompany(db, companyId).catch((err: unknown) =>
        secretsLog.warn({ err, companyId }, "reindexCompany after secret.created: non-fatal"),
      );
    }

    res.status(201).json(created);
  });

  router.post("/secrets/:id/rotate", validate(rotateSecretSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);

    const rotated = await svc.rotate(
      id,
      {
        value: req.body.value,
        externalRef: req.body.externalRef,
        providerConfigId: req.body.providerConfigId,
        providerVersionRef: req.body.providerVersionRef,
      },
      { userId: req.actor.userId ?? "board", agentId: null },
    );

    await logActivity(db, {
      companyId: rotated.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.rotated",
      entityType: "secret",
      entityId: rotated.id,
      details: { version: rotated.latestVersion },
    });

    // When the OpenAI embedding key is rotated, drain the backlog best-effort
    // (a rotation may have unblocked stalled pending rows if the old key was
    // invalid). Match on the secret NAME, not the normalized `.key` (P2, Codex).
    if (PROVIDER_SECRET_NAMES.openai?.includes(existing.name)) {
      void reindexCompany(db, rotated.companyId).catch((err: unknown) =>
        secretsLog.warn({ err, companyId: rotated.companyId }, "reindexCompany after secret.rotated: non-fatal"),
      );
    }

    res.json(rotated);
  });

  router.patch("/secrets/:id", validate(updateSecretSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);

    const updated = await svc.update(id, {
      name: req.body.name,
      key: req.body.key,
      description: req.body.description,
      externalRef: req.body.externalRef,
      status: req.body.status,
    });

    if (!updated) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.updated",
      entityType: "secret",
      entityId: updated.id,
      details: { name: updated.name },
    });

    res.json(updated);
  });

  router.delete("/secrets/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);

    const removed = await svc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.deleted",
      entityType: "secret",
      entityId: removed.id,
      details: { name: removed.name },
    });

    res.json({ ok: true });
  });

  router.get("/secrets/:id/bindings", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    res.json(await svc.listBindingsForSecret(existing.companyId, existing.id));
  });

  router.post("/secrets/:id/bindings", validate(createSecretBindingSchema.omit({ secretId: true })), async (req, res) => {
    assertBoard(req);
    const existing = await svc.getById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    const created = await svc.createBinding({
      companyId: existing.companyId,
      secretId: existing.id,
      targetType: req.body.targetType,
      targetId: req.body.targetId,
      configPath: req.body.configPath,
      versionSelector: req.body.versionSelector,
      required: req.body.required,
      label: req.body.label,
    });
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret_binding.created",
      entityType: "secret_binding",
      entityId: created.id,
      details: { secretId: existing.id, targetType: created.targetType, configPath: created.configPath },
    });
    res.status(201).json(created);
  });

  router.delete("/secret-bindings/:id", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getBindingById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Secret binding not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    const deleted = await svc.deleteBinding(existing.id);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret_binding.deleted",
      entityType: "secret_binding",
      entityId: existing.id,
      details: { secretId: existing.secretId, targetType: existing.targetType, configPath: existing.configPath },
    });
    res.json(deleted ?? { ok: true });
  });

  router.get("/secrets/:id/access-events", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    res.json(await svc.listAccessEvents(existing.companyId, existing.id));
  });

  router.post(
    "/companies/:companyId/secrets/remote-import/preview",
    validate(remoteSecretImportPreviewSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      res.json(await svc.previewRemoteImport(companyId, req.body));
    },
  );

  router.post(
    "/companies/:companyId/secrets/remote-import",
    validate(remoteSecretImportCommitSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const result = await svc.importRemoteSecrets(companyId, req.body, {
        userId: req.actor.userId ?? "board",
        agentId: null,
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "secret.remote_imported",
        entityType: "secret",
        entityId: companyId,
        details: { count: result.results.filter((row) => row.status === "imported").length },
      });
      res.status(201).json(result);
    },
  );

  return router;
}
