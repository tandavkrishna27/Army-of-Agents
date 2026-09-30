import { useState } from "react";
import { MoreVertical, Pin, PinOff, Pencil, Archive, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ConversationRow } from "../../api/internal-agent";

export interface SessionOverflowMenuProps {
  conversation: ConversationRow;
  onPin: (pinned: boolean) => void;
  onRename: (title: string) => void;
  onArchive: () => void;
  onDelete: () => void;
}

export function SessionOverflowMenu({
  conversation,
  onPin,
  onRename,
  onArchive,
  onDelete,
}: SessionOverflowMenuProps) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(conversation.title ?? "");

  function handleRenameOpen() {
    setRenameValue(conversation.title ?? "");
    setRenameOpen(true);
  }

  function handleRenameSave() {
    const trimmed = renameValue.trim();
    if (trimmed) {
      onRename(trimmed);
    }
    setRenameOpen(false);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-commander-touch
            onClick={(e) => e.stopPropagation()}
            className="flex items-center justify-center p-0.5 rounded hover:bg-black/10 transition-colors shrink-0 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto data-[state=open]:opacity-100 data-[state=open]:pointer-events-auto"
            title="More options"
          >
            <MoreVertical className="h-3.5 w-3.5 text-dim" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start">
          <DropdownMenuItem
            onSelect={() => onPin(!conversation.pinned)}
          >
            {conversation.pinned ? (
              <>
                <PinOff className="h-4 w-4" />
                Unpin
              </>
            ) : (
              <>
                <Pin className="h-4 w-4" />
                Pin
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleRenameOpen}>
            <Pencil className="h-4 w-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onArchive}>
            <Archive className="h-4 w-4" />
            Archive
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Rename dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Rename conversation</DialogTitle>
          </DialogHeader>
          <div className="px-7 py-2">
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleRenameSave();
                } else if (e.key === "Escape") {
                  setRenameOpen(false);
                }
              }}
              placeholder="Conversation title"
              autoFocus
              maxLength={200}
            />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleRenameSave}
              disabled={!renameValue.trim()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. The conversation and all its messages will
              be permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onDelete();
                setDeleteOpen(false);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
