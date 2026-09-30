import { useMemo, useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Folder } from "lucide-react";
import { memoryFoldersApi } from "../../api/memoryFolders";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { useToast } from "../../context/ToastContext";
import { cn } from "@/lib/utils";

interface MoveToFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  itemId: string;
  currentFolderPath: string;
  currentDepartmentId: string | null;
  onMoved?: () => void;
}

export function MoveToFolderDialog({
  open,
  onOpenChange,
  companyId,
  itemId,
  currentFolderPath,
  onMoved,
}: MoveToFolderDialogProps) {
  const { pushToast } = useToast();
  const [selected, setSelected] = useState<string>(currentFolderPath);

  useEffect(() => {
    if (open) setSelected(currentFolderPath);
  }, [open, currentFolderPath]);

  const foldersQuery = useQuery({
    queryKey: queryKeys.memory.folders.list(companyId),
    queryFn: () => memoryFoldersApi.list(companyId),
    enabled: open,
  });

  const sortedFolders = useMemo(
    () =>
      (foldersQuery.data ?? [])
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path)),
    [foldersQuery.data],
  );

  const move = useMutation({
    mutationFn: (folderPath: string) =>
      memoryApi.moveItem(companyId, itemId, folderPath),
    onSuccess: () => {
      pushToast({ title: "Moved", tone: "success" });
      onMoved?.();
    },
    onError: (err) =>
      pushToast({
        title: err instanceof Error ? err.message : "Move failed",
        tone: "error",
      }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Move to folder</DialogTitle>
          <DialogDescription>
            Pick a destination folder. The item moves immediately.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="max-h-72 overflow-auto border border-border rounded-md">
          {foldersQuery.isLoading ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              Loading folders…
            </div>
          ) : sortedFolders.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No folders yet.
            </div>
          ) : (
            sortedFolders.map((f) => (
              <div
                key={f.id}
                onClick={() => setSelected(f.path)}
                className={cn(
                  "px-3 py-2 text-xs cursor-pointer flex items-center gap-2 border-b border-border last:border-b-0",
                  "hover:bg-muted/40",
                  selected === f.path && "bg-primary/10 text-primary",
                )}
              >
                <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium">{f.displayName}</span>
                <span className="text-muted-foreground">{f.path}</span>
              </div>
            ))
          )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={move.isPending}
          >
            Cancel
          </Button>
          <Button
            disabled={
              move.isPending || !selected || selected === currentFolderPath
            }
            onClick={() => move.mutate(selected)}
          >
            {move.isPending ? "Moving…" : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
