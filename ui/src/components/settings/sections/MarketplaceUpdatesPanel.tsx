import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle } from "lucide-react";

import { ApiError } from "@/api/client";
import { marketplaceApi, type PendingUpdate } from "@/api/marketplace";
import { PageSkeleton } from "@/components/PageSkeleton";
import { SnapshotUpdateModal } from "@/components/marketplace/SnapshotUpdateModal";
import { UpdateCard } from "@/components/marketplace/UpdateCard";
import { CapabilityDeltaModal } from "@/components/settings/CapabilityDeltaModal";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { useDismissUpdate, usePendingUpdates } from "@/hooks/usePendingUpdates";
import { useCloudPluginExecutionPolicy } from "@/hooks/useCloudPluginExecutionPolicy";

/**
 * The two `/apply` 409 codes that mean "your local copy diverges — merge it",
 * as opposed to the bare 409 for a row that is simply no longer pending.
 */
const CUSTOMIZED_CONFLICT_CODES = new Set([
  "AGENT_INSTRUCTIONS_CUSTOMIZED",
  "SKILL_CUSTOMIZED",
]);

function isCustomizedConflict(err: ApiError): boolean {
  const code = (err.body as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && CUSTOMIZED_CONFLICT_CODES.has(code);
}

const TYPE_LABELS: Record<string, string> = {
  skill: "Skills",
  agent: "Agents",
  team: "Teams",
  plugin: "Plugins",
};

export function MarketplaceUpdatesPanel() {
  const { selectedCompany } = useCompany();
  const { data: updates, isLoading } = usePendingUpdates();
  const dismiss = useDismissUpdate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const cloudPluginPolicy = useCloudPluginExecutionPolicy();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reviewUpdate, setReviewUpdate] = useState<PendingUpdate | null>(null);
  const [permissionUpdate, setPermissionUpdate] = useState<{
    update: PendingUpdate;
    pluginId: string;
    version: string;
    delta: string[];
  } | null>(null);

  const pending = useMemo(
    () =>
      (updates ?? []).filter(
        (update) => update.status === "pending" || update.status === "conflict"
      ),
    [updates]
  );

  const grouped = useMemo(
    () =>
      pending.reduce<Record<string, PendingUpdate[]>>((acc, update) => {
        if (!acc[update.itemType]) acc[update.itemType] = [];
        acc[update.itemType]!.push(update);
        return acc;
      }, {}),
    [pending]
  );

  const invalidateUpdates = async () => {
    if (!selectedCompany?.id) return;
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["marketplace", "updates", selectedCompany.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["marketplace-updates", selectedCompany.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["company-plugins", selectedCompany.id],
      }),
    ]);
  };

  /**
   * One-click apply. Works for plugins, skills and agents — `/apply` handles
   * all three server-side, and only TEAM updates still answer 501.
   *
   * Offered only for `pending` rows. A `conflict` row is one whose local copy
   * diverges (or may diverge) from the catalog; `/apply` would answer 409 for
   * it, so it goes straight to Review. The 409 is still handled below because
   * the status can go stale between the list render and the click.
   */
  const applyUpdate = async (update: PendingUpdate) => {
    if (!selectedCompany?.id) return;
    if (update.itemType === "plugin" && cloudPluginPolicy.controlsBlocked)
      return;
    setBusyId(update.id);
    try {
      const result = await marketplaceApi.applyUpdate(
        selectedCompany.id,
        update.id
      );
      await invalidateUpdates();
      if (
        result.status === "upgrade_pending" &&
        result.pluginId &&
        result.delta?.length
      ) {
        setPermissionUpdate({
          update,
          pluginId: result.pluginId,
          version: result.version ?? update.latestVersion,
          delta: result.delta,
        });
        pushToast({
          title: "Plugin permissions need approval",
          body: `${update.catalogItemName} added new capabilities.`,
          tone: "info",
        });
        return;
      }
      pushToast({
        title: `Updated ${update.catalogItemName}`,
        tone: "success",
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        pushToast({
          title: "Only instance admins can update plugins",
          body: `Ask an instance admin to apply the ${update.catalogItemName} plugin update.`,
          tone: "error",
        });
        return;
      }
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        isCustomizedConflict(err)
      ) {
        // Local edits are in the way — the status went stale between render and
        // click. Hand the founder straight to the review they actually need
        // rather than making them find the other button.
        //
        // Keyed on the response CODE, not on 409 alone: `/apply` also answers
        // 409 for a row that is simply no longer pending (already applied
        // elsewhere), which is not a merge situation and has no diff to show.
        await invalidateUpdates();
        setReviewUpdate(update);
        pushToast({
          title: "Local changes found",
          body: `Review the changes to ${update.catalogItemName} before applying.`,
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
      setBusyId(null);
    }
  };

  const dismissPendingUpdate = async (update: PendingUpdate) => {
    setBusyId(update.id);
    try {
      await dismiss.mutateAsync(update.id);
      await invalidateUpdates();
    } catch (err) {
      pushToast({
        title: "Failed to dismiss update",
        body: err instanceof Error ? err.message : undefined,
        tone: "error",
      });
    } finally {
      setBusyId(null);
    }
  };

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (!selectedCompany) {
    return (
      <div className="space-y-3">
        <UpdatesHeader />
        <p className="text-sm text-muted-foreground">
          Select a company to review marketplace updates.
        </p>
      </div>
    );
  }

  if (pending.length === 0) {
    return (
      <div className="space-y-4">
        <UpdatesHeader />
        <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-border px-4 py-12 text-center">
          <CheckCircle className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">
            All marketplace items are up to date
          </p>
          <p className="max-w-md text-xs text-muted-foreground">
            Installed plugins, skills, agents, and teams will appear here when
            newer marketplace versions are available.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <UpdatesHeader />
        {Object.entries(grouped).map(([type, items]) => (
          <section key={type} className="space-y-3">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {TYPE_LABELS[type] ?? type} · {items.length}
            </h4>
            <div className="space-y-2">
              {items.map((update) => (
                <div key={update.id} className="space-y-1">
                  <UpdateCard
                    update={update}
                    isPending={busyId === update.id}
                    onApply={
                      (update.itemType === "plugin" &&
                        !cloudPluginPolicy.controlsBlocked) ||
                      (update.itemType !== "plugin" &&
                        update.status === "pending")
                        ? () => applyUpdate(update)
                        : undefined
                    }
                    onReview={
                      update.itemType !== "plugin"
                        ? () => setReviewUpdate(update)
                        : undefined
                    }
                    onDismiss={() => dismissPendingUpdate(update)}
                  />
                  {update.itemType === "plugin" &&
                    cloudPluginPolicy.controlsBlocked && (
                      <p
                        className="px-1 text-xs text-muted-foreground"
                        role="status"
                      >
                        {cloudPluginPolicy.isCloud
                          ? "Plugin updates are unavailable on AoA Cloud."
                          : "Plugin updates are unavailable until deployment policy is verified."}
                      </p>
                    )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      {reviewUpdate && (
        <SnapshotUpdateModal
          open
          onClose={() => setReviewUpdate(null)}
          companyId={selectedCompany.id}
          updateId={reviewUpdate.id}
          itemName={reviewUpdate.catalogItemName}
        />
      )}
      {permissionUpdate && selectedCompany && (
        <CapabilityDeltaModal
          companyId={selectedCompany.id}
          pluginId={permissionUpdate.pluginId}
          pluginName={permissionUpdate.update.catalogItemName}
          fromVersion={permissionUpdate.update.currentVersion}
          toVersion={permissionUpdate.version}
          delta={permissionUpdate.delta}
          onApproved={() => {
            setPermissionUpdate(null);
            void invalidateUpdates();
          }}
          onCancelled={() => {
            setPermissionUpdate(null);
            void invalidateUpdates();
          }}
        />
      )}
    </>
  );
}

function UpdatesHeader() {
  return (
    <div>
      <h3 className="text-base font-semibold">Marketplace updates</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Review pending updates for installed catalog items in this company.
      </p>
    </div>
  );
}
