/**
 * @fileoverview PluginRollbackButton — per-plugin rollback action in PluginManager.
 *
 * Opens a confirmation Dialog that shows the current and previous versions,
 * then calls POST /api/plugins/:id/rollback on confirmation. Query cache is
 * invalidated on success so the plugin list refreshes automatically.
 *
 * @see ui/src/pages/PluginManager.tsx — consumed here
 * @see ui/src/api/plugins.ts — pluginsApi.listVersionHistory + pluginsApi.rollback
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  isCloudPluginExecutionBlockedError,
  pluginsApi,
} from "@/api/plugins";
import { useToast } from "@/context/ToastContext";

interface PluginRollbackButtonProps {
  pluginId: string;
  currentVersion: string;
}

export function PluginRollbackButton({ pluginId, currentVersion }: PluginRollbackButtonProps) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { pushToast } = useToast();

  const { data: history } = useQuery({
    queryKey: ["plugins", pluginId, "version-history"],
    queryFn: () => pluginsApi.listVersionHistory(pluginId),
    enabled: open,
  });

  const rollbackMutation = useMutation({
    mutationFn: () => pluginsApi.rollback(pluginId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plugins"] });
      pushToast({ title: "Plugin rolled back successfully", tone: "success" });
      setOpen(false);
    },
    onError: (err: Error) => {
      if (isCloudPluginExecutionBlockedError(err)) {
        qc.invalidateQueries({ queryKey: ["plugins"] });
        pushToast({
          title: "Plugin is blocked on AoA Cloud",
          body: "Rollback is blocked on AoA Cloud until isolated plugin workers are available.",
          tone: "info",
        });
        setOpen(false);
        return;
      }
      pushToast({ title: "Rollback failed", body: err.message, tone: "error" });
    },
  });

  const previousVersion =
    history && history.length > 0 ? history[history.length - 1]?.version : undefined;
  const hasHistory = !!previousVersion;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="icon-sm"
          className="h-8 w-8"
          disabled={!hasHistory}
          title={hasHistory ? `Roll back to ${previousVersion}` : "No rollback available"}
        >
          <RotateCcw className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Roll back plugin</DialogTitle>
          <DialogDescription>
            Roll back from <strong>{currentVersion}</strong> to{" "}
            <strong>{previousVersion}</strong>? The plugin will restart at the previous
            version.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => rollbackMutation.mutate()}
            disabled={rollbackMutation.isPending}
          >
            {rollbackMutation.isPending ? "Rolling back…" : "Roll back"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
