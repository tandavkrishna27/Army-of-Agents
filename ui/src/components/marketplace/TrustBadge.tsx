import { Star } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TRUST_TIER_CONFIG } from "@/lib/marketplace-constants";
import { cn } from "@/lib/utils";

export interface TrustBadgeProps {
  tier: keyof typeof TRUST_TIER_CONFIG;
  className?: string;
  /** Show the tier label text. Defaults to true. Pass false for compact (stars-only) display. */
  showLabel?: boolean;
}

/**
 * Pill-style badge showing trust tier with Radix Tooltip explaining meaning.
 *
 * Accessibility:
 *   - Color (visible) + star count (visible) + sr-only description (screen reader)
 *   - Tooltip provides hover/focus context
 *   - Tier name is the visible label (hidden in compact mode)
 */
export function TrustBadge({ tier, className, showLabel = true }: TrustBadgeProps) {
  const config = TRUST_TIER_CONFIG[tier];

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
              config.colorClass,
              className,
            )}
          >
            <span className="flex" aria-hidden="true">
              {Array.from({ length: config.starCount }).map((_, i) => (
                <Star key={i} className="h-3 w-3 fill-current" />
              ))}
            </span>
            {showLabel && config.label}
            <span className="sr-only">{config.description}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs max-w-xs">{config.description}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
