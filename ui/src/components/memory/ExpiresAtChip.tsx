import { cn } from "@/lib/utils";

export type ExpiresAtTier = "expired" | "today" | "soon" | "distant";

/**
 * Compute the visual tier for an `expiresAt` date relative to now.
 * Returns null when no expiry is set.
 */
export function expiresAtTier(
  expiresAt: Date | string | null | undefined,
): ExpiresAtTier | null {
  if (!expiresAt) return null;
  const target = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(target.getTime())) return null;

  const ms = target.getTime() - Date.now();
  const days = ms / (1000 * 60 * 60 * 24);

  if (ms <= 0) return "expired";
  if (days < 1) return "today";
  if (days < 7) return "soon";
  return "distant";
}

interface ExpiresAtChipProps {
  expiresAt: Date | string | null | undefined;
}

const TIER_CLASS: Record<ExpiresAtTier, string> = {
  expired: "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20",
  today: "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20",
  soon: "text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20",
  distant: "text-muted-foreground bg-muted/40",
};

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatLabel(tier: ExpiresAtTier, target: Date): string {
  if (tier === "expired") return "expired";
  if (tier === "today") return "expires today";
  if (tier === "soon") {
    const days = Math.ceil((target.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    return `expires in ${days}d`;
  }
  // distant
  return `expires ${SHORT_MONTHS[target.getMonth()]} ${target.getDate()}`;
}

export function ExpiresAtChip({ expiresAt }: ExpiresAtChipProps) {
  const tier = expiresAtTier(expiresAt);
  if (!tier) return null;
  const target = expiresAt instanceof Date ? expiresAt : new Date(expiresAt as string);

  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium tabular-nums",
        TIER_CLASS[tier],
      )}
    >
      {formatLabel(tier, target)}
    </span>
  );
}
