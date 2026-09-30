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
import { useCreateFolderMutation } from "../../lib/memoryFolderMutations";

interface CreateFolderDialogProps {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Stored path of the parent (e.g., "engineering"). For top-level under a layer, "Company". */
  parentPath: string;
  /** Display string for the dialog header (e.g., "Domain / Engineering"). */
  parentDisplayPath?: string;
  /** The parent's departmentId — inherited by the new folder. null for Company / Active Context. */
  parentDepartmentId: string | null;
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function CreateFolderDialog({
  companyId,
  open,
  onOpenChange,
  parentPath,
  parentDisplayPath,
  parentDepartmentId,
}: CreateFolderDialogProps) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("📂");
  const [error, setError] = useState<string | null>(null);

  const mutation = useCreateFolderMutation(companyId);

  // Reset state on open change
  useEffect(() => {
    if (open) {
      setName("");
      setIcon("📂");
      setError(null);
    }
  }, [open]);

  async function handleCreate() {
    setError(null);
    const slug = slugify(name);
    if (!slug) {
      setError("Name must contain at least one alphanumeric character");
      return;
    }
    const newPath = parentPath ? `${parentPath}/${slug}` : slug;
    try {
      await mutation.mutateAsync({
        path: newPath,
        displayName: name.trim(),
        icon,
        departmentId: parentDepartmentId,
      });
      onOpenChange(false);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 409) {
        setError("A folder with this name already exists at this level");
      } else {
        setError(e.message ?? "Failed to create folder");
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
        </DialogHeader>
        {/* px-7 matches DialogHeader / DialogFooter inset so fields don't
            sit flush against the dialog edge. */}
        <div className="space-y-4 px-7 pb-5">
          <div className="text-xs text-muted-foreground">
            In: {parentDisplayPath ?? parentPath ?? "(root)"}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="folder-name">Name</Label>
            <Input
              id="folder-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Folder name"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Icon</Label>
            <div className="flex items-center gap-2">
              <Input
                value={icon}
                onChange={(e) => setIcon(e.target.value.slice(0, 2))}
                className="w-16 text-center"
                maxLength={2}
              />
              <span className="text-xs text-muted-foreground">
                Paste any emoji, or leave default 📂
              </span>
            </div>
          </div>
          {error && (
            <div className="text-xs text-red-600 dark:text-red-400">{error}</div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!name.trim() || mutation.isPending}
          >
            {mutation.isPending ? "Creating…" : "Create folder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
