import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { providerQuotaWindows } from "@armyofagents/db";
import { listServerAdapters, findServerAdapter } from "../adapters/registry.js";
import { logger } from "../middleware/logger.js";

// Shape returned by adapter.getQuotaWindows() — mirrors Paperclip's
// `ProviderQuotaResult` (see paperclip/packages/shared/src/types/quota.ts).
// AoA keeps adapter contracts source-compatible so a shared adapter package
// can one day replace these local copies.
interface AdapterQuotaWindow {
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  valueLabel: string | null;
  detail?: string | null;
}

interface AdapterQuotaResult {
  provider: string;
  source?: string | null;
  ok: boolean;
  error?: string;
  windows: AdapterQuotaWindow[];
}

/**
 * Maps an AoA adapter type to the provider slug stored on the snapshot row.
 * Paperclip uses the same mapping; keeping it aligned lets future shared
 * adapter packages flow between the two codebases without surprises.
 */
export function providerSlugForAdapterType(type: string): string {
  switch (type) {
    case "claude_local":
      return "anthropic";
    case "codex_local":
      return "openai";
    default:
      return type;
  }
}

export interface RecordUsageInput {
  provider: string;
  model?: string | null;
  windowKind: string;
  label?: string | null;
  limitValue?: number | null;
  usedValue?: number | null;
  usedPercent?: number | null;
  valueLabel?: string | null;
  resetAt?: Date | null;
}

function parseResetAt(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function quotaWindowsService(db: Db) {
  async function upsertSnapshot(values: typeof providerQuotaWindows.$inferInsert) {
    const now = new Date();
    const row = await db
      .insert(providerQuotaWindows)
      .values({ ...values, lastUpdatedAt: now })
      .onConflictDoUpdate({
        target: [
          providerQuotaWindows.companyId,
          providerQuotaWindows.provider,
          providerQuotaWindows.model,
          providerQuotaWindows.windowKind,
        ],
        set: {
          label: values.label ?? null,
          limitValue: values.limitValue ?? null,
          usedValue: values.usedValue ?? null,
          usedPercent: values.usedPercent ?? null,
          valueLabel: values.valueLabel ?? null,
          resetAt: values.resetAt ?? null,
          lastUpdatedAt: now,
        },
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    return row;
  }

  async function refreshWithAdapter(
    companyId: string,
    adapter: { type: string; getQuotaWindows?: () => unknown },
  ): Promise<Array<typeof providerQuotaWindows.$inferSelect>> {
    if (!adapter.getQuotaWindows) return [];
    let result: AdapterQuotaResult;
    try {
      result = (await adapter.getQuotaWindows()) as AdapterQuotaResult;
    } catch (err) {
      logger.warn({ err, adapterType: adapter.type }, "adapter.getQuotaWindows threw — skipping refresh");
      return [];
    }
    if (!result?.ok || !Array.isArray(result.windows) || result.windows.length === 0) {
      return [];
    }
    const provider = result.provider || providerSlugForAdapterType(adapter.type);
    const rows: Array<typeof providerQuotaWindows.$inferSelect> = [];
    for (const w of result.windows) {
      const row = await upsertSnapshot({
        companyId,
        provider,
        model: null,
        windowKind: w.label,
        label: w.label,
        limitValue: null,
        usedValue: null,
        usedPercent: w.usedPercent ?? null,
        valueLabel: w.valueLabel ?? null,
        resetAt: parseResetAt(w.resetsAt),
      });
      if (row) rows.push(row);
    }
    return rows;
  }

  return {
    list: async (companyId: string) => {
      return db
        .select()
        .from(providerQuotaWindows)
        .where(eq(providerQuotaWindows.companyId, companyId));
    },

    getWindow: async (
      companyId: string,
      provider: string,
      model: string | null,
      windowKind: string,
    ) => {
      const conditions = [
        eq(providerQuotaWindows.companyId, companyId),
        eq(providerQuotaWindows.provider, provider),
        eq(providerQuotaWindows.windowKind, windowKind),
      ];
      if (model !== null) {
        conditions.push(eq(providerQuotaWindows.model, model));
      }
      const rows = await db
        .select()
        .from(providerQuotaWindows)
        .where(and(...conditions))
        .limit(1);
      return rows[0] ?? null;
    },

    refresh: async (companyId: string, adapterType: string) => {
      const adapter = findServerAdapter(adapterType) as
        | { type: string; getQuotaWindows?: () => unknown }
        | null;
      if (!adapter) return [];
      return refreshWithAdapter(companyId, adapter);
    },

    refreshAll: async (companyId: string) => {
      const adapters = listServerAdapters().filter(
        (a) => (a as { getQuotaWindows?: unknown }).getQuotaWindows != null,
      ) as Array<{ type: string; getQuotaWindows?: () => unknown }>;
      const all: Array<typeof providerQuotaWindows.$inferSelect> = [];
      for (const adapter of adapters) {
        const rows = await refreshWithAdapter(companyId, adapter);
        all.push(...rows);
      }
      return all;
    },

    recordUsage: async (companyId: string, input: RecordUsageInput) => {
      return upsertSnapshot({
        companyId,
        provider: input.provider,
        model: input.model ?? null,
        windowKind: input.windowKind,
        label: input.label ?? null,
        limitValue: input.limitValue ?? null,
        usedValue: input.usedValue ?? null,
        usedPercent: input.usedPercent ?? null,
        valueLabel: input.valueLabel ?? null,
        resetAt: input.resetAt ?? null,
      });
    },
  };
}
