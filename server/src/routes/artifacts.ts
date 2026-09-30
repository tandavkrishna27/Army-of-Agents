import { Router } from "express";
import type { Db } from "@armyofagents/db";
import {
  createArtifactSchema,
  updateArtifactSchema,
  createArtifactVersionSchema,
  mcpArtifactVersionSchema,
} from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { artifactService, companyService, logActivity, permissionService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { assertRole } from "../middleware/rbac.js";
import { registerIssueParamNormalizer } from "./issue-param-normalizer.js";
import { forbidden } from "../errors.js";

export function artifactRoutes(db: Db) {
  const router = Router();
  const svc = artifactService(db);
  registerIssueParamNormalizer(router, db, ["issueId"]);

  async function assertFounderMcpPublisher(req: Parameters<typeof assertBoard>[0], companyId: string) {
    if (req.actor.type === "mcp") {
      if (!req.actor.userId) {
        throw forbidden("Founder authority required");
      }
      const company = await companyService(db).getById(companyId);
      if (!company) {
        throw forbidden("Company not found");
      }
      if (!company.mcpEnabled) {
        throw forbidden("MCP server is disabled for this company");
      }
      const role = await permissionService(db).getEffectiveRole(companyId, req.actor.userId);
      if (role !== "founder") {
        throw forbidden("Founder authority required");
      }
      return;
    }
    assertBoard(req);
    await assertRole(db, req, companyId, "founder");
  }

  // List artifacts for a company
  router.get("/companies/:companyId/artifacts", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const includeArchived = req.query.includeArchived === "true";
    const result = await svc.list(companyId, { includeArchived });
    res.json(result);
  });

  // Get artifact with versions
  router.get("/artifacts/:id", async (req, res) => {
    const id = req.params.id as string;
    const artifact = await svc.getById(id);
    if (!artifact) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
    await assertCompanyAccess(db, req, artifact.companyId);
    res.json(artifact);
  });

  // Create artifact (optionally with initial version)
  router.post(
    "/companies/:companyId/artifacts",
    validate(createArtifactSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);

      const actor = getActorInfo(req);
      const artifact = await svc.create(companyId, actor.actorId, req.body);

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "artifact.created",
        entityType: "artifact",
        entityId: artifact.id,
        details: { title: artifact.title, type: artifact.type },
      });

      res.status(201).json(artifact);
    },
  );

  // Update artifact metadata
  router.patch(
    "/artifacts/:id",
    validate(updateArtifactSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Artifact not found" });
        return;
      }
      await assertCompanyAccess(db, req, existing.companyId);

      const artifact = await svc.update(id, req.body);
      if (!artifact) {
        res.status(404).json({ error: "Artifact not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: artifact.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "artifact.updated",
        entityType: "artifact",
        entityId: artifact.id,
        details: req.body,
      });

      res.json(artifact);
    },
  );

  // Add immutable version to artifact
  router.post(
    "/artifacts/:id/versions",
    validate(createArtifactVersionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Artifact not found" });
        return;
      }
      await assertCompanyAccess(db, req, existing.companyId);
      assertBoard(req);
      await assertRole(db, req, existing.companyId, "founder");

      const version = await svc.addVersion(id, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "artifact.version_added",
        entityType: "artifact",
        entityId: existing.id,
        details: {
          versionId: version.id,
          versionNumber: version.versionNumber,
          source: version.source,
        },
      });

      res.status(201).json(version);
    },
  );

  // Archive artifact (founder-gated, reversible)
  router.post("/artifacts/:id/archive", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    assertBoard(req);
    await assertRole(db, req, existing.companyId, "founder");

    const updated = await svc.archive(id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId, actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "artifact.archived", entityType: "artifact", entityId: id,
      details: { title: existing.title },
    });
    res.json(updated);
  });

  // Unarchive artifact (founder-gated)
  router.post("/artifacts/:id/unarchive", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    assertBoard(req);
    await assertRole(db, req, existing.companyId, "founder");

    const updated = await svc.unarchive(id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId, actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "artifact.unarchived", entityType: "artifact", entityId: id,
      details: { title: existing.title },
    });
    res.json(updated);
  });

  // MCP inbound: push artifact version from external tool (Decision #69, #70)
  router.post(
    "/mcp/artifacts/:id/versions",
    validate(mcpArtifactVersionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Artifact not found" });
        return;
      }
      await assertCompanyAccess(db, req, existing.companyId);
      await assertFounderMcpPublisher(req, existing.companyId);

      const {
        sourceDetail,
        changelog,
        parentVersionId,
        content,
        fileUrl,
        storageKind,
        assetId,
        filename,
        contentType,
        extension,
        byteSize,
        sha256,
      } = req.body;

      const version = await svc.addVersion(id, {
        source: "mcp",
        sourceDetail,
        changelog: changelog ?? null,
        parentVersionId: parentVersionId ?? null,
        content: content ?? null,
        fileUrl: fileUrl ?? null,
        storageKind: storageKind ?? "inline",
        assetId: assetId ?? null,
        filename: filename ?? null,
        contentType: contentType ?? null,
        extension: extension ?? null,
        byteSize: byteSize ?? null,
        sha256: sha256 ?? null,
      });

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "artifact.version_added",
        entityType: "artifact",
        entityId: existing.id,
        details: {
          versionId: version.id,
          versionNumber: version.versionNumber,
          source: "mcp",
          sourceDetail,
        },
      });

      res.status(201).json(version);
    },
  );

  // Get artifact linked to a task
  router.get("/issues/:issueId/artifacts", async (req, res) => {
    const issueId = req.params.issueId as string;
    const issueInfo = await svc.getIssueCompanyId(issueId);
    if (!issueInfo) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    await assertCompanyAccess(db, req, issueInfo.companyId);
    const artifact = await svc.getByIssueId(issueId);
    res.json(artifact);
  });

  return router;
}
