import { eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { marketplaceCompanySettings } from "@armyofagents/db";
import type { MarketplaceSettings } from "@armyofagents/shared";
import { MARKETPLACE_SETTINGS_DEFAULTS } from "@armyofagents/shared";

const ALLOWED_KEYS = new Set(Object.keys(MARKETPLACE_SETTINGS_DEFAULTS));

/**
 * Merge stored partial settings with defaults, stripping unknown keys.
 */
export function mergeWithDefaults(stored: Record<string, unknown>): MarketplaceSettings {
  const merged: Record<string, unknown> = { ...MARKETPLACE_SETTINGS_DEFAULTS };
  for (const key of ALLOWED_KEYS) {
    if (key in stored && stored[key] !== undefined) {
      merged[key] = stored[key];
    }
  }
  return merged as unknown as MarketplaceSettings;
}

export function marketplaceSettingsService(db: Db) {
  return {
    async get(companyId: string): Promise<MarketplaceSettings> {
      const rows = await db
        .select()
        .from(marketplaceCompanySettings)
        .where(eq(marketplaceCompanySettings.companyId, companyId));
      const stored = (rows[0]?.settings ?? {}) as Record<string, unknown>;
      return mergeWithDefaults(stored);
    },

    async patch(companyId: string, patch: Record<string, unknown>): Promise<MarketplaceSettings> {
      const current = await this.get(companyId);
      const merged: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(patch)) {
        if (ALLOWED_KEYS.has(key)) merged[key] = value;
      }

      await db
        .insert(marketplaceCompanySettings)
        .values({ companyId, settings: merged })
        .onConflictDoUpdate({
          target: marketplaceCompanySettings.companyId,
          set: { settings: merged, updatedAt: new Date() },
        });

      return mergeWithDefaults(merged);
    },
  };
}
