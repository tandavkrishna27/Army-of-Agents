import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ShieldCheck } from "lucide-react";
import type { TeamUninstallResult } from "../../api/marketplace";

/**
 * Acknowledgement dialog shown after a marketplace team (crew) uninstall.
 *
 * The uninstall destroys the crew's member agents EXCEPT protected ones
 * (Commander, Steward), which are detached and kept. This dialog is the UI half
 * of that contract (task #33): it names the retained agents and *why* each was
 * kept, so the founder is never surprised that some agents survived — the
 * server-side `retainedAgents` was previously reported over the wire but nothing
 * surfaced it. Acknowledge-only (no cancel); closing calls {@link onClose}.
 */
export function CrewUninstallResultDialog({
  result,
  open,
  onClose,
}: {
  result: TeamUninstallResult | null;
  open: boolean;
  onClose: () => void;
}) {
  const retained = result?.retainedAgents ?? [];
  const deletedCount = result?.deletedAgentIds.length ?? 0;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <AlertDialogContent data-testid="crew-uninstall-result">
        <AlertDialogHeader>
          <AlertDialogTitle>Crew uninstalled</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm">
              <p>
                Removed {deletedCount} crew agent{deletedCount === 1 ? "" : "s"}.
              </p>
              {retained.length > 0 && (
                <div className="rounded-md border border-border bg-muted/30 p-3">
                  <p className="flex items-center gap-1.5 font-medium text-foreground">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
                    {retained.length} protected agent{retained.length === 1 ? "" : "s"} kept
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {retained.map((agent) => (
                      <li key={agent.id} data-testid="retained-agent">
                        <span className="font-medium text-foreground">{agent.name}</span>
                        <span className="text-muted-foreground"> — {agent.why}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* AlertDialogAction closes the dialog on click, which fires
              onOpenChange(false) → onClose. No explicit onClick, or onClose
              would fire twice (double navigate). */}
          <AlertDialogAction>Done</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
