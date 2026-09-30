import type {
  FeedbackDataSharingPreference,
  FeedbackExportSummary,
  InstanceGeneralSettings,
  PatchInstanceGeneralSettings,
} from "@armyofagents/shared";
import { DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE } from "@armyofagents/shared";
import { cn } from "@/lib/utils";

interface PrivacyTabProps {
  settings: InstanceGeneralSettings | undefined;
  isLoading: boolean;
  error: unknown;
  isSaving: boolean;
  onChange: (patch: PatchInstanceGeneralSettings) => void;
  bundleHistory?: FeedbackExportSummary[];
  bundleHistoryLoading?: boolean;
  bundleHistoryError?: unknown;
  showBundleHistory?: boolean;
}

function formatBundleTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatBundleSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function truncateExportId(exportId: string | null): string {
  if (!exportId) return "—";
  if (exportId.length <= 20) return exportId;
  return `${exportId.slice(0, 18)}…`;
}

const OPTIONS: ReadonlyArray<{
  value: FeedbackDataSharingPreference;
  label: string;
  description: string;
}> = [
  {
    value: "allowed",
    label: "Always allow",
    description: "Share voted AI outputs with Army of Agents Labs automatically.",
  },
  {
    value: "not_allowed",
    label: "Don't allow",
    description: "Keep voted AI outputs local only.",
  },
  {
    value: "prompt",
    label: "Ask each time",
    description: "Prompt on the first thumbs up or down, then remember the choice.",
  },
];

export function PrivacyTab({
  settings,
  isLoading,
  error,
  isSaving,
  onChange,
  bundleHistory,
  bundleHistoryLoading = false,
  bundleHistoryError,
  showBundleHistory = true,
}: PrivacyTabProps) {
  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading privacy settings...</div>;
  }
  if (error) {
    return <div className="text-sm text-destructive">Failed to load privacy settings.</div>;
  }

  const preference: FeedbackDataSharingPreference =
    settings?.feedbackDataSharingPreference ?? DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Privacy</h2>
        <p className="text-sm text-muted-foreground">
          Control whether anonymized feedback data leaves this instance. AoA defaults to not sharing
          — you opt in only if you want to contribute to AI improvement.
        </p>
      </div>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h3 className="text-sm font-semibold">AI feedback sharing</h3>
            <p className="max-w-2xl text-sm text-muted-foreground">
              When a teammate gives a thumbs up or down on an agent's output, this setting decides
              whether the voted output is shared. Votes are always saved locally; bundles are
              written to <code className="font-mono text-xs">~/.aoa/feedback-exports/</code>
              {" "}
              when sharing is allowed (transmission to AoA Labs is pending a destination decision).
            </p>
          </div>

          <div
            role="radiogroup"
            aria-label="AI feedback sharing preference"
            className="flex flex-col gap-2 sm:flex-row sm:flex-wrap"
          >
            {OPTIONS.map((option) => {
              const active = preference === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={isSaving}
                  className={cn(
                    "flex-1 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    active
                      ? "border-foreground bg-accent text-foreground"
                      : "border-border bg-background hover:bg-accent/50",
                  )}
                  onClick={() =>
                    onChange({ feedbackDataSharingPreference: option.value })
                  }
                >
                  <div className="text-sm font-medium">{option.label}</div>
                  <div className="text-xs text-muted-foreground">{option.description}</div>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {showBundleHistory && <section
        aria-labelledby="recent-shared-bundles-heading"
        className="rounded-xl border border-border bg-card p-5"
      >
        <div className="space-y-3">
          <div className="space-y-1">
            <h3
              id="recent-shared-bundles-heading"
              className="text-sm font-semibold"
            >
              Recent shared bundles
            </h3>
            <p className="text-xs text-muted-foreground">
              Most recent feedback bundles written locally. Bundle files include
              redacted content; transmission is deferred.
            </p>
          </div>

          {bundleHistoryLoading ? (
            <p className="text-sm text-muted-foreground">Loading bundle history…</p>
          ) : bundleHistoryError ? (
            <p className="text-sm text-destructive">Failed to load bundle history.</p>
          ) : !bundleHistory || bundleHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground">No bundles shared yet.</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {bundleHistory.map((row) => (
                <li
                  key={row.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <div className="flex items-center gap-3 truncate">
                    <span className="text-xs font-mono text-muted-foreground">
                      {formatBundleTimestamp(row.createdAt)}
                    </span>
                    <span className="truncate text-xs font-mono">
                      {truncateExportId(row.exportId)}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {formatBundleSize(row.sizeBytes)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>}
    </div>
  );
}
