import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUpdateFolderMutation } from "../../lib/memoryFolderMutations";
import type { MemoryFolderRecord } from "@armyofagents/shared";

interface RenameFolderDialogProps {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folder: MemoryFolderRecord;
}

export function RenameFolderDialog({
  companyId,
  open,
  onOpenChange,
  folder,
}: RenameFolderDialogProps) {
  const [name, setName] = useState(folder.displayName);
  const [icon, setIcon] = useState(folder.icon ?? "📂");
  const [error, setError] = useState<string | null>(null);

  const mutation = useUpdateFolderMutation(companyId);

  useEffect(() => {
    if (open) {
      setName(folder.displayName);
      setIcon(folder.icon ?? "📂");
      setError(null);
    }
  }, [open, folder.displayName, folder.icon]);

  async function handleSave() {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required");
      return;
    }
    try {
      await mutation.mutateAsync({
        id: folder.id,
        patch: { displayName: trimmed, icon },
      });
      onOpenChange(false);
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Failed to rename folder");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename folder</DialogTitle>
        </DialogHeader>
        {/* px-7 matches DialogHeader / DialogFooter inset. */}
        <div className="space-y-4 px-7 pb-5">
          <div className="space-y-1.5">
            <Label htmlFor="rename-name">Name</Label>
            <Input
              id="rename-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Icon</Label>
            <Input
              value={icon}
              onChange={(e) => setIcon(e.target.value.slice(0, 2))}
              className="w-16 text-center"
              maxLength={2}
            />
          </div>
          {error && (
            <div className="text-xs text-red-600 dark:text-red-400">{error}</div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!name.trim() || mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
