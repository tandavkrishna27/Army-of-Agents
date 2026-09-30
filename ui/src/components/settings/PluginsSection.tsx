import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Puzzle } from "lucide-react";
import { PLUGIN_WORKER_BLOCKED_IN_CLOUD_REASON } from "@armyofagents/shared";
import { Button } from "@/components/ui/button";
import { useCompany } from "../../context/CompanyContext.js";
import { useToast } from "../../context/ToastContext.js";
import * as pluginsApi from "../../api/plugins.js";
import { marketplaceApi } from "../../api/marketplace.js";
import { CapabilityDeltaModal } from "./CapabilityDeltaModal.js";
import { PluginDetailSlideOver } from "./PluginDetailSlideOver.js";
import type { InstalledPlugin } from "../../api/plugins.js";
import type { PendingUpdate } from "../../api/marketplace.js";
import { cn } from "../../lib/utils.js";
import { profileApi } from "@/api/profile";
import { useCloudPluginExecutionPolicy } from "@/hooks/useCloudPluginExecutionPolicy";

const CATEGORY_STYLE: Record<string, string> = {
  notifications:
    "bg-gradient-to-br from-indigo-900/40 to-indigo-800/20 border border-indigo-800/30",
  issues:
    "bg-gradient-to-br from-slate-800/60 to-slate-700/20 border border-slate-700/30",
  storage:
    "bg-gradient-to-br from-emerald-900/40 to-emerald-800/20 border border-emerald-800/30",
  integrations:
    "bg-gradient-to-br from-violet-900/40 to-violet-800/20 border border-violet-800/30",
};

const CATEGORY_EMOJI: Record<string, string> = {
  notifications: "🔔",
  issues: "🐙",
  storage: "📦",
  integrations: "🔗",
};

const CLOUD_BLOCK_REASON = PLUGIN_WORKER_BLOCKED_IN_CLOUD_REASON;

function PluginStatusBadge({
  status,
  statusReasonCode,
}: {
  status: string;
  statusReasonCode?: string | null;
}) {
  const cloudBlocked = statusReasonCode === CLOUD_BLOCK_REASON;
  const styles: Record<string, string> = {
    ready: "bg-green-950/40 text-green-400 border-green-900",
    error: "bg-red-950/40 text-red-400 border-red-900",
    upgrade_pending: "bg-indigo-950/40 text-indigo-400 border-indigo-900",
    disabled: "bg-zinc-800 text-zinc-500 border-zinc-700",
  };
  return (
    <span
      className={cn(
        "text-[10px] px-2 py-0.5 rounded-full border font-medium",
        styles[status] ?? "bg-zinc-800 text-zinc-500 border-zinc-700"
      )}
    >
      {cloudBlocked && (
        <AlertTriangle aria-hidden="true" className="mr-1 inline h-3 w-3" />
      )}
      {cloudBlocked ? "Blocked on AoA Cloud" : status}
    </span>
  );
}

function PluginCard({
  plugin,
  pendingUpdate,
  selected,
  onSelect,
  onApplyUpdate,
  isUpdating,
  canManage,
}: {
  plugin: InstalledPlugin;
  pendingUpdate: PendingUpdate | undefined;
  selected: boolean;
  onSelect: () => void;
  onApplyUpdate?: () => void;
  isUpdating?: boolean;
  canManage: boolean;
}) {
  const cloudPolicy = useCloudPluginExecutionPolicy();
  const hasUpdate = !!pendingUpdate;
  const cloudBlocked = cloudPolicy.isCloud || plugin.statusReasonCode === CLOUD_BLOCK_REASON;
  const executionControlsBlocked =
    cloudPolicy.controlsBlocked || plugin.statusReasonCode === CLOUD_BLOCK_REASON;
  const primaryCategory = plugin.categories[0] ?? "integrations";
  const iconStyle =
    CATEGORY_STYLE[primaryCategory] ?? CATEGORY_STYLE.integrations;
  const emoji = CATEGORY_EMOJI[primaryCategory] ?? "🔌";

  return (
    <div
      className={cn(
        "relative flex flex-col gap-3 p-4 rounded-xl border text-left transition-all duration-150",
        selected
          ? "border-indigo-500 bg-indigo-950/20 shadow-[0_0_0_1px_theme(colors.indigo.500)]"
          : "border-zinc-800 bg-zinc-900 hover:border-zinc-700 hover:shadow-lg hover:shadow-black/30",
        hasUpdate && !selected && "border-t-amber-500 border-t-[3px]",
        hasUpdate &&
          selected &&
          "border-t-amber-500 border-t-[3px] border-l-indigo-500 border-r-indigo-500 border-b-indigo-500"
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-shrink-0",
            iconStyle
          )}
        >
          {emoji}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-zinc-100 truncate">
            {plugin.manifest.displayName}
          </div>
          <div className="text-[10px] text-zinc-600">v{plugin.version}</div>
        </div>
      </div>

      <p className="text-xs text-zinc-500 leading-relaxed line-clamp-2 min-h-[2.5rem]">
        {plugin.manifest.description}
      </p>

      <div className="flex flex-wrap gap-1.5 items-center">
        {hasUpdate && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-950/40 text-amber-400 border border-amber-900 font-medium animate-pulse">
            ↑ Update {pendingUpdate!.latestVersion}
          </span>
        )}
        <PluginStatusBadge
          status={plugin.status}
          statusReasonCode={cloudBlocked ? CLOUD_BLOCK_REASON : plugin.statusReasonCode}
        />
        {plugin.categories.slice(0, 1).map((cat) => (
          <span
            key={cat}
            className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-600"
          >
            {cat}
          </span>
        ))}
      </div>

      {cloudBlocked && (
        <div className="rounded-md border border-amber-900/50 bg-amber-950/20 p-2 text-[10px] leading-relaxed text-amber-300">
          <p>
            Cloud plugin execution requires isolated workers. There is no
            operator override; self-hosting is the current recovery path.
          </p>
          <a
            className="mt-1 inline-block underline"
            href="/docs/guides/cloud-plugin-execution"
          >
            Read the cloud plugin execution policy
          </a>
        </div>
      )}

      <div className="flex items-center justify-between pt-2.5 border-t border-zinc-800">
        <div className="flex gap-1 flex-wrap">
          {(plugin.manifest.capabilities ?? []).slice(0, 3).map((cap) => (
            <span
              key={cap}
              className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-600"
            >
              {cap.split(".")[0]}
            </span>
          ))}
        </div>
        <span className="text-xs text-indigo-400 font-semibold whitespace-nowrap ml-2">
          {canManage ? (hasUpdate ? "Manage →" : "Configure →") : "View →"}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {canManage && hasUpdate && onApplyUpdate && !executionControlsBlocked && (
          <Button
            size="sm"
            variant="outline"
            aria-label={`Update ${plugin.manifest.displayName}`}
            disabled={isUpdating}
            onClick={onApplyUpdate}
          >
            {isUpdating ? "Updating..." : "Update"}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-label={`${
            canManage ? (hasUpdate ? "Manage" : "Configure") : "View"
          } ${plugin.manifest.displayName}`}
          onClick={onSelect}
        >
          {canManage ? (hasUpdate ? "Manage" : "Configure") : "View"}
        </Button>
      </div>
    </div>
  );
}

export function PluginsSection() {
  const { selectedCompanyId } = useCompany();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [permissionUpdate, setPermissionUpdate] = useState<{
    plugin: InstalledPlugin;
    update: PendingUpdate;
    version: string;
    delta: string[];
  } | null>(null);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { data: profile } = useQuery({
    queryKey: ["auth", "profile"],
    queryFn: profileApi.get,
  });
  const canManage = profile?.canManageInstanceSettings === true;

  const { data: installedPlugins, isLoading } = useQuery({
    queryKey: ["company-plugins", selectedCompanyId],
    queryFn: () => pluginsApi.listCompanyPlugins(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: pendingUpdates } = useQuery({
    queryKey: ["marketplace-updates", selectedCompanyId],
    queryFn: () => marketplaceApi.getUpdates(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const selectedPlugin =
    installedPlugins?.find((p) => p.id === selectedId) ?? null;

  const applyPluginUpdate = async (
    plugin: InstalledPlugin,
    update: PendingUpdate
  ) => {
    if (!selectedCompanyId) return;
    setUpdatingId(update.id);
    try {
      const result = await marketplaceApi.applyUpdate(
        selectedCompanyId,
        update.id
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["marketplace", "updates", selectedCompanyId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["marketplace-updates", selectedCompanyId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["company-plugins", selectedCompanyId],
        }),
      ]);
      if (result.status === "upgrade_pending" && result.delta?.length) {
        setPermissionUpdate({
          plugin,
          update,
          version: result.version ?? update.latestVersion,
          delta: result.delta,
        });
        pushToast({
          title: "Plugin permissions need approval",
          body: `${plugin.manifest.displayName} added new capabilities.`,
          tone: "info",
        });
        return;
      }
      pushToast({
        title: `Updated ${plugin.manifest.displayName}`,
        tone: "success",
      });
    } catch (err) {
      if (pluginsApi.isCloudPluginExecutionBlockedError(err)) {
        invalidatePluginUpdateState();
        pushToast({
          title: `${plugin.manifest.displayName} is blocked on AoA Cloud`,
          body: "The update was not installed because AoA Cloud requires isolated plugin workers.",
          tone: "info",
        });
        return;
      }
      pushToast({
        title: "Failed to apply update",
        body: err instanceof Error ? err.message : undefined,
        tone: "error",
      });
    } finally {
      setUpdatingId(null);
    }
  };

  if (isLoading) {
    return <div className="text-sm text-zinc-500 py-4">Loading plugins…</div>;
  }

  if (!installedPlugins || installedPlugins.length === 0) {
    return (
      <div className="space-y-3">
        <SectionHeader />
        <div className="border border-zinc-800 rounded-xl bg-zinc-900 py-10 text-center">
          <Puzzle className="h-8 w-8 text-zinc-700 mx-auto mb-3" />
          <p className="text-sm font-medium text-zinc-400">
            No plugins installed
          </p>
          <p className="text-xs text-zinc-600 mt-1 max-w-xs mx-auto">
            Install plugins from the Marketplace to get started.
          </p>
        </div>
      </div>
    );
  }

  const invalidatePluginUpdateState = () => {
    if (!selectedCompanyId) return;
    void queryClient.invalidateQueries({
      queryKey: ["company-plugins", selectedCompanyId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["marketplace-updates", selectedCompanyId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["marketplace", "updates", selectedCompanyId],
    });
  };

  return (
    <>
      <div className="flex gap-4">
        <div className="flex-1 space-y-3">
          <SectionHeader count={installedPlugins.length} />
          <div className="grid grid-cols-2 gap-3">
            {installedPlugins.map((plugin) => {
              const pendingUpdate = pendingUpdates?.find(
                (u) => u.catalogItemId === plugin.catalogItemId
              );
              return (
                <PluginCard
                  key={plugin.id}
                  plugin={plugin}
                  pendingUpdate={pendingUpdate}
                  selected={plugin.id === selectedId}
                  canManage={canManage}
                  onSelect={() =>
                    setSelectedId(plugin.id === selectedId ? null : plugin.id)
                  }
                  onApplyUpdate={
                    canManage && pendingUpdate
                      ? () => applyPluginUpdate(plugin, pendingUpdate)
                      : undefined
                  }
                  isUpdating={updatingId === pendingUpdate?.id}
                />
              );
            })}
          </div>
        </div>

        {selectedPlugin && (
          <PluginDetailSlideOver
            companyId={selectedCompanyId!}
            plugin={selectedPlugin}
            pendingUpdate={pendingUpdates?.find(
              (u) => u.catalogItemId === selectedPlugin.catalogItemId
            )}
            onClose={() => setSelectedId(null)}
            canManage={canManage}
          />
        )}
      </div>
      {canManage && permissionUpdate && selectedCompanyId && (
        <CapabilityDeltaModal
          companyId={selectedCompanyId}
          pluginId={permissionUpdate.plugin.id}
          pluginName={permissionUpdate.plugin.manifest.displayName}
          fromVersion={permissionUpdate.update.currentVersion}
          toVersion={permissionUpdate.version}
          delta={permissionUpdate.delta}
          onApproved={() => {
            setPermissionUpdate(null);
            invalidatePluginUpdateState();
          }}
          onCancelled={() => {
            setPermissionUpdate(null);
            invalidatePluginUpdateState();
          }}
        />
      )}
    </>
  );
}

function SectionHeader({ count }: { count?: number }) {
  return (
    <div className="space-y-1">
      <h2 className="text-base font-semibold text-zinc-100">
        Plugins
        {count !== undefined && (
          <span className="ml-2 text-xs font-normal text-zinc-500">
            ({count} installed)
          </span>
        )}
      </h2>
      <p className="text-sm text-zinc-500">
        Manage plugin configuration and updates for this company.
      </p>
    </div>
  );
}
