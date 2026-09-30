// ui/src/components/skills/SkillsHomeEmpty.tsx
import { Link } from "@/lib/router";
import { Boxes, FolderOpen, LayoutGrid, Plus, RefreshCw, Sparkles } from "lucide-react";
import type { CompanySkillListItem } from "@armyofagents/shared";
import { Button } from "@/components/ui/button";
import { derivePackagesForLibrary } from "@/lib/skillPackages";
import { SkillSourceIcon } from "./SkillSourceIcon";
import type { RecentSkill } from "@/hooks/useRecentSkills";

interface Props {
  skills: CompanySkillListItem[];
  recent: RecentSkill[];
  onAddSkill: () => void;
  onScanSkills: () => void;
  scanPending: boolean;
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function SkillsHomeEmpty({
  skills,
  recent,
  onAddSkill,
  onScanSkills,
  scanPending,
}: Props) {
  const { packages, standalones } = derivePackagesForLibrary(skills);
  const skillById = new Map(skills.map((s) => [s.id, s]));
  const resolvedRecent = recent
    .map((r) => ({ entry: r, skill: skillById.get(r.skillId) }))
    .filter((r): r is { entry: RecentSkill; skill: CompanySkillListItem } => Boolean(r.skill));
  const folderManaged = skills.filter(
    (s) => s.sourceType === "local_path" || s.sourceBadge === "local",
  ).length;
  const stats = [
    { label: "Total skills", value: skills.length, icon: Boxes },
    { label: "Packages", value: packages.length, icon: Sparkles },
    { label: "Standalone", value: standalones.length, icon: FolderOpen },
    { label: "Local skills", value: folderManaged, icon: LayoutGrid },
  ];

  return (
    <div className="flex flex-1 flex-col px-6 py-6">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.08em] text-dim">
              <Boxes className="size-3.5" />
              Library home
            </div>
            <p className="mt-1.5 max-w-[58ch] text-[12.5px] leading-5 text-dim">
              Review what is installed, jump back into recent skills, or add a new skill from a
              GitHub URL, local folder, or skills.sh source.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              asChild
              className="h-8 gap-1.5 px-3"
            >
              <Link to="/marketplace/skill" className="no-underline">
                <LayoutGrid className="size-3.5" />
                Browse marketplace
              </Link>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onScanSkills}
              disabled={scanPending}
              className="h-8 gap-1.5 px-3"
            >
              <RefreshCw className={`size-3.5 ${scanPending ? "animate-spin" : ""}`} />
              Scan
            </Button>
            <Button type="button" size="sm" onClick={onAddSkill} className="h-8 gap-1.5 px-3.5">
              <Plus className="size-3.5" />
              Add skill
            </Button>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {stats.map((stat) => {
            const Icon = stat.icon;
            return (
              <div key={stat.label} className="rounded-lg border border-border bg-muted/20 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] text-dim">{stat.label}</span>
                  <Icon className="size-3.5 text-muted-foreground" />
                </div>
                <div className="mt-2 text-[22px] font-semibold leading-none text-text">
                  {stat.value}
                </div>
              </div>
            );
          })}
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
          <div className="rounded-lg border border-border">
            <div className="flex h-[42px] items-center border-b border-border px-4 text-[10px] uppercase tracking-[0.08em] text-dim">
              Standalone
            </div>
            <div>
              {standalones.length > 0 ? (
                standalones.slice(0, 6).map((skill, i) => (
                  <Link
                    key={skill.id}
                    to={`/skills/${skill.id}`}
                    className={`flex items-center gap-3 px-4 py-2.5 no-underline ${
                      i < Math.min(standalones.length, 6) - 1 ? "border-b border-border" : ""
                    }`}
                  >
                    <SkillSourceIcon badge={skill.sourceBadge} sourceLabel={skill.sourceLabel} />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-text">
                      {skill.name}
                    </span>
                    <span className="text-[10.5px] text-dim">{skill.sourceLabel}</span>
                  </Link>
                ))
              ) : (
                <div className="px-4 py-5 text-[12.5px] text-dim">
                  No standalone skills installed.
                </div>
              )}
            </div>
          </div>

          {resolvedRecent.length > 0 && (
            <div className="rounded-lg border border-border">
              <div className="flex h-[42px] items-center border-b border-border px-4 text-[10px] uppercase tracking-[0.08em] text-dim">
                Recently opened
              </div>
              <div>
                {resolvedRecent.map((r, i) => (
                  <Link
                    key={r.skill.id}
                    to={`/skills/${r.skill.id}`}
                    className={`flex items-center gap-3 px-4 py-2.5 no-underline ${
                      i < resolvedRecent.length - 1 ? "border-b border-border" : ""
                    }`}
                  >
                    <SkillSourceIcon badge={r.skill.sourceBadge} sourceLabel={r.skill.sourceLabel} />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-text">
                      {r.skill.name}
                    </span>
                    <span className="shrink-0 text-[10.5px] text-dim">
                      {formatRelativeTime(r.entry.openedAt)}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
