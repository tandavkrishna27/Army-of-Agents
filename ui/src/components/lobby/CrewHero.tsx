import { User } from "lucide-react";
import { AgentIcon } from "@/components/AgentIconPicker";
import { cn } from "@/lib/utils";

// Illustrative crew — the empty lobby has no company/agents yet, so this is a
// hardcoded brand visual (not live data). Icons come from the app's AgentIcon set.
const CREW = [
  { icon: "crown", tint: "#c98a4b", label: "Commander", y: 6, delay: "0s" },
  { icon: "target", tint: "#5aa0e0", label: "Planner", y: -6, delay: "0.35s" },
  { icon: "radar", tint: "#7ac07a", label: "Scout", y: -6, delay: "0.5s" },
  { icon: "wrench", tint: "#b48ad8", label: "Engineer", y: 6, delay: "0.25s" },
] as const;

function CrewAvatar({ icon, tint, y, delay }: (typeof CREW)[number]) {
  // Wrapper carries the static arc offset; inner carries the float animation
  // (float-gentle overwrites `transform`, so the two must be on separate nodes).
  return (
    <div style={{ transform: `translateY(${y}px)` }}>
      <div
        className="flex size-[60px] items-center justify-center rounded-[18px] border border-border bg-card motion-safe:animate-float-gentle"
        style={{ color: tint, animationDelay: delay }}
      >
        <AgentIcon icon={icon} className="size-[26px]" />
      </div>
    </div>
  );
}

/** Decorative animated crew cluster for the lobby empty-state hero. */
export function CrewHero({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-end justify-center gap-3.5", className)} aria-hidden="true">
      {CREW.slice(0, 2).map((m) => (
        <CrewAvatar key={m.label} {...m} />
      ))}
      {/* Founder ("you") — centered, larger, brand-red, static ring. Float lives
          on the wrapper so it doesn't fight the avatar's ring. */}
      <div className="motion-safe:animate-float-gentle" style={{ animationDelay: "0.15s" }}>
        <div className="flex size-[74px] items-center justify-center rounded-[22px] bg-brand text-white ring-4 ring-brand/20">
          <User className="size-8" />
        </div>
      </div>
      {CREW.slice(2).map((m) => (
        <CrewAvatar key={m.label} {...m} />
      ))}
    </div>
  );
}
