import { useNavigate } from "@/lib/router";
import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCompany } from "../../context/CompanyContext";

interface DepartmentTileProps {
  label: string;
  icon?: string | LucideIcon;
  itemCount: number;
  pendingCount: number;
  /** Path to navigate to when the tile is clicked. Auto-prefixed with companyPrefix. */
  to: string;
}

export function DepartmentTile({ label, icon, itemCount, pendingCount, to }: DepartmentTileProps) {
  const navigate = useNavigate();
  const { selectedCompany } = useCompany();
  const companyPrefix = (selectedCompany as { issuePrefix?: string } | null)?.issuePrefix ?? "";
  // Lucide v3+ icons are forwardRef objects (typeof === "object"), not plain functions.
  // Accept both for safety.
  const Icon: LucideIcon | null =
    icon != null && (typeof icon === "function" || (typeof icon === "object" && "$$typeof" in (icon as object)))
      ? (icon as LucideIcon)
      : null;

  return (
    <button
      onClick={() => navigate(`/${companyPrefix}${to}`)}
      className={cn(
        "text-left p-4 rounded-md border border-border bg-card",
        "hover:border-primary/50 hover:shadow-md transition-all duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <div className="flex items-center gap-2 mb-2">
        {Icon ? (
          <Icon className="h-4 w-4 text-muted-foreground" />
        ) : (
          <span className="text-base leading-none">{(icon as string | undefined) ?? "📁"}</span>
        )}
        <div className="font-medium text-sm">{label}</div>
      </div>
      <div className="text-[11px] text-muted-foreground">
        {itemCount} {itemCount === 1 ? "item" : "items"}
      </div>
      {pendingCount > 0 && (
        <div className="text-[11px] text-amber-700 dark:text-amber-300 mt-1">
          ⏳ {pendingCount} pending
        </div>
      )}
    </button>
  );
}
