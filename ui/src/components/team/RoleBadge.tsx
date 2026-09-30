import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { UserRole } from "@armyofagents/shared";

const ROLE_STYLES: Record<UserRole, string> = {
  founder: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  team_lead: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  team_member: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
};

const ROLE_LABELS: Record<UserRole, string> = {
  founder: "Founder",
  team_lead: "Team Lead",
  team_member: "Team Member",
};

interface RoleBadgeProps {
  role: UserRole;
  className?: string;
}

/**
 * Small badge that renders a user role with role-specific tinting.
 * Replaces the inline `ROLE_STYLES` map previously duplicated in HumansTab.
 */
export function RoleBadge({ role, className }: RoleBadgeProps) {
  return (
    <Badge variant="secondary" className={cn("border-0 text-[10px]", ROLE_STYLES[role], className)}>
      {ROLE_LABELS[role]}
    </Badge>
  );
}
