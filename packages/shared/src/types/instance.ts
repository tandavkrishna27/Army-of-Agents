export type { InstanceGeneralSettings, InstanceExperimentalSettings } from "../validators/instance.js";
import type { InstanceGeneralSettings, InstanceExperimentalSettings } from "../validators/instance.js";

export const DAILY_RETENTION_PRESETS = [3, 7, 14] as const;
export const WEEKLY_RETENTION_PRESETS = [1, 2, 4] as const;
export const MONTHLY_RETENTION_PRESETS = [1, 3, 6] as const;

export interface BackupRetentionTieredPolicy {
  mode?: "tiered";
  dailyDays: (typeof DAILY_RETENTION_PRESETS)[number];
  weeklyWeeks: (typeof WEEKLY_RETENTION_PRESETS)[number];
  monthlyMonths: (typeof MONTHLY_RETENTION_PRESETS)[number];
}

export interface BackupRetentionCountPolicy {
  mode: "count";
  /** Keep at most this many backup files. */
  count: number;
}

export type BackupRetentionPolicy = BackupRetentionTieredPolicy | BackupRetentionCountPolicy;

export const DEFAULT_BACKUP_RETENTION: BackupRetentionTieredPolicy = {
  dailyDays: 7,
  weeklyWeeks: 4,
  monthlyMonths: 1,
};

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}
