import { cn } from "@/lib/utils";

export interface MarketplaceSubfilterOption {
  key: string;
  label: string;
  /** Optional count rendered as a dim suffix. */
  count?: number;
}

export interface MarketplaceSubfilterChipsProps {
  value: string;
  onChange: (next: string) => void;
  options: ReadonlyArray<MarketplaceSubfilterOption>;
  className?: string;
}

/**
 * Smaller "ghost" sub-filter chip row. Used on the marketplace hub for sort
 * mode (All / Featured / Recently added / A–Z) and reused on the package
 * detail page (Phase C) for flow stages (Think / Plan / Build / …).
 */
export function MarketplaceSubfilterChips({ value, onChange, options, className }: MarketplaceSubfilterChipsProps) {
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {options.map((opt) => {
        const isActive = value === opt.key;
        return (
          <button
            key={opt.key}
            type="button"
            data-active={isActive ? "true" : undefined}
            onClick={() => onChange(opt.key)}
            className={cn(
              "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11.5px] font-medium transition-colors",
              isActive
                ? "text-foreground bg-card-2"
                : "text-dim hover:text-foreground hover:bg-card",
            )}
          >
            <span>{opt.label}</span>
            {opt.count !== undefined && (
              <span className="opacity-60 text-[10.5px]">{opt.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
