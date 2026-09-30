import { Link } from "@/lib/router";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import type { MarketplaceProviderRef } from "@armyofagents/shared";
import { cn } from "@/lib/utils";
import { ProviderLogo } from "@/components/marketplace/ProviderLogo";

interface Props {
  packageId: string;
  name: string;
  count: number;
  provider?: MarketplaceProviderRef | null;
  expanded: boolean;
  hasUpdate: boolean;
  active: boolean;
  onToggleExpand: (packageId: string) => void;
}

export function SkillPackageRow({
  packageId,
  name,
  count,
  provider,
  expanded,
  hasUpdate,
  active,
  onToggleExpand,
}: Props) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const chevronName = expanded ? "chevron-down" : "chevron-right";
  return (
    <div
      className={cn(
        "group relative flex items-center gap-2 px-3 py-2 text-[12.5px]",
        "text-foreground/85 hover:bg-accent hover:text-accent-foreground",
        active && "bg-accent text-accent-foreground",
      )}
    >
      {provider ? (
        <ProviderLogo provider={provider} className="size-5 shrink-0 rounded-md" />
      ) : (
        <Sparkles className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <Link
        to={`/skills/package/${packageId}`}
        className="min-w-0 flex-1 truncate font-medium no-underline text-current hover:text-text"
      >
        {name}
      </Link>
      {hasUpdate && (
        <span
          title="Update available"
          className="inline-flex items-center gap-1 rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-px text-[10px] font-medium text-amber-500"
        >
          <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
          upd
        </span>
      )}
      <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
        {count}
      </span>
      <button
        type="button"
        aria-label={expanded ? `Collapse ${name}` : `Expand ${name}`}
        onClick={() => onToggleExpand(packageId)}
        className="flex size-5 shrink-0 items-center justify-center rounded text-dim hover:bg-muted hover:text-text"
      >
        <Chevron data-icon={chevronName} className="size-3.5" />
      </button>
    </div>
  );
}
