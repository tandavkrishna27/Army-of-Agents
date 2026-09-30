import { useState } from "react";
import type { MarketplaceProviderRef } from "@armyofagents/shared";
import { cn } from "@/lib/utils";

export function ProviderLogo({
  provider,
  className,
}: {
  provider?: MarketplaceProviderRef | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const initials = provider?.fallbackInitials ?? "?";

  if (provider?.logoUrl && !failed) {
    return (
      <img
        src={provider.logoUrl}
        alt={`${provider.name} logo`}
        className={cn("size-10 rounded-lg border border-border bg-muted object-cover", className)}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span
      aria-label={provider ? `${provider.name} logo fallback` : "Provider logo fallback"}
      className={cn(
        "inline-flex size-10 items-center justify-center rounded-lg border border-border bg-muted text-xs font-semibold text-dim",
        className,
      )}
    >
      {initials}
    </span>
  );
}
