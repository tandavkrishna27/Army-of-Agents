import type { HTMLAttributes } from "react";
import type { MarketplaceItemType } from "@armyofagents/shared";
import { cn } from "@/lib/utils";

const LABELS: Record<MarketplaceItemType, string> = {
  skill: "SKILL",
  plugin: "PLUGIN",
  agent: "AGENT",
  team: "TEAM",
};

export interface TypeChipProps extends HTMLAttributes<HTMLSpanElement> {
  type: MarketplaceItemType;
}

export function TypeChip({ type, className, ...props }: TypeChipProps) {
  const isPlugin = type === "plugin";

  return (
    <span
      className={cn(
        "uppercase text-[10px] tracking-[0.1em] font-semibold leading-none",
        isPlugin
          ? "inline-flex items-center rounded-full border border-blue-500/25 bg-blue-500/10 px-2 py-1 text-blue-400"
          : "text-very-dim",
        className,
      )}
      {...props}
    >
      {LABELS[type]}
    </span>
  );
}
