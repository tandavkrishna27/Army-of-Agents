/**
 * Modal shown when an upgrade introduces new capabilities.
 * User must explicitly approve or cancel.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as pluginsApi from "../../api/plugins.js";

const CAP_DESCRIPTIONS: Record<string, { icon: string; label: string; desc: string }> = {
  "storage.write": { icon: "💾", label: "storage.write", desc: "Write files to the plugin's private storage area" },
  "webhooks.listen": { icon: "🔗", label: "webhooks.listen", desc: "Register inbound webhook endpoints on this server" },
  "http.outbound": { icon: "🌐", label: "http.outbound", desc: "Make outbound HTTP requests to external services" },
  "agent.tools.register": { icon: "🔧", label: "agent.tools.register", desc: "Register tools that agents can invoke" },
  "jobs.schedule": { icon: "⏰", label: "jobs.schedule", desc: "Schedule recurring background jobs" },
};

interface Props {
  companyId: string;
  pluginId: string;
  pluginName: string;
  fromVersion: string;
  toVersion: string;
  delta: string[];
  onApproved: () => void;
  onCancelled: () => void;
}

export function CapabilityDeltaModal({
  companyId,
  pluginId,
  pluginName,
  fromVersion,
  toVersion,
  delta,
  onApproved,
  onCancelled,
}: Props) {
  const queryClient = useQueryClient();

  const approveMutation = useMutation({
    mutationFn: () => pluginsApi.approvePluginUpgrade(companyId, pluginId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["company-plugins", companyId] });
      onApproved();
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: () => pluginsApi.rollbackPluginUpgrade(companyId, pluginId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["company-plugins", companyId] });
      onCancelled();
    },
  });

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 max-w-md w-full shadow-2xl">
        <h2 className="text-base font-bold text-zinc-100 mb-1">New permissions required</h2>
        <p className="text-xs text-zinc-500 mb-4">
          Upgrading {pluginName} {fromVersion} → {toVersion}
        </p>

        <p className="text-sm text-zinc-400 mb-3">
          This version adds new capabilities to the plugin. Review them before approving.
        </p>

        <div className="space-y-2 mb-5">
          {delta.map((cap) => {
            const known = CAP_DESCRIPTIONS[cap];
            return (
              <div
                key={cap}
                className="flex items-start gap-3 bg-indigo-950/30 border border-indigo-900/40 rounded-lg p-3"
              >
                <span className="text-base mt-0.5">{known?.icon ?? "⚡"}</span>
                <div>
                  <div className="text-xs font-semibold text-indigo-300">
                    {known?.label ?? cap}
                  </div>
                  <div className="text-[10px] text-zinc-500 mt-0.5">
                    {known?.desc ?? "New capability granted to this plugin"}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => rollbackMutation.mutate()}
            disabled={rollbackMutation.isPending || approveMutation.isPending}
            className="flex-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-60 text-zinc-300 text-xs font-medium py-2.5 rounded-lg transition-colors"
          >
            {rollbackMutation.isPending ? "Rolling back…" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={() => approveMutation.mutate()}
            disabled={approveMutation.isPending || rollbackMutation.isPending}
            className="flex-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-xs font-semibold py-2.5 px-4 rounded-lg transition-colors"
          >
            {approveMutation.isPending ? "Approving…" : "Approve & Upgrade"}
          </button>
        </div>

        {(approveMutation.isError || rollbackMutation.isError) && (
          <p className="text-[10px] text-red-400 mt-2 text-center">
            {(approveMutation.error ?? rollbackMutation.error) instanceof Error
              ? (approveMutation.error ?? rollbackMutation.error)!.message
              : "Operation failed — try again"}
          </p>
        )}
      </div>
    </div>
  );
}
