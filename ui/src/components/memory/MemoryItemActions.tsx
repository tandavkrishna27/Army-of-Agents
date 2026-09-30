import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, FolderInput, Pin, PinOff, Layers } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { useToast } from "../../context/ToastContext";
import { MoveToFolderDialog } from "./MoveToFolderDialog";
import { ChangeLayerDialog } from "./ChangeLayerDialog";
import type { MemoryItem } from "@armyofagents/shared";

interface MemoryItemActionsProps {
  companyId: string;
  itemId: string;
  currentFolderPath: string;
  currentDepartmentId: string | null;
  founderPinnedToTop: boolean;
  item: MemoryItem;
}

export function MemoryItemActions({
  companyId,
  itemId,
  currentFolderPath,
  currentDepartmentId,
  founderPinnedToTop,
  item,
}: MemoryItemActionsProps) {
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const [moveOpen, setMoveOpen] = useState(false);
  const [changeLayerOpen, setChangeLayerOpen] = useState(false);

  function invalidateAll() {
    void qc.invalidateQueries({ queryKey: queryKeys.memory.detail(companyId, itemId) });
    void qc.invalidateQueries({ queryKey: queryKeys.memory.list(companyId) });
  }

  const pin = useMutation({
    mutationFn: () => memoryApi.setPinnedToTop(companyId, itemId, !founderPinnedToTop),
    onSuccess: () => {
      pushToast({
        title: founderPinnedToTop ? "Unpinned" : "Pinned to top",
        tone: "success",
      });
      invalidateAll();
    },
    onError: (err) =>
      pushToast({
        title: err instanceof Error ? err.message : "Pin failed",
        tone: "error",
      }),
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label="More actions"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setMoveOpen(true)} className="gap-2">
            <FolderInput className="h-3.5 w-3.5" />
            Move to folder…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setChangeLayerOpen(true)} className="gap-2">
            <Layers className="h-3.5 w-3.5" />
            Change layer
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => pin.mutate()}
            disabled={pin.isPending}
            className="gap-2"
          >
            {founderPinnedToTop ? (
              <>
                <PinOff className="h-3.5 w-3.5" /> Unpin from top
              </>
            ) : (
              <>
                <Pin className="h-3.5 w-3.5" /> Pin to top
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </DropdownMenuContent>
      </DropdownMenu>
      <MoveToFolderDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        companyId={companyId}
        itemId={itemId}
        currentFolderPath={currentFolderPath}
        currentDepartmentId={currentDepartmentId}
        onMoved={() => {
          setMoveOpen(false);
          invalidateAll();
        }}
      />
      <ChangeLayerDialog
        companyId={companyId}
        open={changeLayerOpen}
        onOpenChange={setChangeLayerOpen}
        item={item}
      />
    </>
  );
}
