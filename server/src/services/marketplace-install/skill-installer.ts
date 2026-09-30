import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { companySkills } from "@armyofagents/db";
import type { CatalogItem, MarketplaceProviderRef } from "@armyofagents/shared";
import { loadSkillContent } from "./fetch-resource.js";
import {
  deriveBundleTrustLevel,
  managedCatalogSkillDir,
  materializeSkillBundle,
  type BundleCheckoutCache,
} from "./skill-bundle-materializer.js";

export interface InstallSkillOpts {
  catalogItem: CatalogItem;
  companyId: string;
  db: Db;
  packageContext?: InstallSkillPackageContext;
  /**
   * Optional caller deadline. Chained into the body fetch AND into the bundle
   * materializer's `git` subprocesses, so a caller that must finish inside a
   * budget (company-create's crew bootstrap) can actually stop a stalled clone
   * instead of waiting on git's own connect timeout. Absent = unbounded.
   */
  signal?: AbortSignal;
  /**
   * Optional clone cache shared across the skills of ONE install. A team's
   * bundles cluster on a handful of repos and `git clone --no-checkout` still
   * downloads the whole object database, so without this the same repo is
   * re-cloned once per skill. See {@link BundleCheckoutCache}.
   */
  checkoutCache?: BundleCheckoutCache;
}

export interface InstallSkillPackageContext {
  packageId: string;
  packageName: string;
  sourceUrl: string;
  provider?: MarketplaceProviderRef;
}

export interface InstallSkillResult {
  skillId: string;
  alreadyInstalled?: boolean;
}

/**
 * Install a skill catalog item into a company's company_skills table.
 *
 * - Uses inline content if present (faster, no network).
 * - Falls back to HTTP GET on resourceUrl (commit-pinned by aggregator).
 * - Stores sourceType=catalog, sourceLocator=catalogItemId, sourceRef=version
 *   so future updates and idempotency checks can find the row.
 *
 * Includes an idempotency guard: returns `alreadyInstalled: true` if the same
 * version is already installed; throws a clean error if a different version
 * exists (use the update flow to upgrade instead of re-installing).
 *
 * The `db` argument may be a transaction handle. The function performs a
 * single insert and is safe to call inside a parent transaction.
 *
 * @throws Error if neither inline content nor resourceUrl is present, or HTTP fetch fails.
 */
export async function installSkill(opts: InstallSkillOpts): Promise<InstallSkillResult> {
  const { catalogItem, companyId, db } = opts;

  if (catalogItem.type !== "skill") {
    throw new Error(`installSkill called with non-skill item: ${catalogItem.id} (type=${catalogItem.type})`);
  }

  const key = catalogItem.id; // catalog ID is the unique skill key

  // ── Idempotency guard ────────────────────────────────────────────────────
  // Check before inserting so callers receive a clean result instead of a
  // raw Postgres unique-constraint violation on (companyId, key).
  const existing = await db
    .select({ id: companySkills.id, sourceRef: companySkills.sourceRef })
    .from(companySkills)
    .where(and(eq(companySkills.companyId, companyId), eq(companySkills.key, key)))
    .limit(1);

  if (existing.length > 0) {
    if (existing[0].sourceRef === catalogItem.version) {
      // Same version already installed — treat as success, nothing to do.
      return { skillId: existing[0].id, alreadyInstalled: true };
    }
    throw new Error(
      `Skill ${key} is already installed at version ${existing[0].sourceRef}; ` +
      `catalog version is ${catalogItem.version}. Use the update flow to upgrade.`,
    );
  }

  const managedBundleDir = managedCatalogSkillDir(companyId, catalogItem.id, catalogItem.version);
  const materialized = catalogItem.skill?.bundle
    ? await materializeSkillBundle(catalogItem.skill.bundle, {
        destination: managedBundleDir,
        overwrite: true,
        signal: opts.signal,
        checkoutCache: opts.checkoutCache,
      })
    : null;
  const markdown = materialized?.markdown ?? await loadSkillContent(catalogItem, opts.signal);

  const slug = catalogItem.id.split("/").pop() ?? catalogItem.id;
  const fileInventory = materialized?.fileInventory ?? [];

  const inserted = await db
    .insert(companySkills)
    .values({
      companyId,
      key,
      slug,
      name: catalogItem.name,
      description: catalogItem.description,
      markdown,
      sourceType: "catalog",  // reuses existing catalog source type — marketplace is a catalog
      sourceLocator: catalogItem.id,
      sourceRef: catalogItem.version,
      // Marketplace skills are markdown-only (no file inventory). Catalog provenance
      // (verified/community/unverified) is stored in metadata.catalogTrustTier for display.
      trustLevel: materialized ? deriveBundleTrustLevel(materialized.fileInventory) : "markdown_only",
      compatibility: "compatible",
      fileInventory: fileInventory as unknown as Record<string, unknown>[],
      metadata: {
        catalogCategory: catalogItem.category,
        catalogTags: catalogItem.tags,
        catalogTrustTier: catalogItem.trust.tier,  // verified | community | unverified — for UI badge
        catalogProvider: opts.packageContext?.provider ?? catalogItem.provider ?? null,
        ...(opts.packageContext
          ? {
              packageId: opts.packageContext.packageId,
              catalogPackageId: opts.packageContext.packageId,
              catalogPackageName: opts.packageContext.packageName,
              catalogPackageSourceUrl: opts.packageContext.sourceUrl,
            }
          : {}),
        ...(catalogItem.skill?.bundle
          ? {
              catalogSkillBundle: catalogItem.skill.bundle,
              catalogBundleInstallPath: managedBundleDir,
            }
          : {}),
        installedAt: new Date().toISOString(),
      },
    })
    .returning();

  return { skillId: inserted[0].id };
}
