import { X, Bot } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TeamRole } from "@armyofagents/shared";

export type DraftMember = { agentId: string; name: string; role: TeamRole };

interface Props {
  member: DraftMember;
  onChange: (next: DraftMember) => void;
  onRemove: () => void;
}

export function MemberRow({ member, onChange, onRemove }: Props) {
  return (
    <div className="mb-2 rounded-md border bg-card p-2.5">
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent">
          <Bot className="h-3.5 w-3.5" />
        </div>
        <span className="min-w-0 flex-1 truncate text-xs font-bold">{member.name}</span>
        <Select
          value={member.role}
          onValueChange={(r) => onChange({ ...member, role: r as TeamRole })}
        >
          <SelectTrigger className="h-7 w-[100px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="lead">⭐ Lead</SelectItem>
            <SelectItem value="member">Member</SelectItem>
          </SelectContent>
        </Select>
        <button
          type="button"
          onClick={onRemove}
          className="text-muted-foreground hover:text-destructive"
          aria-label="Remove member"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
