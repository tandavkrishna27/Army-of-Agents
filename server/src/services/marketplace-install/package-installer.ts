import type { CascadeStepResult, Db } from "@armyofagents/db";
import type { MarketplaceCatalogItem, MarketplacePackage } from "@armyofagents/shared";
import type { InstallSkillOpts, InstallSkillResult } from "./skill-installer.js";

export class PackageInstallError extends Error {
  cascadeResults: CascadeStepResult[];

  constructor(message: string, cascadeResults: CascadeStepResult[]) {
    super(message);
    this.name = "PackageInstallError";
    this.cascadeResults = cascadeResults;
  }
}

export interface InstallSkillPackageOpts {
  pkg: MarketplacePackage;
  memberItems: MarketplaceCatalogItem[];
  companyId: string;
  db: Db;
  installSkill: (opts: InstallSkillOpts) => Promise<InstallSkillResult>;
}

export interface InstallSkillPackageResult {
  installedSkillIds: string[];
  cascadeResults: CascadeStepResult[];
}

export async function installSkillPackage(
  opts: InstallSkillPackageOpts,
): Promise<InstallSkillPackageResult> {
  const { pkg, memberItems, companyId, db, installSkill } = opts;
  const nonSkill = memberItems.find((item) => item.type !== "skill");
  if (nonSkill) {
    throw new Error("Install all supports skill-only packages in this version");
  }

  const expectedIds = [...pkg.memberItemIds].sort();
  const actualIds = memberItems.map((item) => item.id).sort();
  if (expectedIds.join("\n") !== actualIds.join("\n")) {
    throw new Error(`Package member mismatch for ${pkg.id}`);
  }

  const installedSkillIds: string[] = [];
  const cascadeResults: CascadeStepResult[] = [];

  for (const item of memberItems) {
    const started = Date.now();
    try {
      const result = await installSkill({
        catalogItem: item,
        companyId,
        db,
        packageContext: {
          packageId: pkg.id,
          packageName: pkg.name,
          sourceUrl: pkg.sourceUrl,
          provider: pkg.provider,
        },
      });
      installedSkillIds.push(result.skillId);
      cascadeResults.push({
        step: "package-member-skill-install",
        itemId: item.id,
        status: result.alreadyInstalled ? "skipped" : "success",
        resultEntityId: result.skillId,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cascadeResults.push({
        step: "package-member-skill-install",
        itemId: item.id,
        status: "failure",
        errorMessage: message,
        durationMs: Date.now() - started,
      });
      throw new PackageInstallError(
        `Package install failed for ${item.id}: ${message}`,
        cascadeResults,
      );
    }
  }

  return { installedSkillIds, cascadeResults };
}
