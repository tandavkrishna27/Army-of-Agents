import { createElement, type ReactElement, type SVGProps } from "react";
import type { LucideIcon } from "lucide-react";
import { Boxes, Folder, Github, Link2 } from "lucide-react";
import type { CompanySkillSourceBadge } from "@armyofagents/shared";

export type SourceTone = "amber" | "slate" | "teal" | "indigo" | "magenta";

export interface SkillSourceMeta {
  Icon: LucideIcon | ((props: SVGProps<SVGSVGElement>) => ReactElement);
  tone: SourceTone;
  label: string;
  managedLabel: string;
}

/** Vercel ▲ triangle mark — used for skills.sh-managed skills. */
export function VercelMark(props: SVGProps<SVGSVGElement>): ReactElement {
  return createElement(
    "svg",
    { viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": "true", ...props },
    createElement("path", { d: "M12 4 21 19H3z" }),
  );
}

const SKILLS_SH_IDENTIFIERS = ["skills.sh", "vercel-labs/skills"];

function isSkillsShManaged(sourceLabel: string | null): boolean {
  if (!sourceLabel) return false;
  const lower = sourceLabel.toLowerCase();
  return SKILLS_SH_IDENTIFIERS.some((id) => lower.includes(id));
}

/**
 * Returns the icon component, colour tone, display label, and "managed by X"
 * label for a given source badge. Drives SkillSourceIcon and SkillViewerHeader.
 */
export function skillSourceMeta(
  badge: CompanySkillSourceBadge,
  sourceLabel: string | null,
): SkillSourceMeta {
  switch (badge) {
    case "skills_sh":
      return {
        Icon: VercelMark,
        tone: "amber",
        label: sourceLabel ?? "skills.sh",
        managedLabel: "skills.sh managed",
      };
    case "github":
      if (isSkillsShManaged(sourceLabel)) {
        return {
          Icon: VercelMark,
          tone: "amber",
          label: sourceLabel ?? "skills.sh",
          managedLabel: "skills.sh managed",
        };
      }
      return {
        Icon: Github,
        tone: "slate",
        label: sourceLabel ?? "GitHub",
        managedLabel: "GitHub managed",
      };
    case "url":
      return {
        Icon: Link2,
        tone: "magenta",
        label: sourceLabel ?? "URL",
        managedLabel: "URL managed",
      };
    case "local":
      return {
        Icon: Folder,
        tone: "teal",
        label: sourceLabel ?? "Local",
        managedLabel: "Local skill",
      };
    case "paperclip":
      return {
        Icon: Boxes,
        tone: "indigo",
        label: sourceLabel ?? "AoA",
        managedLabel: "AoA managed",
      };
    case "catalog":
    default:
      return {
        Icon: Boxes,
        tone: "indigo",
        label: sourceLabel ?? "Catalog",
        managedLabel: "Catalog managed",
      };
  }
}

const TONE_TEXT: Record<SourceTone, string> = {
  amber: "text-amber-500",
  slate: "text-slate-400",
  teal: "text-teal-500",
  indigo: "text-indigo-400",
  magenta: "text-fuchsia-400",
};

const TONE_BG_SOFT: Record<SourceTone, string> = {
  amber: "bg-amber-500/10",
  slate: "bg-slate-500/10",
  teal: "bg-teal-500/10",
  indigo: "bg-indigo-500/10",
  magenta: "bg-fuchsia-500/10",
};

export function toneTextClass(tone: SourceTone): string {
  return TONE_TEXT[tone];
}

export function toneBgSoftClass(tone: SourceTone): string {
  return TONE_BG_SOFT[tone];
}
