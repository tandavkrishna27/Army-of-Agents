import type { CompanySkillSourceBadge } from "@armyofagents/shared";
import { cn } from "@/lib/utils";
import { skillSourceMeta, toneTextClass } from "@/lib/skillSourceMeta";

interface Props {
  badge: CompanySkillSourceBadge;
  sourceLabel: string | null;
  className?: string;
  /** Hide the sr-only "managed by X" caption (use when an outer element provides labelling). */
  hideLabel?: boolean;
}

export function SkillSourceIcon({ badge, sourceLabel, className, hideLabel }: Props) {
  const meta = skillSourceMeta(badge, sourceLabel);
  const Icon = meta.Icon;
  return (
    <span className="inline-flex items-center justify-center">
      <Icon className={cn("size-3.5", toneTextClass(meta.tone), className)} />
      {!hideLabel && <span className="sr-only">{meta.managedLabel}</span>}
    </span>
  );
}
