import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { plugins } from "@armyofagents/db";
import type { CatalogItem } from "@armyofagents/shared";
import {
  assertCloudPluginExecutionAllowed,
  isCloudPluginExecutionBlocked,
} from "../cloud-plugin-execution.js";

/**
 * Subset of the real plugin runtime services the marketplace wrapper needs.
 * Real types live in server/src/services/plugin-loader.ts (DiscoveredPlugin),
 * server/src/services/plugin-registry.ts, and server/src/services/plugin-lifecycle.ts.
 */
export interface PluginLoaderLike {
  installPlugin(opts: {
    packageName?: string;
    version?: string;
    localPath?: string;
    companyId: string;
    catalogItemId?: string;
    /**
     * Optional catalog-declared SRI integrity hash. When set, the loader
     * verifies the installed package's integrity (from package-lock.json)
     * matches and fail-closes via `IntegrityMismatchError` on mismatch.
     */
    catalogIntegrity?: string;
  }): Promise<{
    packagePath: string;
    packageName: string;
    version: string;
    source: string;
    manifest: { id: string; [key: string]: unknown } | null;
  }>;
  registry: {
    getByKeyScoped(pluginKey: string, companyId: string): Promise<{ id: string; pluginKey: string } | null>;
  };
  lifecycle: {
    load(pluginId: string): Promise<void>;
    blockActivationInCloud(pluginId: string, source?: "marketplace"): Promise<void>;
  };
}

export interface InstallMarketplacePluginOpts {
  catalogItem: CatalogItem;
  companyId: string;
  db: Db;
  pluginLoader: PluginLoaderLike;
}

export interface InstallMarketplacePluginResult {
  pluginId: string;
  alreadyInstalled: boolean;
}

/**
 * Marketplace wrapper around pluginLoader.installPlugin() + lifecycle.load().
 *
 * Mirrors the existing pattern in routes/plugins.ts:638-667:
 *   1. Idempotency check: if a plugin row exists at same companyId+version, return early.
 *   2. installPlugin → discovered (downloads npm package, validates manifest,
 *      writes plugins row in 'installed' state).
 *   3. registry.getByKeyScoped(discovered.manifest.id, companyId) → existing plugin row.
 *   4. lifecycle.load(existingPlugin.id) → transitions 'installed' → 'ready'.
 *
 * @throws Error if catalogItem.npm missing, manifest missing, or any step fails.
 */
export async function installMarketplacePlugin(
  opts: InstallMarketplacePluginOpts,
): Promise<InstallMarketplacePluginResult> {
  const { catalogItem, companyId, db, pluginLoader } = opts;

  if (catalogItem.type !== "plugin") {
    throw new Error(`installMarketplacePlugin called with non-plugin: ${catalogItem.id}`);
  }
  if (!catalogItem.npm) {
    throw new Error(`Plugin ${catalogItem.id} missing npm field — aggregator must populate npm.{packageName,version}`);
  }

  // 1. Idempotency check (matches resolver classification at resolver.ts:95-111).
  // Scoped by companyId so two companies can independently install the same package.
  // If the catalog version differs from the installed version, fail-fast (V1 has no
  // upgrade flow; M.4 will add it).
  const existing = await db
    .select()
    .from(plugins)
    .where(
      and(
        eq(plugins.companyId, companyId),
        eq(plugins.packageName, catalogItem.npm.packageName),
      ),
    )
    .limit(1);

  // RW5a: "loader" is the install ENTRY boundary (download/write files) and
  // stays allowed on cloud — the executable manifest import that
  // `pluginLoader.installPlugin` eventually reaches internally is gated
  // separately by the "loader-import" sink, which stays blocked on cloud in
  // the control plane. This block is therefore inert on cloud today; it is
  // kept so a future sink reclassification (or an off-cloud caller) still
  // gets the reconcile-then-deny behavior for free.
  if (isCloudPluginExecutionBlocked("loader")) {
    // A persisted, non-uninstalled row can safely be reconciled from stored
    // manifest JSON. This writes the durable reason before denying. New and
    // soft-uninstalled packages are denied without package I/O or JS import.
    if (existing[0] && existing[0].status !== "uninstalled") {
      await pluginLoader.lifecycle.blockActivationInCloud(
        existing[0].id,
        "marketplace",
      );
    }
    assertCloudPluginExecutionAllowed({
      pluginId: catalogItem.id,
      companyId,
      source: "marketplace",
      sink: "loader",
    });
  }

  if (existing.length > 0) {
    if (
      existing[0].status !== "uninstalled" &&
      existing[0].version === catalogItem.npm.version
    ) {
      return { pluginId: existing[0].id, alreadyInstalled: true };
    }
    if (existing[0].status !== "uninstalled") throw new Error(
      `Plugin ${catalogItem.npm.packageName} installed at version ${existing[0].version} for company ${companyId}; ` +
      `catalog requests ${catalogItem.npm.version}. Use the upgrade flow to upgrade.`,
    );
  }

  // 2. Delegate to existing pipeline (returns DiscoveredPlugin).
  // When a tarball URL is present, pass it as packageName (no version) so
  // npm install resolves the exact artifact — standard npm tarball-URL install.
  // Forward the catalog-declared integrity (if any) so the loader can verify
  // the resolved package matches what the AoA marketplace published; the
  // verification step is opt-in per catalog item for backward compat.
  const baseOpts = catalogItem.npm.tarballUrl
    ? { packageName: catalogItem.npm.tarballUrl, companyId, catalogItemId: catalogItem.id }
    : {
        packageName: catalogItem.npm.packageName,
        version: catalogItem.npm.version,
        companyId,
        catalogItemId: catalogItem.id,
      };
  const installOpts = catalogItem.npm.integrity
    ? { ...baseOpts, catalogIntegrity: catalogItem.npm.integrity }
    : baseOpts;

  const discovered = await pluginLoader.installPlugin(installOpts);

  if (!discovered.manifest) {
    throw new Error(`Plugin installed but manifest is missing for ${catalogItem.id}`);
  }

  // 3. Look up the row that installPlugin just registered (scoped to this company)
  const existingPlugin = await pluginLoader.registry.getByKeyScoped(
    discovered.manifest.id,
    companyId,
  );
  if (!existingPlugin) {
    throw new Error(`Plugin installed but not found in registry: pluginKey=${discovered.manifest.id}`);
  }

  // 4. Transition to ready state
  await pluginLoader.lifecycle.load(existingPlugin.id);

  return { pluginId: existingPlugin.id, alreadyInstalled: false };
}
