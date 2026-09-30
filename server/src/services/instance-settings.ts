import type { Db } from "@armyofagents/db";
import { companies, instanceSettings } from "@armyofagents/db";
import {
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  instanceGeneralSettingsSchema,
  type InstanceGeneralSettings,
  instanceExperimentalSettingsSchema,
  type InstanceExperimentalSettings,
  type PatchInstanceGeneralSettings,
  type InstanceSettings,
  type PatchInstanceExperimentalSettings,
} from "@armyofagents/shared";
import { eq } from "drizzle-orm";

const DEFAULT_SINGLETON_KEY = "default";
const MIGRATION_SNAPSHOTS_KEY = "migrationSnapshots";

function splitStoredGeneralSettings(raw: unknown): {
  publicSettings: unknown;
  operationalMetadata: Record<string, unknown>;
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { publicSettings: raw, operationalMetadata: {} };
  }

  const publicSettings = { ...(raw as Record<string, unknown>) };
  const operationalMetadata: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(publicSettings, MIGRATION_SNAPSHOTS_KEY)) {
    operationalMetadata[MIGRATION_SNAPSHOTS_KEY] = publicSettings[MIGRATION_SNAPSHOTS_KEY];
    delete publicSettings[MIGRATION_SNAPSHOTS_KEY];
  }
  return { publicSettings, operationalMetadata };
}

function normalizeGeneralSettings(raw: unknown): InstanceGeneralSettings {
  const { publicSettings } = splitStoredGeneralSettings(raw);
  const parsed = instanceGeneralSettingsSchema.safeParse(publicSettings ?? {});
  if (parsed.success) {
    return {
      censorUsernameInLogs: parsed.data.censorUsernameInLogs ?? false,
      keyboardShortcuts: parsed.data.keyboardShortcuts ?? false,
      feedbackDataSharingPreference:
        parsed.data.feedbackDataSharingPreference ?? DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
      backupRetention: parsed.data.backupRetention ?? DEFAULT_BACKUP_RETENTION,
    };
  }
  return {
    censorUsernameInLogs: false,
    keyboardShortcuts: false,
    feedbackDataSharingPreference: DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
    backupRetention: DEFAULT_BACKUP_RETENTION,
  };
}

function normalizeExperimentalSettings(raw: unknown): InstanceExperimentalSettings {
  const parsed = instanceExperimentalSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return {
      enableIsolatedWorkspaces: parsed.data.enableIsolatedWorkspaces ?? true,
      autoRestartDevServerWhenIdle: parsed.data.autoRestartDevServerWhenIdle ?? false,
      enableWorkspaceTtlSweeper: parsed.data.enableWorkspaceTtlSweeper ?? false,
      warmSandboxDefaultForSoftwareDev: parsed.data.warmSandboxDefaultForSoftwareDev ?? true,
      warmSandboxIdleTtlMinutes: parsed.data.warmSandboxIdleTtlMinutes ?? 30,
      enableWarmSandboxReaper: parsed.data.enableWarmSandboxReaper ?? true,
      warmCommanderConversations: parsed.data.warmCommanderConversations ?? true,
    };
  }
  return {
    enableIsolatedWorkspaces: true,
    autoRestartDevServerWhenIdle: false,
    enableWorkspaceTtlSweeper: false,
    warmSandboxDefaultForSoftwareDev: true,
    warmSandboxIdleTtlMinutes: 30,
    enableWarmSandboxReaper: true,
    warmCommanderConversations: true,
  };
}

function toInstanceSettings(row: typeof instanceSettings.$inferSelect): InstanceSettings {
  return {
    id: row.id,
    general: normalizeGeneralSettings(row.general),
    experimental: normalizeExperimentalSettings(row.experimental),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function instanceSettingsService(db: Db) {
  async function getOrCreateRow() {
    const existing = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;

    const now = new Date();
    const [created] = await db
      .insert(instanceSettings)
      .values({
        singletonKey: DEFAULT_SINGLETON_KEY,
        general: {},
        experimental: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [instanceSettings.singletonKey],
        set: {
          updatedAt: now,
        },
      })
      .returning();

    return created;
  }

  return {
    get: async (): Promise<InstanceSettings> => toInstanceSettings(await getOrCreateRow()),

    getGeneral: async (): Promise<InstanceGeneralSettings> => {
      const row = await getOrCreateRow();
      return normalizeGeneralSettings(row.general);
    },

    getExperimental: async (): Promise<InstanceExperimentalSettings> => {
      const row = await getOrCreateRow();
      return normalizeExperimentalSettings(row.experimental);
    },

    updateGeneral: async (patch: PatchInstanceGeneralSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const { operationalMetadata } = splitStoredGeneralSettings(current.general);
      const nextGeneral = normalizeGeneralSettings({
        ...normalizeGeneralSettings(current.general),
        ...patch,
      });
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          general: { ...nextGeneral, ...operationalMetadata },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    updateExperimental: async (patch: PatchInstanceExperimentalSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const nextExperimental = normalizeExperimentalSettings({
        ...normalizeExperimentalSettings(current.experimental),
        ...patch,
      });
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          experimental: { ...nextExperimental },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    listCompanyIds: async (): Promise<string[]> =>
      db
        .select({ id: companies.id })
        .from(companies)
        .then((rows) => rows.map((row) => row.id)),
  };
}
