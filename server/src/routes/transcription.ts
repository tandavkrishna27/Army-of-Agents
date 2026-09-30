import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { transcribeLimiter } from "../middleware/rate-limit.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * Transcription is deprecated as a server-side OpenAI path per Decision #91
 * (CLI-only execution; transcription will move to a Commander sub-agent task).
 * The route stays mounted with the rate limiter intact (prevents flooding the
 * 501 itself) and the original method+path so existing UI clients can detect
 * the deprecation and degrade gracefully.
 */
export function transcriptionRoutes(db: Db) {
  const router = Router();

  router.post(
    "/companies/:companyId/transcribe",
    transcribeLimiter,
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      res.status(501).json({
        error: "transcription_not_available",
        message:
          "Voice transcription will be added via the Internal Agent. " +
          "See Decision #91 (CLI-only execution).",
      });
    },
  );

  return router;
}
