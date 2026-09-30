import { type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { companiesApi } from "../api/companies";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { teamApi } from "../api/team";
import { Reveal } from "./motion";

type Accent = "brand" | "teal" | "amber";
const ACCENT_VAR: Record<Accent, string> = {
  brand: "var(--brand)",
  teal: "var(--teal)",
  amber: "var(--amber)",
};

// Static (non-interactive) sibling of Map.tsx's JourneyCard: same chrome, no
// button/onClick/cta arrow — this screen orients, it doesn't fork.
function OrientationCard({
  emoji,
  title,
  accent,
  children,
}: {
  emoji: string;
  title: string;
  accent: Accent;
  children: ReactNode;
}) {
  const c = ACCENT_VAR[accent];
  return (
    <div
      style={{ "--card-accent": c } as CSSProperties}
      className={cn(
        "relative flex min-h-[168px] w-full flex-col gap-3 overflow-hidden rounded-2xl border border-border-strong bg-card p-5 text-left",
      )}
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{ backgroundColor: `color-mix(in srgb, ${c} 65%, transparent)` }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full opacity-40 blur-2xl"
        style={{ backgroundColor: `color-mix(in srgb, ${c} 35%, transparent)` }}
      />
      <span
        aria-hidden
        className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xl leading-none"
        style={{
          backgroundColor: `color-mix(in srgb, ${c} 18%, transparent)`,
          border: `1px solid color-mix(in srgb, ${c} 45%, transparent)`,
        }}
      >
        {emoji}
      </span>
      <div className="relative flex min-w-0 flex-1 flex-col gap-2">
        <h3 className="m-0 text-[15px] font-semibold text-text">{title}</h3>
        <span
          aria-hidden
          className="block h-px w-8"
          style={{ backgroundColor: `color-mix(in srgb, ${c} 55%, transparent)` }}
        />
        <div className="m-0 text-[12.5px] leading-relaxed text-dim">{children}</div>
      </div>
    </div>
  );
}

export type CompanyOrientationProps = {
  /** The joined company's id (null on the rare deep-link/name-only race — then
   * every card shows its fallback and no fetch runs). */
  companyId: string | null;
  companyName: string;
};

/**
 * The invited-teammate terminal's orientation panel (replaces the old generic
 * MiniMap). Shows whatever the joined company actually has — mission,
 * departments, team + agent counts — each card degrading independently to a
 * friendly fallback. Read-only; the "Enter" action stays on the parent.
 */
export function CompanyOrientation({ companyId, companyName }: CompanyOrientationProps) {
  const enabled = Boolean(companyId);
  const company = useQuery({
    queryKey: ["invited-orientation", "company", companyId],
    queryFn: () => companiesApi.get(companyId as string),
    enabled,
    retry: false,
  });
  const projects = useQuery({
    queryKey: ["invited-orientation", "projects", companyId],
    queryFn: () => projectsApi.list(companyId as string),
    enabled,
    retry: false,
  });
  const agents = useQuery({
    queryKey: ["invited-orientation", "agents", companyId],
    queryFn: () => agentsApi.list(companyId as string),
    enabled,
    retry: false,
  });
  const team = useQuery({
    queryKey: ["invited-orientation", "team", companyId],
    queryFn: () => teamApi.get(companyId as string),
    enabled,
    retry: false,
  });

  const missionText = company.data?.vision || company.data?.mission || null;
  const departments = (projects.data ?? []).filter((p) => p.type === "department");
  const agentCount = agents.data?.length ?? 0;
  const teammateCount = team.data?.members.length ?? 0;

  // While the joined company's data is still in flight, hold the same three-card
  // footprint but render a muted placeholder line rather than the fallback copy
  // — otherwise "No departments yet." / "You're one of the first here." would
  // flash before the real values arrive. Only when we actually fetch (enabled).
  const loading =
    enabled && (company.isLoading || projects.isLoading || agents.isLoading || team.isLoading);

  return (
    <Reveal delay={0.09}>
      <div className="grid w-full grid-cols-1 gap-3.5 sm:grid-cols-3 sm:gap-4">
        {loading ? (
          <>
            <OrientationCard emoji="🎯" title="What we're building" accent="brand">
              <SkeletonLine />
            </OrientationCard>
            <OrientationCard emoji="🏢" title="Departments" accent="teal">
              <SkeletonLine />
            </OrientationCard>
            <OrientationCard emoji="👥" title="Who's here" accent="amber">
              <SkeletonLine />
            </OrientationCard>
          </>
        ) : (
          <>
            <OrientationCard emoji="🎯" title="What we're building" accent="brand">
              {missionText ?? `${companyName}'s team is shaping this as they go.`}
            </OrientationCard>

            <OrientationCard emoji="🏢" title="Departments" accent="teal">
              {departments.length === 0 ? (
                "No departments yet."
              ) : (
                <span className="flex flex-wrap gap-1.5">
                  {departments.map((d) => (
                    <span
                      key={d.id}
                      className="rounded-md border border-border-strong bg-card-2 px-2 py-0.5 text-[11px] text-text"
                    >
                      {d.name}
                    </span>
                  ))}
                </span>
              )}
            </OrientationCard>

            <OrientationCard emoji="👥" title="Who's here" accent="amber">
              {teammateCount === 0 && agentCount === 0
                ? "You're one of the first here."
                : `${teammateCount} teammate${teammateCount === 1 ? "" : "s"} · ${agentCount} agent${
                    agentCount === 1 ? "" : "s"
                  } already working`}
            </OrientationCard>
          </>
        )}
      </div>
    </Reveal>
  );
}

/** A short muted placeholder bar shown in a card while its data is loading. */
function SkeletonLine() {
  return <span aria-hidden className="block h-3 w-2/3 animate-pulse rounded bg-white/10" />;
}
