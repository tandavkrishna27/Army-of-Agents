import { Router } from "express";
import type { Db } from "@armyofagents/db";
import {
  listStarterTemplates,
  applyStarterTemplate,
} from "../services/memory-starter-templates.js";
import { assertCompanyAccess } from "./authz.js";
import { notFound } from "../errors.js";

export function memoryStarterTemplatesRoutes(db: Db) {
  const router = Router();

  // ── List all templates ──────────────────────────────────────────────────
  // GET /companies/:companyId/memory/starter-templates
  // Returns all 11 templates with their items (small static payload).
  // No DB needed — data is static code.
  router.get("/companies/:companyId/memory/starter-templates", async (req, res) => {
    await assertCompanyAccess(db, req, req.params.companyId as string);
    res.json(listStarterTemplates());
  });

  // ── Apply a template ────────────────────────────────────────────────────
  // POST /companies/:companyId/memory/starter-templates/:templateId/apply
  // Body: { departmentId?: string }
  // Founder-only (RBAC-gated by canEditIdentityMemory equivalent on the
  // frontend; here we rely on company access + source="template" pattern).
  router.post(
    "/companies/:companyId/memory/starter-templates/:templateId/apply",
    async (req, res) => {
      const { companyId, templateId } = req.params as {
        companyId: string;
        templateId: string;
      };
      await assertCompanyAccess(db, req, companyId);

      const departmentId =
        typeof req.body?.departmentId === "string" && req.body.departmentId.trim()
          ? req.body.departmentId.trim()
          : null;

      try {
        const result = await applyStarterTemplate(db, companyId, templateId, {
          departmentId,
        });
        res.json(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Unknown starter template")) {
          throw notFound(err.message);
        }
        throw err;
      }
    },
  );

  return router;
}
