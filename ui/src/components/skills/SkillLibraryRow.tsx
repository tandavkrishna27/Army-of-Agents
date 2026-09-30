import { Link } from "@/lib/router";
import { FileText } from "lucide-react";
import type { CompanySkillSourceBadge } from "@armyofagents/shared";
import { cn } from "@/lib/utils";
import { SkillSourceIcon } from "./SkillSourceIcon";

interface Props {
  skillId: string;
  to: string;
  name: string;
  badge: CompanySkillSourceBadge;
  sourceLabel: string | null;
  active: boolean;
  onSelect?: (skillId: string) => void;
  /** Hide the source-tinted icon (used when row is a package member). */
  hideSourceIcon?: boolean;
  /** Pixel left padding (used to indent package members). */
  indent?: number;
  /** Optional small chip label on the right (e.g. "AoA"). */
  chip?: string;
}

export function SkillLibraryRow({
  skillId,
  to,
  name,
  badge,
  sourceLabel,
  active,
  onSelect,
  hideSourceIcon,
  indent,
  chip,
}: Props) {
  return (
    <Link
      to={to}
      onClick={() => onSelect?.(skillId)}
      style={indent ? { paddingLeft: `${indent}px` } : undefined}
      className={cn(
        "group relative flex items-center gap-2 px-3 py-1.5 text-[12.5px] no-underline",
        "text-text/85 hover:bg-white/[0.04] hover:text-text",
        active && "bg-brand/10 text-brand",
      )}
      aria-current={active ? "page" : undefined}
    >
      {hideSourceIcon ? (
        <FileText className="size-3 shrink-0 text-dim" />
      ) : (
        <SkillSourceIcon badge={badge} sourceLabel={sourceLabel} />
      )}
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {chip && (
        <span className="rounded border border-border bg-white/[0.04] px-1.5 py-px text-[10px] text-dim">
          {chip}
        </span>
      )}
      {active && (
        <span
          aria-hidden
          className="absolute right-2.5 top-1/2 size-[5px] -translate-y-1/2 rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]"
        />
      )}
    </Link>
  );
}
