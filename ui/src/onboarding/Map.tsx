import { type CSSProperties } from "react";
import { ArrowRight, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Reveal } from "./motion";

export type MapDoorPersona = "in_flight" | "explorer";

export type MapProps = {
  /** Fired when the founder picks a live journey. The idea card is
   * parked/inert — it never calls this. */
  onPick: (persona: MapDoorPersona) => void;
};

/** Per-card accent hue — all three resolve under `.onboarding-dark`
 * (see motion/motion.css): brand red, exploration teal, parked amber. */
type CardAccent = "brand" | "teal" | "amber";

const ACCENT_VAR: Record<CardAccent, string> = {
  brand: "var(--brand)",
  teal: "var(--teal)",
  amber: "var(--amber)",
};

function JourneyCard({
  emoji,
  title,
  description,
  accent,
  cta,
  flag,
  onClick,
  disabled,
}: {
  emoji: string;
  title: string;
  description: string;
  accent: CardAccent;
  /** Button label for the live cards. Omitted for the disabled card. */
  cta?: string;
  /** Small accent-tinted flag shown top-right (e.g. "Most teams start here"). */
  flag?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const c = ACCENT_VAR[accent];

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{ "--card-accent": c } as CSSProperties}
      className={cn(
        "group relative flex min-h-[236px] w-full flex-col gap-3 overflow-hidden rounded-2xl border p-5 text-left transition-all duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--card-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        disabled
          ? "cursor-not-allowed border-dashed border-border bg-card/60 opacity-60"
          : "border-border-strong bg-card hover:-translate-y-1 hover:border-[color:var(--card-accent)] hover:shadow-[0_20px_44px_-20px_var(--card-accent)]",
      )}
    >
      {/* top hairline bar */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{ backgroundColor: `color-mix(in srgb, ${c} ${disabled ? 25 : 65}%, transparent)` }}
      />
      {/* soft accent glow */}
      <span
        aria-hidden
        className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full opacity-40 blur-2xl"
        style={{ backgroundColor: `color-mix(in srgb, ${c} 35%, transparent)` }}
      />

      {flag && (
        <span
          className="absolute right-4 top-4 rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{
            backgroundColor: `color-mix(in srgb, ${c} 16%, transparent)`,
            border: `1px solid color-mix(in srgb, ${c} 40%, transparent)`,
            color: `color-mix(in srgb, ${c} 80%, white)`,
          }}
        >
          {flag}
        </span>
      )}
      {disabled && (
        <span className="absolute right-4 top-4 inline-flex items-center gap-1 rounded-full border border-border-strong px-2 py-0.5 text-[10px] font-medium text-dim">
          <Clock aria-hidden className="h-2.5 w-2.5" />
          Coming soon
        </span>
      )}

      <span
        aria-hidden
        className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xl leading-none"
        style={{
          backgroundColor: `color-mix(in srgb, ${c} ${disabled ? 10 : 18}%, transparent)`,
          border: `1px solid color-mix(in srgb, ${c} ${disabled ? 22 : 45}%, transparent)`,
        }}
      >
        {emoji}
      </span>

      <span className="relative flex min-w-0 flex-1 flex-col gap-2">
        <h3 className="m-0 text-[15px] font-semibold text-text">{title}</h3>
        <span
          aria-hidden
          className="block h-px w-8"
          style={{ backgroundColor: `color-mix(in srgb, ${c} 55%, transparent)` }}
        />
        <p className="m-0 text-[12.5px] leading-relaxed text-dim">{description}</p>

        {cta && !disabled && (
          <span
            className="mt-auto inline-flex w-fit items-center gap-1.5 pt-2 text-[12.5px] font-medium transition-transform duration-200 group-hover:translate-x-0.5"
            style={{ color: `color-mix(in srgb, ${c} 85%, white)` }}
          >
            {cta}
            <ArrowRight aria-hidden className="h-3.5 w-3.5 shrink-0" />
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * WS9 — the founder's Home first-run fork: three large journey cards, no
 * flow diagram. In-flight ("Bring a project in motion") and Explorer
 * ("Explore on your own") are the two live cards (`onPick`); the idea card
 * ("Start from an idea") is parked/"coming soon" — disabled, never calls
 * `onPick`.
 */
export function Map({ onPick }: MapProps) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 py-8">
      <Reveal>
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="m-0 text-2xl font-bold tracking-tight text-text sm:text-[28px]">
            Where are you starting from?
          </h1>
          <p className="m-0 max-w-sm text-sm text-dim">
            Three ways in — you can switch paths later.
          </p>
        </div>
      </Reveal>

      <Reveal delay={0.09}>
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3 sm:gap-4">
          <JourneyCard
            emoji="🚚"
            title="Bring a project in motion"
            description="Already building. Point your crew at the repo, the docs, the context you have — and they pick up exactly where you left off."
            accent="brand"
            cta="Continue setup →"
            flag="Most teams start here"
            onClick={() => onPick("in_flight")}
          />
          <JourneyCard
            emoji="🧭"
            title="Explore on your own"
            description="Skip the rails. Wander the workspace, wire up agents, memory, and tasks yourself — at whatever pace suits you."
            accent="teal"
            cta="Open the workspace →"
            onClick={() => onPick("explorer")}
          />
          <JourneyCard
            emoji="🌱"
            title="Start from an idea"
            description="Just a spark, no company yet? We'll help you shape it into a plan, a first team, and the opening moves — from a single sentence."
            accent="amber"
            disabled
          />
        </div>
      </Reveal>

      <Reveal delay={0.18}>
        <p className="m-0 text-center text-xs text-very-dim">
          Not sure? Bring in a project — you can always branch into the others later.
        </p>
      </Reveal>
    </div>
  );
}
