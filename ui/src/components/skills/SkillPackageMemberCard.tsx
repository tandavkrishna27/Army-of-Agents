// ui/src/components/skills/SkillPackageMemberCard.tsx
import { Link } from "@/lib/router";
import { FileText } from "lucide-react";
import type { CompanySkillListItem } from "@armyofagents/shared";
import { cn } from "@/lib/utils";

interface Props {
  skill: CompanySkillListItem;
  hasUpdate: boolean;
}

export function SkillPackageMemberCard({ skill, hasUpdate }: Props) {
  return (
    <Link
      to={`/skills/${skill.id}`}
      className={cn(
        "block rounded-lg border border-border bg-card p-3 no-underline hover:border-border-strong hover:bg-card/80",
        hasUpdate && "border-amber-500/30",
      )}
    >
      <div className="flex items-center gap-2">
        <FileText className="size-3.5 shrink-0 text-dim" />
        <span className="truncate text-[12.5px] font-medium text-text">{skill.name}</span>
        {hasUpdate && (
          <span
            title="Update available"
            className="ml-auto inline-flex items-center gap-1 rounded border border-amber-500/20 bg-amber-500/10 px-1 py-px text-[9px] font-medium text-amber-500"
          >
            <span aria-hidden className="size-1 rounded-full bg-amber-500" />
            upd
          </span>
        )}
      </div>
      {skill.description && (
        <p className="mt-1.5 line-clamp-2 text-[11.5px] text-dim">
          {skill.description}
        </p>
      )}
      <div className="mt-2 text-[10px] text-dim">
        Used by {skill.attachedAgentCount}
      </div>
    </Link>
  );
}
