// ui/src/components/skills/SkillLibrary.tsx
import { useMemo } from "react";
import { Link } from "@/lib/router";
import { Home, LayoutGrid } from "lucide-react";
import type { CompanySkillListItem } from "@armyofagents/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { derivePackagesForLibrary, type SkillPackage } from "@/lib/skillPackages";
import { SkillPackageRow } from "./SkillPackageRow";
import { SkillLibraryRow } from "./SkillLibraryRow";

interface Props {
  skills: CompanySkillListItem[];
  filter: string;
  selectedSkillId: string | null;
  selectedPackageId: string | null;
  homeActive: boolean;
  expandedPackageIds: Set<string>;
  packagesWithUpdate: Set<string>;
  onTogglePackage: (packageId: string) => void;
}

function matchesFilter(skill: CompanySkillListItem, filter: string): boolean {
  if (!filter) return true;
  const haystack =
    `${skill.name} ${skill.key} ${skill.slug} ${skill.sourceLabel ?? ""}`.toLowerCase();
  return haystack.includes(filter.toLowerCase());
}

function packageMatches(pkg: SkillPackage, filter: string): boolean {
  if (!filter) return true;
  const haystack = `${pkg.name} ${pkg.id}`.toLowerCase();
  return haystack.includes(filter.toLowerCase());
}

export function SkillLibrary({
  skills,
  filter,
  selectedSkillId,
  selectedPackageId,
  homeActive,
  expandedPackageIds,
  packagesWithUpdate,
  onTogglePackage,
}: Props) {
  const { packages, standalones } = useMemo(() => derivePackagesForLibrary(skills), [skills]);

  const skillsById = useMemo(() => {
    const map = new Map<string, CompanySkillListItem>();
    for (const s of skills) map.set(s.id, s);
    return map;
  }, [skills]);

  const filteredPackages = useMemo(() => {
    if (!filter) return packages;
    return packages
      .map((pkg) => {
        if (packageMatches(pkg, filter)) return pkg;
        const matchingMembers = pkg.memberSkillIds.filter((id) => {
          const s = skillsById.get(id);
          return s ? matchesFilter(s, filter) : false;
        });
        if (matchingMembers.length === 0) return null;
        return { ...pkg, memberSkillIds: matchingMembers, count: matchingMembers.length };
      })
      .filter((p): p is SkillPackage => p !== null);
  }, [packages, filter, skillsById]);

  const filteredStandalones = useMemo(
    () => standalones.filter((s) => matchesFilter(s, filter)),
    [standalones, filter],
  );

  const totalVisible = filteredPackages.length + filteredStandalones.length;

  if (skills.length === 0) {
    return (
      <div className="px-4 py-6 text-sm text-dim">
        <p>
          No custom skills yet. Built-in skills (like aoa-create-agent) are managed by the
          underlying CLI tool and aren't shown here.
        </p>
        <Button asChild variant="outline" size="sm" className="mt-3 gap-1.5">
          <Link to="/marketplace/skill" className="no-underline">
            <LayoutGrid className="size-4" />
            Browse Marketplace
          </Link>
        </Button>
      </div>
    );
  }

  if (totalVisible === 0) {
    return (
      <div className="px-4 py-6 text-sm text-dim">
        No skills match this filter.
      </div>
    );
  }

  return (
    <div className="py-1">
      <Link
        to="/skills"
        aria-current={homeActive ? "page" : undefined}
        className={cn(
          "relative flex min-h-8 items-center gap-2 px-3 py-1.5 text-[12.5px] no-underline transition-colors",
          "text-foreground/85 hover:bg-accent hover:text-accent-foreground",
          homeActive && "bg-accent text-accent-foreground",
        )}
      >
        <Home className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">Home</span>
        {homeActive && (
          <span className="absolute left-0 top-1.5 h-5 w-0.5 rounded-full bg-brand" aria-hidden />
        )}
      </Link>

      {filteredPackages.length > 0 && (
        <>
          <div className="my-2 border-t border-border" aria-hidden />
          <div className="px-3 py-2 text-[10px] uppercase tracking-[0.08em] text-dim">
            <span>{`Packages · ${filteredPackages.length}`}</span>
          </div>
          {filteredPackages.map((pkg) => {
            const expanded = expandedPackageIds.has(pkg.id);
            return (
              <div key={pkg.id}>
                <SkillPackageRow
                  packageId={pkg.id}
                  name={pkg.name}
                  count={pkg.count}
                  provider={pkg.provider}
                  expanded={expanded}
                  hasUpdate={packagesWithUpdate.has(pkg.id)}
                  active={selectedPackageId === pkg.id}
                  onToggleExpand={onTogglePackage}
                />
                {expanded &&
                  pkg.memberSkillIds.map((id) => {
                    const member = skillsById.get(id);
                    if (!member) return null;
                    return (
                      <SkillLibraryRow
                        key={member.id}
                        skillId={member.id}
                        to={`/skills/${member.id}`}
                        name={member.name}
                        badge={member.sourceBadge}
                        sourceLabel={member.sourceLabel}
                        active={selectedSkillId === member.id}
                        hideSourceIcon
                        indent={36}
                      />
                    );
                  })}
              </div>
            );
          })}
        </>
      )}

      {filteredStandalones.length > 0 && (
        <>
          {filteredPackages.length > 0 && (
            <div className="my-2 border-t border-border" aria-hidden />
          )}
          <div className="px-3 py-2 text-[10px] uppercase tracking-[0.08em] text-dim">
            {`Standalone · ${filteredStandalones.length}`}
          </div>
          {filteredStandalones.map((skill) => (
            <SkillLibraryRow
              key={skill.id}
              skillId={skill.id}
              to={`/skills/${skill.id}`}
              name={skill.name}
              badge={skill.sourceBadge}
              sourceLabel={skill.sourceLabel}
              active={selectedSkillId === skill.id}
              chip={skill.sourceBadge === "paperclip" ? "AoA" : undefined}
            />
          ))}
        </>
      )}
    </div>
  );
}
