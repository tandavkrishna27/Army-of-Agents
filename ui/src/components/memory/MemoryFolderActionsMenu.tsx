import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type MemoryFolderNodeKind =
  | "userFolder"     // user-created — full menu
  | "seededFolder"   // seedKey IS NOT NULL — only New subfolder
  | "scope"          // dept / Company / goal — only New subfolder
  ;

interface MemoryFolderActionsMenuProps {
  nodeKind: MemoryFolderNodeKind;
  onCreate: () => void;
  onRename: () => void;
  onChangeIcon: () => void;
  onDelete: () => void;
}

export function MemoryFolderActionsMenu({
  nodeKind,
  onCreate,
  onRename,
  onChangeIcon,
  onDelete,
}: MemoryFolderActionsMenuProps) {
  const isMutable = nodeKind === "userFolder";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
          aria-label="Folder actions"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={onCreate}>
          + New subfolder
        </DropdownMenuItem>
        {isMutable && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onRename}>Rename</DropdownMenuItem>
            <DropdownMenuItem onSelect={onChangeIcon}>Change icon</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={onDelete}
              className="text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-900/20"
            >
              Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
