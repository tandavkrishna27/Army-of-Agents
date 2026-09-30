import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { notificationPreferences } from "@armyofagents/db";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  notificationPreferencesSchema,
  type NotificationPreferences,
  type UpdateNotificationPreferencesInput,
} from "@armyofagents/shared";

type NotificationPreferenceRow = {
  rules: unknown;
  quietHours: unknown;
  digest: unknown;
  updatedAt: Date | string | null;
};

function serializeUpdatedAt(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function cloneDefaults(): NotificationPreferences {
  return {
    rules: DEFAULT_NOTIFICATION_PREFERENCES.rules.map((rule) => ({ ...rule })),
    quietHours: { ...DEFAULT_NOTIFICATION_PREFERENCES.quietHours },
    digest: { ...DEFAULT_NOTIFICATION_PREFERENCES.digest },
    updatedAt: DEFAULT_NOTIFICATION_PREFERENCES.updatedAt,
  };
}

function toPreferences(row: NotificationPreferenceRow | null): NotificationPreferences {
  if (!row) return cloneDefaults();
  const parsed = notificationPreferencesSchema.safeParse({
    rules: row.rules,
    quietHours: row.quietHours,
    digest: row.digest,
    updatedAt: serializeUpdatedAt(row.updatedAt),
  });
  return parsed.success ? parsed.data : cloneDefaults();
}

function mergeRules(
  existing: NotificationPreferences["rules"],
  patchRules: NotificationPreferences["rules"] | undefined,
) {
  if (!patchRules) return existing;
  const merged = new Map(existing.map((rule) => [rule.semanticType, { ...rule }]));
  for (const rule of patchRules) {
    merged.set(rule.semanticType, { ...rule });
  }
  return [...merged.values()];
}

export function notificationPreferencesService(db: Db) {
  async function readRow(
    userId: string,
    companyId: string,
  ): Promise<NotificationPreferenceRow | null> {
    const rows = await db
      .select({
        rules: notificationPreferences.rules,
        quietHours: notificationPreferences.quietHours,
        digest: notificationPreferences.digest,
        updatedAt: notificationPreferences.updatedAt,
      })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, userId),
          eq(notificationPreferences.companyId, companyId),
        ),
      );
    return rows[0] ?? null;
  }

  async function writeRow(
    userId: string,
    companyId: string,
    preferences: Omit<NotificationPreferences, "updatedAt">,
  ): Promise<NotificationPreferences> {
    const now = new Date();
    const [row] = await db
      .insert(notificationPreferences)
      .values({
        userId,
        companyId,
        rules: preferences.rules,
        quietHours: preferences.quietHours,
        digest: preferences.digest,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [notificationPreferences.userId, notificationPreferences.companyId],
        set: {
          rules: preferences.rules,
          quietHours: preferences.quietHours,
          digest: preferences.digest,
          updatedAt: now,
        },
      })
      .returning({
        rules: notificationPreferences.rules,
        quietHours: notificationPreferences.quietHours,
        digest: notificationPreferences.digest,
        updatedAt: notificationPreferences.updatedAt,
      });
    return toPreferences(row ?? null);
  }

  return {
    async get(userId: string, companyId: string): Promise<NotificationPreferences> {
      return toPreferences(await readRow(userId, companyId));
    },

    async upsert(
      userId: string,
      companyId: string,
      patch: UpdateNotificationPreferencesInput,
    ): Promise<NotificationPreferences> {
      const existing = toPreferences(await readRow(userId, companyId));
      return writeRow(userId, companyId, {
        rules: mergeRules(existing.rules, patch.rules),
        quietHours: patch.quietHours ?? existing.quietHours,
        digest: patch.digest ?? existing.digest,
      });
    },

    async reset(userId: string, companyId: string): Promise<NotificationPreferences> {
      const defaults = cloneDefaults();
      return writeRow(userId, companyId, {
        rules: defaults.rules,
        quietHours: defaults.quietHours,
        digest: defaults.digest,
      });
    },
  };
}
