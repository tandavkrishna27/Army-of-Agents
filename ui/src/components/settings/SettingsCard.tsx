/**
 * A settings card: an icon tile + title + one-line description header row, then a
 * body. Presentational only — used by the Inbox settings panel and the GitHub
 * integration surface to group existing controls without changing any of them.
 *
 * We compose divs (not the shadcn `Card` primitive): `Card` hard-codes heavy
 * `py-6`/`gap-6`/`px-6` spacing and carries no rounded corners, which does not
 * fit these dense settings panels. This matches the hand-composed card idiom in
 * `ProvidersSection` and `GitHubSection`.
 */
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SettingsCardProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  /** Optional right-aligned header content (e.g. a mode pill or "Saving" note). */
  headerAside?: ReactNode;
  /** Extra classes for the body wrapper (callers control inner spacing). */
  bodyClassName?: string;
  children: ReactNode;
}

export function SettingsCard({
  icon: Icon,
  title,
  description,
  headerAside,
  bodyClassName,
  children,
}: SettingsCardProps) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex items-start gap-3 border-b border-border px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold leading-tight">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {headerAside ? <div className="shrink-0 self-center">{headerAside}</div> : null}
      </header>
      <div className={cn("px-4 py-3", bodyClassName)}>{children}</div>
    </section>
  );
}
