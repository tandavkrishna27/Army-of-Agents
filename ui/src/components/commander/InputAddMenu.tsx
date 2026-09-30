import { Plus, Wand2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface InputAddMenuProps {
  onUseSkill: () => void;
  disabled?: boolean;
}

/**
 * Commander's extras menu. Mock v2: "Attach file" is REMOVED — 📎 in the
 * shared toolbar is the only attach entry. The trigger is a quiet ghost
 * button (same visual weight as the other toolbar icons), not a filled
 * brand circle; the red accent belongs to the Send action alone.
 */
export function InputAddMenu({ onUseSkill, disabled = false }: InputAddMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Add"
          className={cn(
            "size-8 rounded-md flex items-center justify-center shrink-0",
            "text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors",
            "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-focus-ring",
            "disabled:opacity-40 disabled:pointer-events-none",
          )}
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start">
        <DropdownMenuItem onSelect={onUseSkill}>
          <Wand2 className="size-4" aria-hidden="true" />
          Use a skill
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
