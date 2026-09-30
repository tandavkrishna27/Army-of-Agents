import { Link } from "react-router-dom";
import { BadgeCheck, Github, Sparkles } from "lucide-react";
import type { MarketplacePackage } from "@armyofagents/shared";
import { Button } from "@/components/ui/button";
import { shortSource, authorFromSource } from "@/lib/marketplace-constants";
import { StackedIcon } from "./StackedIcon";
import { ProviderLogo } from "./ProviderLogo";

export interface PackageCardProps {
  pkg: MarketplacePackage;
  onInstallAll?: (pkg: MarketplacePackage) => void;
}

/**
 * Stable URL for a package detail page. Package IDs may contain a slash
 * (e.g. `garrytan/gstack` for synthesized packages), and the route
 * `/marketplace/package/:id/*` uses a splat to capture the trailing segment.
 */
export function packageDetailUrl(pkg: MarketplacePackage): string {
  return `/marketplace/package/${pkg.id}`;
}

export function PackageCard({ pkg, onInstallAll }: PackageCardProps) {
  const repoShort = shortSource(pkg.sourceUrl, pkg.id);
  const author = pkg.provider?.name ?? authorFromSource(pkg.sourceUrl);

  return (
    <div className="relative">
      <Link
        to={packageDetailUrl(pkg)}
        className="block hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl"
      >
        <div className="relative card-hover rounded-xl border border-border-strong bg-card overflow-hidden p-4">
          <span
            data-testid="package-type-badge"
            className="absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-1 uppercase text-[10px] tracking-[0.1em] font-semibold text-amber-400 leading-none"
          >
            <span>PACKAGE</span>
            <span className="h-3 w-px bg-amber-500/30" aria-hidden />
            <span className="tracking-normal" aria-label={`${pkg.count} items`}>
              {pkg.count}
            </span>
          </span>

          <div className="flex items-start gap-3 pr-28 sm:pr-36">
            {pkg.provider ? (
              <ProviderLogo provider={pkg.provider} className="size-12 shrink-0 rounded-2xl" />
            ) : (
              <div data-testid="package-stacked-avatar" className="size-12 shrink-0">
                <StackedIcon icon={Sparkles} tone="amber" className="size-12" />
              </div>
            )}
            <div className="min-w-0 flex-1 mt-0.5">
              <div data-testid="package-title-row" className="flex min-w-0 items-center gap-1.5">
                <h3 className="min-w-0 truncate text-[1.05rem] font-semibold tracking-tight">
                  {pkg.name}
                </h3>
                {pkg.verified && (
                  <BadgeCheck
                    data-testid="package-verified"
                    className="size-4 shrink-0 text-[hsl(208_80%_60%)]"
                    aria-label="Verified"
                  />
                )}
              </div>
              <div className="mt-0.5 text-[12px] text-very-dim truncate">by {author}</div>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0 text-[11.5px] text-very-dim">
              <Github className="size-3 shrink-0" />
              <span className="truncate">{repoShort}</span>
            </div>
            <Button
              size="sm"
              className="text-[11.5px] h-7 px-3 shrink-0"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onInstallAll?.(pkg);
              }}
            >
              Install all
            </Button>
          </div>
        </div>
      </Link>
    </div>
  );
}
