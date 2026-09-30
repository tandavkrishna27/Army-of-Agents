import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { memoryService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";
import { loadOwnedConversation } from "./conversation-authz.js";

/**
 * Read-only API for memory_retrievals audit rows.
 *
 * Powers the workspace right-panel MemorySection so founders can see
 * exactly what memory each agent run actually queried + got back.
 *
 * Phase 7 — also powers the Commander cockpit Memory card:
 *
 *   GET /companies/:companyId/issues/:issueId/memory-retrievals?limit=N
 *     Returns retrievals for a single task (across all its heartbeat
 *     runs), newest first, joined with memory_items title/category/
 *     layer. Default limit 100, hard cap 500.
 *
 *   GET /companies/:companyId/conversations/:conversationId/memory-retrievals?limit=N
 *     Returns retrievals linked to a Commander conversation
 *     (triggeredBy:"commander_query", conversationId set via [A3] fix).
 *     Same shape as the issue route; newest first.
 *
 * RBAC:
 *   - Issue endpoint: assertCompanyAccess only — tasks are company resources,
 *     so any actor with company membership can read retrieval rows for a task.
 *   - Conversation endpoint: assertCompanyAccess + loadOwnedConversation —
 *     conversations are per-user resources, so only the owner or a
 *     founder-equivalent (local_implicit board, instance admin, founder role)
 *     may read retrieval rows. Returns 404 on mismatch (no existence leak).
 */
export function memoryRetrievalsRoutes(db: Db) {
  const router = Router();
  const svc = memoryService(db);

  router.get("/companies/:companyId/issues/:issueId/memory-retrievals", async (req, res) => {
    const companyId = req.params.companyId as string;
    const issueId = req.params.issueId as string;
    await assertCompanyAccess(db, req, companyId);

    const limitRaw = req.query.limit as string | undefined;
    const limit = limitRaw ? Math.max(1, parseInt(limitRaw, 10) || 0) : undefined;

    const rows = await svc.listRetrievalsForIssue(companyId, issueId, { limit });
    res.json(rows);
  });

  // Phase 7: Commander conversation retrieval audit for the Memory cockpit card.
  router.get("/companies/:companyId/conversations/:conversationId/memory-retrievals", async (req, res) => {
    const companyId = req.params.companyId as string;
    const conversationId = req.params.conversationId as string;
    await assertCompanyAccess(db, req, companyId);

    // Per-user conversation: enforce owner/founder access (not just company
    // membership) — mirrors the /internal-agent/conversations/:id/messages guard.
    // Throws 404 on mismatch (no existence leak). The issue endpoint stays
    // company-scoped: tasks are company resources, not per-user.
    await loadOwnedConversation(db, req, companyId, conversationId);

    const limitRaw = req.query.limit as string | undefined;
    const limit = limitRaw ? Math.max(1, parseInt(limitRaw, 10) || 0) : undefined;

    const rows = await svc.listRetrievalsForConversation(companyId, conversationId, { limit });
    res.json(rows);
  });

  return router;
}
