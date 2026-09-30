import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useDeleteFolderMutation } from "../../lib/memoryFolderMutations";
import type { MemoryFolderRecord } from "@armyofagents/shared";

interface DeleteFolderDialogProps {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folder: MemoryFolderRecord;
  /** Display path of parent (e.g., "📁 Engineering") for the reparenting message. */
  parentDisplayPath: string;
  /** Number of memory items inside this folder (direct + descendants). */
  childItemCount: number;
  /** Number of sub-folders inside this folder (direct + descendants). */
  childFolderCount: number;
}

export function DeleteFolderDialog({
  companyId,
  open,
  onOpenChange,
  folder,
  parentDisplayPath,
  childItemCount,
  childFolderCount,
}: DeleteFolderDialogProps) {
  const mutation = useDeleteFolderMutation(companyId);

  async function handleDelete() {
    try {
      await mutation.mutateAsync(folder.id);
      onOpenChange(false);
    } catch {
      // Mutation error surface is handled at the toast level (later); for v1
      // we just close the dialog and let the user retry.
      onOpenChange(false);
    }
  }

  const hasContents = childItemCount > 0 || childFolderCount > 0;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete folder &ldquo;{folder.displayName}&rdquo;?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              {hasContents && (
                <>
                  <div>This folder contains:</div>
                  <ul className="list-disc list-inside ml-1">
                    {childItemCount > 0 && (
                      <li>
                        {childItemCount} memory{" "}
                        {childItemCount === 1 ? "item" : "items"}
                      </li>
                    )}
                    {childFolderCount > 0 && (
                      <li>
                        {childFolderCount} sub-{childFolderCount === 1 ? "folder" : "folders"}
                      </li>
                    )}
                  </ul>
                  <div>
                    Items and sub-folders will be moved to{" "}
                    <strong>{parentDisplayPath}</strong>.
                  </div>
                </>
              )}
              <div className="text-muted-foreground">This cannot be undone.</div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={mutation.isPending}
            className="bg-red-600 hover:bg-red-700 text-white"
          >
            {mutation.isPending ? "Deleting…" : "Delete folder"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
