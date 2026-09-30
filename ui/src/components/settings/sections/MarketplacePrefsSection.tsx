import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { useCompany } from "@/context/CompanyContext";
import {
  useMarketplaceSettings,
  usePatchMarketplaceSettings,
} from "@/hooks/useMarketplaceSettings";
import { useToast } from "@/context/ToastContext";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field, ToggleField } from "@/components/agent-config-primitives";
import { PageSkeleton } from "@/components/PageSkeleton";
import { cn } from "@/lib/utils";
import { MarketplaceUpdatesPanel } from "./MarketplaceUpdatesPanel";

export function MarketplacePrefsSection() {
  const { selectedCompanyId } = useCompany();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: settings, isLoading } = useMarketplaceSettings(selectedCompanyId ?? undefined);
  const patch = usePatchMarketplaceSettings(selectedCompanyId ?? undefined);
  const { pushToast } = useToast();
  const section = searchParams.get("section") === "updates" ? "updates" : "preferences";

  const setSection = useCallback(
    (next: "preferences" | "updates") => {
      const updated = new URLSearchParams(searchParams);
      updated.set("tab", "marketplace");
      if (next === "updates") {
        updated.set("section", "updates");
      } else {
        updated.delete("section");
      }
      setSearchParams(updated, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const applyPatch = useCallback(
    async (p: Parameters<typeof patch.mutateAsync>[0]) => {
      try {
        await patch.mutateAsync(p);
        pushToast({ title: "Marketplace setting saved", tone: "success" });
      } catch (err) {
        pushToast({
          title: "Failed to save marketplace setting",
          body: err instanceof Error ? err.message : "Unknown error",
          tone: "error",
        });
      }
    },
    [patch, pushToast],
  );

  return (
    <div>
      {/* Section header */}
      <div className="px-8 pt-6 pb-3 border-b border-border">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
          Settings · Extensions
        </div>
        <h2 className="text-[1.4rem] font-bold tracking-tight mt-1">
          Marketplace prefs<span className="text-brand">.</span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Update policy, access controls, and how often the marketplace re-fetches.
        </p>
      </div>

      <div className="p-8">
        <div
          role="tablist"
          aria-label="Marketplace settings sections"
          className="mb-6 inline-flex rounded-md border border-border bg-card-2 p-1"
        >
          {(["preferences", "updates"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={section === tab}
              className={cn(
                "rounded-[5px] px-3 py-1.5 text-sm font-semibold transition-colors",
                section === tab
                  ? "bg-card text-text shadow-sm"
                  : "text-muted-foreground hover:text-text",
              )}
              onClick={() => setSection(tab)}
            >
              {tab === "preferences" ? "Preferences" : "Updates"}
            </button>
          ))}
        </div>

        {section === "updates" ? (
          <MarketplaceUpdatesPanel />
        ) : isLoading ? (
          <PageSkeleton variant="list" />
        ) : !settings ? (
          <div className="text-sm text-muted-foreground">
            Unable to load marketplace settings.
          </div>
        ) : (
          <div className="space-y-6">
            {/* Section 1 — Updates */}
            <div className="space-y-4">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Updates
              </div>
              <div className="space-y-3 rounded-md border border-border px-4 py-4">
                <Field
                  label="Plugin update policy"
                  hint="How plugin updates are applied when a new version is available."
                >
                  <Select
                    value={settings.pluginUpdatePolicy}
                    onValueChange={(v) =>
                      applyPatch({
                        pluginUpdatePolicy: v as typeof settings.pluginUpdatePolicy,
                      })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto_patch">Auto (patch only)</SelectItem>
                      <SelectItem value="auto_minor">
                        Auto (patch + minor)
                      </SelectItem>
                      <SelectItem value="notify_all">Notify only</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <ToggleField
                  label="Agent updates"
                  hint="Auto-apply agent updates when available."
                  checked={settings.agentUpdatePolicy === "auto"}
                  onChange={(v) =>
                    applyPatch({ agentUpdatePolicy: v ? "auto" : "notify" })
                  }
                />
                <ToggleField
                  label="Team updates"
                  hint="Auto-apply team updates when available."
                  checked={settings.teamUpdatePolicy === "auto"}
                  onChange={(v) =>
                    applyPatch({ teamUpdatePolicy: v ? "auto" : "notify" })
                  }
                />
                {/* Ghost setting — updateWindow */}
                <Field
                  label="Update window"
                  hint="When automatic updates are allowed to run."
                >
                  <Select
                    value={settings.updateWindow}
                    onValueChange={(v) =>
                      applyPatch({
                        updateWindow: v as typeof settings.updateWindow,
                      })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="anytime">Any time</SelectItem>
                      <SelectItem value="off_hours">
                        Off hours (10pm-6am local)
                      </SelectItem>
                      <SelectItem value="weekends">Weekends</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            </div>

            {/* Section 2 — Access */}
            <div className="space-y-4">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Access
              </div>
              <div className="space-y-3 rounded-md border border-border px-4 py-4">
                <ToggleField
                  label="Show trust badges"
                  hint="Display trust tier badges (verified / community / unverified) on catalog items."
                  checked={settings.showTrustBadges}
                  onChange={(v) => applyPatch({ showTrustBadges: v })}
                />
                <ToggleField
                  label="Show source info"
                  hint="Display publisher and source repository links on catalog items."
                  checked={settings.showSourceInfo}
                  onChange={(v) => applyPatch({ showSourceInfo: v })}
                />
                <ToggleField
                  label="Team leads can install plugins"
                  hint="Allow team leads to install plugins directly without founder approval."
                  checked={settings.allowTeamLeadPlugins}
                  onChange={(v) => applyPatch({ allowTeamLeadPlugins: v })}
                />
                <ToggleField
                  label="Team members can request installs"
                  hint="Allow team members to submit install requests for founder or team lead review."
                  checked={settings.teamMemberCanRequestInstall}
                  onChange={(v) => applyPatch({ teamMemberCanRequestInstall: v })}
                />
                <ToggleField
                  label="Require founder approval"
                  hint="All marketplace installs require explicit founder approval before proceeding."
                  checked={settings.requireFounderApproval}
                  onChange={(v) => applyPatch({ requireFounderApproval: v })}
                />
              </div>
            </div>

            {/* Section 3 — Catalog refresh */}
            <div className="space-y-4">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Catalog Refresh
              </div>
              <div className="space-y-3 rounded-md border border-border px-4 py-4">
                <Field
                  label="Catalog refresh interval"
                  hint="How often the marketplace catalog is re-fetched from the CDN."
                >
                  <Select
                    value={String(settings.catalogRefreshHours)}
                    onValueChange={(v) =>
                      applyPatch({
                        catalogRefreshHours: Number(v) as 6 | 12 | 24,
                      })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="6">Every 6 hours</SelectItem>
                      <SelectItem value="12">Every 12 hours</SelectItem>
                      <SelectItem value="24">Every 24 hours</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field
                  label="Update check interval"
                  hint="How often installed items are checked for new versions."
                >
                  <Select
                    value={String(settings.updateCheckHours)}
                    onValueChange={(v) =>
                      applyPatch({
                        updateCheckHours: Number(v) as 6 | 12 | 24,
                      })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="6">Every 6 hours</SelectItem>
                      <SelectItem value="12">Every 12 hours</SelectItem>
                      <SelectItem value="24">Every 24 hours</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
