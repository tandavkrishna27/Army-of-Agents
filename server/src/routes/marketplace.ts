/**
 * @fileoverview Marketplace catalog REST API routes
 *
 * - GET /api/marketplace/catalog        — return latest cached catalog
 * - POST /api/marketplace/catalog/sync  — trigger manual sync (founder only)
 * - GET /api/marketplace/catalog/status — sync metadata (last sync, source, version)
 */

import { Router } from "express";
import type { MarketplaceCatalogService } from "../services/aoa-marketplace.js";
import { assertBoard, assertCanManageInstanceSettings } from "./authz.js";

export interface MarketplaceRoutesDeps {
  service: MarketplaceCatalogService;
}

export function createMarketplaceRouter(deps: MarketplaceRoutesDeps): Router {
  const { service } = deps;
  const router = Router();

  router.get("/catalog", async (req, res) => {
    assertBoard(req);
    const catalog = await service.readCache();
    if (!catalog) {
      res.status(503).json({ error: "Catalog not yet synced" });
      return;
    }
    res.json(catalog);
  });

  router.post("/catalog/sync", async (req, res) => {
    assertBoard(req);
    assertCanManageInstanceSettings(req);
    const { catalog, status } = await service.refreshAndCheckForUpdates();
    if (!catalog || status?.lastSyncStatus !== "success") {
      res.status(502).json({ error: "Sync failed", status });
      return;
    }
    res.json({ status, itemCount: catalog.itemCount });
  });

  router.get("/catalog/status", async (req, res) => {
    assertBoard(req);
    const status = await service.getStatus();
    if (!status) {
      res.status(404).json({ error: "No catalog cached yet" });
      return;
    }
    res.json(status);
  });

  router.get("/packages", async (req, res) => {
    assertBoard(req);
    const packages = await service.getPackages();
    if (!packages) {
      res.status(503).json({ error: "Catalog not yet synced" });
      return;
    }
    res.json({ packages });
  });

  return router;
}
