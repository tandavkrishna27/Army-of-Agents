// ui/src/components/skills/DeleteSkillModal.tsx
import { Trash2 } from "lucide-react";
import type { CompanySkillDetail } from "@armyofagents/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skill: CompanySkillDetail | null | undefined;
  onConfirm: () => void;
  pending: boolean;
}

export function DeleteSkillModal({ open, onOpenChange, skill, onConfirm, pending }: Props) {
  if (!skill) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Delete skill</DialogTitle>
          <DialogDescription>
            This will permanently remove <strong>{skill.name}</strong> from the library and detach
            it from{" "}
            {skill.attachedAgentCount === 0
              ? "no agents"
              : skill.attachedAgentCount === 1
                ? "1 agent"
                : `${skill.attachedAgentCount} agents`}
            . This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {skill.usedByAgents.length > 0 && (
          <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <span className="font-medium">Agents that will lose this skill:</span>{" "}
            {skill.usedByAgents.map((a) => a.name).join(", ")}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            {pending ? "Deleting..." : "Delete skill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
