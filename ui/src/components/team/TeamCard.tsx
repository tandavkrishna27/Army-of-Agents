import { Star, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ClickableDiv } from "@/components/ui/clickable-div";
import { cn } from "@/lib/utils";

export interface TeamCardData {
  id: string;
  name: string;
  slug: string;
  /**
   * Parent department name, or null for a company-wide team (D21 — the AoA
   * crew). Null is a real state, NOT an unresolvable id: it renders as a
   * distinct "Company-wide" pill so the crew doesn't read as a broken record.
   */
  parentProjectName: string | null;
  status: "active" | "archived";
  memberCount: number;
  leadName: string;
  memberInitials?: string[];
  iconColor?: string;
}

interface Props {
  team: TeamCardData;
  onClick: () => void;
  onMenuClick?: () => void;
}

export function TeamCard({ team, onClick, onMenuClick }: Props) {
  const accentColor = team.iconColor ?? "var(--data-indigo)";
  const initials = team.memberInitials ?? [];
  const visibleInitials = initials.slice(0, 3);
  const overflow = team.memberCount - visibleInitials.length;

  return (
    <ClickableDiv
      onClick={onClick}
      className="group relative flex flex-col gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors duration-150 hover:bg-accent/30 border-l-[3px]"
      style={{ borderLeftColor: accentColor }}
    >
      {/* Header: icon + name + dept badge + overflow menu */}
      <div className="flex items-start gap-2">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-sm font-bold text-white"
          style={{ backgroundColor: accentColor }}
        >
          {team.name.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="truncate text-sm font-semibold">{team.name}</h3>
            {team.parentProjectName === null ? (
              // Company-wide team (D21): not scoped to any department. Given its
              // own pill so it reads as a deliberate state rather than a
              // department badge that failed to resolve.
              <span className="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                Company-wide
              </span>
            ) : (
              <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                {team.parentProjectName}
              </span>
            )}
          </div>
        </div>
        {onMenuClick && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={(e) => {
              e.stopPropagation();
              onMenuClick();
            }}
            className="opacity-0 transition-opacity group-hover:opacity-100 shrink-0"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Footer: lead + avatar stack + status pill */}
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-xs text-muted-foreground min-w-0">
          <Star className="h-3 w-3 shrink-0 text-amber-500" />
          <span className="truncate">{team.leadName}</span>
        </span>

        <div className="flex items-center gap-2 shrink-0">
          {visibleInitials.length > 0 && (
            <div className="flex items-center">
              {visibleInitials.map((ini, i) => (
                <div
                  key={i}
                  className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-card bg-accent text-[10px] font-bold text-foreground"
                  style={{ marginLeft: i > 0 ? "-7px" : undefined }}
                >
                  {ini}
                </div>
              ))}
              {overflow > 0 && (
                <div
                  className="flex h-6 min-w-[1.5rem] items-center justify-center rounded-full border-2 border-card bg-muted px-1 text-[10px] font-mono text-muted-foreground"
                  style={{ marginLeft: "-7px" }}
                >
                  +{overflow}
                </div>
              )}
            </div>
          )}

          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
              team.status === "active"
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-muted text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                team.status === "active" ? "bg-emerald-500" : "bg-muted-foreground/50",
              )}
            />
            {team.status === "active" ? "Active" : "Archived"}
          </span>
        </div>
      </div>
    </ClickableDiv>
  );
}
