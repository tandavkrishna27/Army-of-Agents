/**
 * @fileoverview Bundle-derived `company_skills` columns, shared by the two paths
 * that land a catalog skill update onto a row: the reviewed merge
 * (`skill-update-merge.ts`) and the auto-apply (`skill-auto-updater.ts`).
 *
 * A skill row's `trustLevel`, `fileInventory`, and `metadata.catalog*Bundle*`
 * pointers must describe whatever bundle tree is on disk RIGHT NOW — that is
 * what an agent executes at run time. When upstream advances, both paths have to
 * re-derive those columns identically, and in particular both have to handle the
 * three shapes the new catalog item can take. T2.8 fixed this on the merge path;
 * T2.8c(a) fixed the same gap on the auto-apply path. Extracting the resolver
 * keeps the two from drifting.
 */
import type { MarketplaceSkillBundle } from "@armyofagents/shared";
import {
  deriveBundleTrustLevel,
  type MaterializeSkillBundleResult,
} from "./skill-bundle-materializer.js";

/**
 * The bundle-derived columns to `.set(...)`, for all three shapes the upstream
 * item can take.
 *
 * - **Upstream has a bundle** (`materialized` present) → point `metadata` at the
 *   tree just written and recompute `fileInventory` / `trustLevel` from it.
 * - **Upstream has no bundle and the row never had one** → contribute nothing
 *   (`{}`). A markdown-only row must not be stamped with an empty inventory it
 *   never had, nor have its metadata touched.
 * - **Upstream has no bundle but the row DOES** → clear the pointer. This is the
 *   whole-bundle analogue of a removed file: without it the row keeps naming the
 *   old version's directory forever — agents go on receiving scripts upstream no
 *   longer publishes, and `trustLevel` goes on asserting `scripts_executables`
 *   for a bundle that no longer exists. Nothing else repairs it (the row is now
 *   `customized`, so `applySkillUpdate` never touches it again).
 *
 * @param currentMetadata the row's existing `metadata` (used to detect the
 *   had-a-bundle case, and preserved on every branch that writes metadata).
 * @param bundle the upstream item's bundle, or undefined.
 * @param materialized the result of materializing `bundle`, or null when there
 *   was no bundle to materialize.
 * @param extraMetadataOnMaterialize additional metadata keys to fold in ONLY on
 *   the has-a-bundle branch (the auto-apply path stamps `catalogProvider` here;
 *   the merge path passes nothing). Applied before the bundle pointers so it can
 *   never overwrite them.
 */
export function resolveBundleColumns(
  currentMetadata: unknown,
  bundle: MarketplaceSkillBundle | undefined,
  materialized: MaterializeSkillBundleResult | null,
  extraMetadataOnMaterialize?: Record<string, unknown>,
) {
  const metadata = asRecord(currentMetadata);
  if (materialized) {
    return {
      trustLevel: deriveBundleTrustLevel(materialized.fileInventory),
      fileInventory: materialized.fileInventory as unknown as Record<string, unknown>[],
      metadata: {
        ...metadata,
        ...extraMetadataOnMaterialize,
        catalogSkillBundle: bundle,
        catalogBundleInstallPath: materialized.destination,
      },
    };
  }

  const hadBundle =
    typeof metadata.catalogBundleInstallPath === "string" || metadata.catalogSkillBundle != null;
  if (!hadBundle) return {};

  const {
    catalogSkillBundle: _bundle,
    catalogBundleInstallPath: _installPath,
    ...rest
  } = metadata;
  return {
    trustLevel: "markdown_only" as const,
    fileInventory: [] as unknown as Record<string, unknown>[],
    metadata: rest,
  };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
