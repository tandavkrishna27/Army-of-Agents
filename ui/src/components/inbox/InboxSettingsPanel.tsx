import { Bell, SlidersHorizontal, Zap } from "lucide-react";
import type {
  HubAutopilotAction,
  HubAutopilotMode,
  HubAutopilotPolicy,
  HubDensity,
  HubGroupMode,
  HubLane,
  HubPreferences,
  NotificationPreference,
  NotificationPreferences,
  UpdateHubAutopilotPolicyInput,
  UpdateHubPreferencesInput,
  UpdateNotificationPreferencesInput,
} from "@armyofagents/shared";
import {
  isFounderGatedAutopilotType,
  isInternalSemanticType,
} from "@armyofagents/shared";
import type { HubItemListRow } from "@/api/hub-items";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingsCard } from "@/components/settings/SettingsCard";

export interface InboxSettingsPanelProps {
  preferences: HubPreferences;
  preferencesPending?: boolean;
  onPreferencesChange: (patch: UpdateHubPreferencesInput) => void;
  autopilotPolicy: HubAutopilotPolicy;
  autopilotPending?: boolean;
  onUpdateAutopilotPolicy: (patch: UpdateHubAutopilotPolicyInput) => void;
  onResetAutopilotPolicy: () => void;
  notificationPreferences: NotificationPreferences;
  notificationPreferencesPending?: boolean;
  onUpdateNotificationPreferences: (patch: UpdateNotificationPreferencesInput) => void;
  onResetNotificationPreferences: () => void;
  digestItems?: HubItemListRow[];
  onAckDigest: () => void;
}

export function InboxSettingsPanel({
  preferences,
  preferencesPending = false,
  onPreferencesChange,
  autopilotPolicy,
  autopilotPending = false,
  onUpdateAutopilotPolicy,
  onResetAutopilotPolicy,
  notificationPreferences,
  notificationPreferencesPending = false,
  onUpdateNotificationPreferences,
  onResetNotificationPreferences,
  digestItems = [],
  onAckDigest,
}: InboxSettingsPanelProps) {
  const updateNotificationRule = (
    semanticType: NotificationPreferences["rules"][number]["semanticType"],
    patch: Partial<Pick<NotificationPreferences["rules"][number], "deliveryMode" | "toastEnabled">>,
  ) => {
    onUpdateNotificationPreferences({
      rules: notificationPreferences.rules.map((rule) =>
        rule.semanticType === semanticType ? { ...rule, ...patch } : rule,
      ),
    });
  };

  const updateQuietHours = (patch: Partial<NotificationPreferences["quietHours"]>) => {
    onUpdateNotificationPreferences({
      quietHours: { ...notificationPreferences.quietHours, ...patch },
    });
  };

  const updateDigest = (patch: Partial<NotificationPreferences["digest"]>) => {
    onUpdateNotificationPreferences({
      digest: { ...notificationPreferences.digest, ...patch },
    });
  };

  const updateAutopilotRule = (
    semanticType: HubAutopilotPolicy["rules"][number]["semanticType"],
    patch: Partial<
      Pick<HubAutopilotPolicy["rules"][number], "enabled" | "action" | "minTrustScore">
    >,
  ) => {
    onUpdateAutopilotPolicy({
      rules: autopilotPolicy.rules.map((rule) =>
        rule.semanticType === semanticType ? { ...rule, ...patch } : rule,
      ),
    });
  };

  return (
    <div className="grid gap-4">
      {/* ── Layout ─────────────────────────────────────────────────────── */}
      <SettingsCard
        icon={SlidersHorizontal}
        title="Layout"
        description="How the Inbox is laid out — landing view, lanes, grouping, and density."
        bodyClassName="grid gap-3 text-xs"
      >
        <label className="grid gap-1">
          <span className="text-muted-foreground">Default landing</span>
          <p className="text-[11px] text-muted-foreground">
            Which view opens when you land on the Inbox.
          </p>
          <select
            aria-label="Default landing"
            value={preferences.defaultLanding}
            disabled={preferencesPending}
            onChange={(event) =>
              onPreferencesChange({ defaultLanding: event.target.value as "home" | HubLane })
            }
            className="h-8 rounded border border-border bg-bg px-2"
          >
            <option value="home">Home</option>
            <option value="waiting_on_you">Waiting on you</option>
            <option value="notifications">Notifications</option>
            <option value="suggestions">Suggestions</option>
          </select>
        </label>
        <div className="grid gap-1">
          <span className="text-muted-foreground">Visible lanes</span>
          <p className="text-[11px] text-muted-foreground">
            Choose which lanes appear in the rail.
          </p>
          <div className="grid grid-cols-3 gap-2">
            {(["waiting_on_you", "notifications", "suggestions"] as const).map((lane) => (
              <label key={lane} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={preferences.visibleLanes.includes(lane)}
                  disabled={preferencesPending}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [...preferences.visibleLanes, lane]
                      : preferences.visibleLanes.filter((value) => value !== lane);
                    if (next.length > 0) onPreferencesChange({ visibleLanes: next });
                  }}
                />
                <span>{laneTitle(lane)}</span>
              </label>
            ))}
          </div>
        </div>
        <label className="grid gap-1">
          <span className="text-muted-foreground">Grouping</span>
          <p className="text-[11px] text-muted-foreground">
            How items are grouped in each lane.
          </p>
          <select
            aria-label="Grouping"
            value={preferences.groupMode}
            disabled={preferencesPending}
            onChange={(event) =>
              onPreferencesChange({ groupMode: event.target.value as HubGroupMode })
            }
            className="h-8 rounded border border-border bg-bg px-2"
          >
            <option value="auto">Auto</option>
            <option value="source">Source</option>
            <option value="scope">Scope</option>
            <option value="type">Type</option>
            <option value="none">None</option>
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-muted-foreground">Density</span>
          <p className="text-[11px] text-muted-foreground">
            Row height — Comfortable for readability, Compact to fit more.
          </p>
          <select
            aria-label="Density"
            value={preferences.density}
            disabled={preferencesPending}
            onChange={(event) =>
              onPreferencesChange({ density: event.target.value as HubDensity })
            }
            className="h-8 rounded border border-border bg-bg px-2"
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
        </label>
      </SettingsCard>

      {/* ── Autopilot ──────────────────────────────────────────────────── */}
      <SettingsCard
        icon={Zap}
        title="Autopilot"
        description="Let the Hub act on items automatically within the limits you set."
        headerAside={
          <div className="flex items-center gap-2">
            {autopilotPending ? (
              <span className="text-[11px] text-muted-foreground">Saving</span>
            ) : null}
            <AutopilotModePill mode={autopilotPolicy.mode} />
          </div>
        }
        bodyClassName="grid gap-3 text-xs"
      >
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            aria-label="Autopilot entry"
            checked={preferences.showAutopilotEntry}
            onChange={(event) =>
              onPreferencesChange({ showAutopilotEntry: event.target.checked })
            }
          />
          <span>Autopilot entry</span>
        </label>
        <label className="grid gap-1">
          <span className="text-muted-foreground">Mode</span>
          <select
            aria-label="Autopilot mode"
            value={autopilotPolicy.mode}
            disabled={autopilotPending}
            onChange={(event) =>
              onUpdateAutopilotPolicy({
                mode: event.target.value as HubAutopilotMode,
              })
            }
            className="h-8 rounded border border-border bg-bg px-2"
          >
            <option value="off">Off</option>
            <option value="assist">Assist</option>
            <option value="drive">Drive</option>
          </select>
        </label>
        <div className="grid gap-2">
          {autopilotPolicy.rules
            // Hide internal-only sink types (legacy_other) from the
            // founder-facing rules list — they can never fire in a
            // fresh install (Task 10). The stored rule stays intact.
            .filter((rule) => !isInternalSemanticType(rule.semanticType))
            .map((rule) => {
              const label = semanticTypeLabel(rule.semanticType);
              const founderGated = isFounderGatedAutopilotType(rule.semanticType);
              return (
                <div key={rule.semanticType} className="grid gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium">{label}</div>
                    {founderGated ? (
                      <span className="text-[11px] uppercase text-muted-foreground">
                        Founder-gated
                      </span>
                    ) : null}
                  </div>
                  {founderGated ? (
                    <div className="text-muted-foreground">
                      Escalation only.
                    </div>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-3">
                      <label className="flex items-center gap-2 self-end">
                        <input
                          type="checkbox"
                          aria-label={`${label} autopilot enabled`}
                          checked={rule.enabled}
                          disabled={autopilotPending}
                          onChange={(event) =>
                            updateAutopilotRule(rule.semanticType, {
                              enabled: event.target.checked,
                            })
                          }
                        />
                        <span>Enabled</span>
                      </label>
                      <label className="grid gap-1">
                        <span className="text-muted-foreground">Action</span>
                        <select
                          aria-label={`${label} autopilot action`}
                          value={rule.action}
                          disabled={autopilotPending}
                          onChange={(event) =>
                            updateAutopilotRule(rule.semanticType, {
                              action: event.target.value as HubAutopilotAction,
                            })
                          }
                          className="h-8 rounded border border-border bg-bg px-2"
                        >
                          <option value="none">None</option>
                          <option value="resolve">Resolve</option>
                          <option value="archive">Archive</option>
                        </select>
                      </label>
                      <label className="grid gap-1">
                        <span className="text-muted-foreground">Min trust</span>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          aria-label={`${label} min trust`}
                          value={rule.minTrustScore}
                          disabled={autopilotPending}
                          onChange={(event) =>
                            updateAutopilotRule(rule.semanticType, {
                              minTrustScore: Number(event.target.value),
                            })
                          }
                          className="h-8 rounded border border-border bg-bg px-2"
                        />
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-start"
          disabled={autopilotPending}
          onClick={onResetAutopilotPolicy}
        >
          Reset Autopilot
        </Button>
      </SettingsCard>

      {/* ── Notifications ──────────────────────────────────────────────── */}
      <SettingsCard
        icon={Bell}
        title="Notifications"
        description="How and when each kind of update reaches you."
        headerAside={
          notificationPreferencesPending ? (
            <span className="text-[11px] text-muted-foreground">Saving</span>
          ) : null
        }
        bodyClassName="grid gap-3 text-xs"
      >
        <div className="grid gap-2">
          {notificationPreferences.rules
            // Hide internal-only sink types (legacy_other) — see the
            // autopilot list above (Task 10).
            .filter((rule) => !isInternalSemanticType(rule.semanticType))
            .map((rule) => {
              const label = semanticTypeLabel(rule.semanticType);
              return (
                <div key={rule.semanticType} className="grid gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0">
                  <div className="font-medium">{label}</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="grid gap-1">
                      <span className="text-muted-foreground">Delivery</span>
                      <select
                        aria-label={`${label} delivery`}
                        value={rule.deliveryMode}
                        disabled={notificationPreferencesPending}
                        onChange={(event) =>
                          updateNotificationRule(rule.semanticType, {
                            deliveryMode: event.target.value as NotificationPreference,
                          })
                        }
                        className="h-8 rounded border border-border bg-bg px-2"
                      >
                        <option value="realtime">Realtime</option>
                        <option value="digest">Digest</option>
                        <option value="silent">Silent</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-2 self-end">
                      <input
                        type="checkbox"
                        aria-label={`${label} toast`}
                        checked={rule.toastEnabled}
                        disabled={notificationPreferencesPending || rule.deliveryMode !== "realtime"}
                        onChange={(event) =>
                          updateNotificationRule(rule.semanticType, {
                            toastEnabled: event.target.checked,
                          })
                        }
                      />
                      <span>Toast</span>
                    </label>
                  </div>
                </div>
              );
            })}
        </div>
        <div className="grid gap-2 border-t border-border pt-3">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-label="Quiet hours"
              checked={notificationPreferences.quietHours.enabled}
              disabled={notificationPreferencesPending}
              onChange={(event) => updateQuietHours({ enabled: event.target.checked })}
            />
            <span>Quiet hours</span>
          </label>
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="grid gap-1">
              <span className="text-muted-foreground">Start</span>
              <input
                aria-label="Quiet hours start"
                value={notificationPreferences.quietHours.start}
                disabled={notificationPreferencesPending}
                onChange={(event) => updateQuietHours({ start: event.target.value })}
                className="h-8 rounded border border-border bg-bg px-2"
              />
            </label>
            <label className="grid gap-1">
              <span className="text-muted-foreground">End</span>
              <input
                aria-label="Quiet hours end"
                value={notificationPreferences.quietHours.end}
                disabled={notificationPreferencesPending}
                onChange={(event) => updateQuietHours({ end: event.target.value })}
                className="h-8 rounded border border-border bg-bg px-2"
              />
            </label>
            <label className="grid gap-1">
              <span className="text-muted-foreground">Timezone</span>
              <input
                aria-label="Quiet hours timezone"
                value={notificationPreferences.quietHours.timezone}
                disabled={notificationPreferencesPending}
                onChange={(event) => updateQuietHours({ timezone: event.target.value })}
                className="h-8 rounded border border-border bg-bg px-2"
              />
            </label>
          </div>
        </div>
        <div className="grid gap-2 border-t border-border pt-3">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-label="Digest enabled"
              checked={notificationPreferences.digest.enabled}
              disabled={notificationPreferencesPending}
              onChange={(event) => updateDigest({ enabled: event.target.checked })}
            />
            <span>Digest enabled</span>
          </label>
          <div className="grid gap-1">
            <div className="text-muted-foreground">Pending digest</div>
            {digestItems.length > 0 ? (
              <ul className="grid gap-1">
                {digestItems.slice(0, 5).map((item) => (
                  <li key={item.id} className="truncate rounded border border-border px-2 py-1">
                    {item.title}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-muted-foreground">No pending digest items</div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={notificationPreferencesPending || digestItems.length === 0}
              onClick={onAckDigest}
            >
              Acknowledge digest
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={notificationPreferencesPending}
              onClick={onResetNotificationPreferences}
            >
              Reset notification preferences
            </Button>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}

/** Compact pill echoing the current Autopilot mode in the card header. */
function AutopilotModePill({ mode }: { mode: HubAutopilotMode }) {
  const label = mode === "drive" ? "Drive" : mode === "assist" ? "Assist" : "Off";
  const tone =
    mode === "drive"
      ? "bg-brand/10 text-brand"
      : mode === "assist"
        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : "bg-muted text-muted-foreground";
  return (
    <span
      data-testid="autopilot-mode-pill"
      className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", tone)}
    >
      {label}
    </span>
  );
}

/** `snake_case` → "Snake Case" for the founder-facing rule labels. */
function semanticTypeLabel(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Lane title used by the visible-lanes checkbox row. */
function laneTitle(lane: HubLane) {
  if (lane === "waiting_on_you") return "Waiting on you";
  if (lane === "notifications") return "Notifications";
  return "Suggestions";
}
