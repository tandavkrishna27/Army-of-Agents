import type {
  BackupRetentionPolicy,
  InstanceGeneralSettings,
  PatchInstanceGeneralSettings,
} from "@armyofagents/shared";
import {
  DAILY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
  MONTHLY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
} from "@armyofagents/shared";
import { cn } from "@/lib/utils";

interface BackupsTabProps {
  settings: InstanceGeneralSettings | undefined;
  isLoading: boolean;
  error: unknown;
  isSaving: boolean;
  onChange: (patch: PatchInstanceGeneralSettings) => void;
}

export function BackupsTab({ settings, isLoading, error, isSaving, onChange }: BackupsTabProps) {
  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading backup settings...</div>;
  }
  if (error) {
    return <div className="text-sm text-destructive">Failed to load backup settings.</div>;
  }

  const retention: BackupRetentionPolicy = settings?.backupRetention ?? DEFAULT_BACKUP_RETENTION;

  const update = (patch: Partial<BackupRetentionPolicy>) =>
    onChange({ backupRetention: { ...retention, ...patch } });

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Backups</h2>
        <p className="text-sm text-muted-foreground">
          Configure how long automatic database backups are retained. Daily backups are thinned to
          one per week, then one per month.
        </p>
      </div>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-5">
          <div className="space-y-1.5">
            <h3 className="text-sm font-semibold">Backup retention</h3>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Pick one preset per tier. Backups are gzip-compressed before storage.
            </p>
          </div>

          <RetentionPresetGroup
            label="Daily"
            presets={DAILY_RETENTION_PRESETS}
            value={retention.dailyDays}
            disabled={isSaving}
            formatLabel={(n) => `${n} days`}
            onSelect={(dailyDays) => update({ dailyDays })}
          />

          <RetentionPresetGroup
            label="Weekly"
            presets={WEEKLY_RETENTION_PRESETS}
            value={retention.weeklyWeeks}
            disabled={isSaving}
            formatLabel={(n) => (n === 1 ? "1 week" : `${n} weeks`)}
            onSelect={(weeklyWeeks) => update({ weeklyWeeks })}
          />

          <RetentionPresetGroup
            label="Monthly"
            presets={MONTHLY_RETENTION_PRESETS}
            value={retention.monthlyMonths}
            disabled={isSaving}
            formatLabel={(n) => (n === 1 ? "1 month" : `${n} months`)}
            onSelect={(monthlyMonths) => update({ monthlyMonths })}
          />
        </div>
      </section>
    </div>
  );
}

interface RetentionPresetGroupProps<T extends number> {
  label: string;
  presets: readonly T[];
  value: T;
  disabled: boolean;
  formatLabel: (preset: T) => string;
  onSelect: (preset: T) => void;
}

function RetentionPresetGroup<T extends number>({
  label,
  presets,
  value,
  disabled,
  formatLabel,
  onSelect,
}: RetentionPresetGroupProps<T>) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </h4>
      <div role="radiogroup" aria-label={`${label} retention`} className="flex flex-wrap gap-2">
        {presets.map((preset) => {
          const active = value === preset;
          return (
            <button
              key={preset}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              className={cn(
                "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                active
                  ? "border-foreground bg-accent text-foreground"
                  : "border-border bg-background hover:bg-accent/50",
              )}
              onClick={() => onSelect(preset)}
            >
              <div className="text-sm font-medium">{formatLabel(preset)}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
