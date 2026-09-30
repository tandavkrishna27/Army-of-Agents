import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface CockpitSectionProps {
  id: string;
  title: string;
  summary?: string | null;
  icon: LucideIcon;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: ReactNode;
}

export function CockpitSection({
  id,
  title,
  summary,
  icon: Icon,
  open,
  onOpenChange,
  children,
}: CockpitSectionProps) {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="w-full min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-card"
      data-testid={`cockpit-section-${id}`}
    >
      <CollapsibleTrigger
        className="grid w-full min-w-0 grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 overflow-hidden px-2.5 py-2 text-left transition-colors hover:bg-muted/50"
        data-testid={`cockpit-section-trigger-${id}`}
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-muted/30 text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-xs font-semibold text-foreground">{title}</span>
          <span
            className="block h-4 truncate text-[11px] leading-4 text-muted-foreground"
            data-testid={`cockpit-section-summary-${id}`}
            aria-hidden={summary ? undefined : "true"}
          >
            {summary ?? ""}
          </span>
        </span>
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="min-w-0 max-w-full overflow-hidden">
        <div className="min-w-0 max-w-full overflow-hidden border-t border-border px-2.5 py-2">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
