import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { previewProxyLimiter } from "../middleware/rate-limit.js";
import { proxyPreviewHttp } from "../services/preview-proxy.js";

export function createPreviewRouter(db: Db) {
  const router = Router();

  router.use("/services/:serviceId", previewProxyLimiter, async (req, res) => {
    const serviceId = req.params.serviceId;
    if (typeof serviceId !== "string" || serviceId.length === 0) {
      res.status(400).json({ error: "Preview service id is required" });
      return;
    }
    await proxyPreviewHttp(db, req, res, serviceId);
  });

  router.use((_req, res) => {
    res.status(404).json({ error: "Preview route not found" });
  });

  return router;
}
