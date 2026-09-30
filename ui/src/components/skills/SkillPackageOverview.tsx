// ui/src/components/skills/SkillPackageOverview.tsx
import { ExternalLink, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import type { CompanySkillListItem } from "@armyofagents/shared";
import { Button } from "@/components/ui/button";
import { StackedIcon } from "@/components/marketplace/StackedIcon";
import { ProviderLogo } from "@/components/marketplace/ProviderLogo";
import { cn } from "@/lib/utils";
import type { SkillPackage } from "@/lib/skillPackages";
import { SkillPackageMemberCard } from "./SkillPackageMemberCard";

interface Props {
  pkg: SkillPackage;
  members: CompanySkillListItem[];
  membersWithUpdate: Set<string>;
  totalUsedByAgents: number;
  onUpdateAll: () => void;
  onRemovePackage: () => void;
  updateAllPending: boolean;
  removePending: boolean;
}

export function SkillPackageOverview({
  pkg,
  members,
  membersWithUpdate,
  totalUsedByAgents,
  onUpdateAll,
  onRemovePackage,
  updateAllPending,
  removePending,
}: Props) {
  const hasAnyUpdate = membersWithUpdate.size > 0;
  return (
    <div className="flex flex-1 flex-col">
      <div className="border-b border-border px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            {pkg.provider ? (
              <ProviderLogo provider={pkg.provider} className="size-12 shrink-0 rounded-xl" />
            ) : (
              <StackedIcon icon={Sparkles} tone="amber" className="size-12 shrink-0" />
            )}
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.1em] text-dim">
                Package
              </div>
              <h2 className="mt-0.5 text-[20px] font-semibold">{pkg.name}</h2>
              <p className="mt-1 max-w-[68ch] text-[13px] text-dim">
                {pkg.count} {pkg.count === 1 ? "skill" : "skills"} · {pkg.id}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {hasAnyUpdate && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onUpdateAll}
                disabled={updateAllPending}
                className="h-7 gap-1.5 text-[12px]"
              >
                <RefreshCw className={cn("size-3.5", updateAllPending && "animate-spin")} />
                Update all
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRemovePackage}
              disabled={removePending}
              className="h-7 gap-1.5 text-[12px]"
            >
              <Trash2 className="size-3.5" />
              Remove package
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px] text-dim">
          <span className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-[0.18em]">Source</span>
            <a
              href={pkg.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-text hover:underline"
            >
              {pkg.id}
              <ExternalLink className="size-3" />
            </a>
          </span>
          {hasAnyUpdate && (
            <span className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-[0.18em]">Updates</span>
              <span className="inline-flex items-center gap-1 rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-px text-[10px] text-amber-500">
                <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
                {membersWithUpdate.size} of {pkg.count} have updates
              </span>
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-[0.18em]">Used by</span>
            <span className="text-text">{totalUsedByAgents} of your agents</span>
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-5">
        <div className="mb-3 flex items-center gap-2">
          <h3 className="text-[13px] font-semibold">Member skills</h3>
          <span className="text-[11px] text-dim">{pkg.count}</span>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {members.map((m) => (
            <SkillPackageMemberCard key={m.id} skill={m} hasUpdate={membersWithUpdate.has(m.id)} />
          ))}
        </div>
      </div>
    </div>
  );
}
