/**
 * ComposerMentionMenu — THE @mention picker for every composer surface.
 *
 * Approved mock v2: the @ button opens this list (first item preselected so
 * Enter picks it) and typing a trailing `@token` opens the same list inline.
 * One component on all four surfaces — Discussion, Commander, Workspace
 * chatbar, Task Comments — so the mention experience can't drift.
 *
 * Promoted from threads/EntryAutocompleteList (which now delegates here with
 * its legacy testid prefix — existing Discussion tests keep passing).
 *
 * Anchoring: `absolute bottom-full` inside the composer frame. ComposerFrame
 * must NEVER gain overflow (locked P1) — this popover relies on it.
 */
import { Bot, User as UserIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MentionOption {
  id: string;
  name: string;
  type: "agent" | "user";
  /** Optional icon URL (agent.icon or user avatar). */
  icon?: string | null;
  /** Optional secondary text (e.g. email for users, role for agents). */
  subtitle?: string | null;
}

export interface ComposerMentionMenuProps {
  options: MentionOption[];
  selectionIndex: number;
  onSelect: (option: MentionOption) => void;
  onHover?: (index: number) => void;
  /** Teammates query still in flight (F8) — shows a loading row instead of "No matches". */
  loading?: boolean;
  /** Testid prefix — defaults to the shared name; Discussion passes its legacy one. */
  testIdPrefix?: string;
  /** Extra classes on the popover (anchor tweaks per surface). */
  className?: string;
}

export function ComposerMentionMenu({
  options,
  selectionIndex,
  onSelect,
  onHover,
  loading = false,
  testIdPrefix = "composer-mention",
  className,
}: ComposerMentionMenuProps) {
  if (options.length === 0) {
    // While teammates are still loading, "No matches" would be a lie (F8) —
    // show a quiet loading row until the query settles.
    if (loading) {
      return (
        <div
          className={cn(
            "composer-mention-loading absolute bottom-full left-0 mb-1 w-72 rounded-md border border-border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-md",
            className,
          )}
          data-testid={`${testIdPrefix}-loading`}
        >
          Loading teammates…
        </div>
      );
    }
    return (
      <div
        className={cn(
          "absolute bottom-full left-0 mb-1 w-72 rounded-md border border-border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-md",
          className,
        )}
        data-testid={`${testIdPrefix}-empty`}
      >
        No matches
      </div>
    );
  }

  return (
    <ul
      className={cn(
        "absolute bottom-full left-0 mb-1 w-72 max-h-64 overflow-y-auto rounded-md border border-border bg-popover py-1 text-sm shadow-md",
        className,
      )}
      role="listbox"
      data-testid={testIdPrefix}
    >
      {options.map((s, i) => {
        const active = i === selectionIndex;
        return (
          <li
            key={`${s.type}-${s.id}`}
            role="option"
            aria-selected={active}
            // Use onMouseDown so the click fires before the input loses focus
            // (onClick would race with onBlur and we'd never get the selection).
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(s);
            }}
            onMouseEnter={() => onHover?.(i)}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 cursor-pointer",
              active
                ? "bg-accent text-accent-foreground"
                : "text-foreground hover:bg-accent/60",
            )}
            data-testid={`${testIdPrefix}-option-${s.name}`}
          >
            <span
              className={cn(
                "shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold",
                s.type === "agent"
                  ? "bg-violet-500/20 text-violet-300"
                  : "bg-slate-500/20 text-slate-300",
              )}
              aria-hidden="true"
            >
              {s.icon ? (
                <img src={s.icon} alt="" className="w-5 h-5 rounded-full" />
              ) : s.type === "agent" ? (
                <Bot className="w-3 h-3" />
              ) : (
                <UserIcon className="w-3 h-3" />
              )}
            </span>
            <span className="flex-1 min-w-0 truncate font-medium">{s.name}</span>
            {s.subtitle && (
              <span className="shrink-0 text-[10px] text-muted-foreground/70 truncate max-w-[120px]">
                {s.subtitle}
              </span>
            )}
            <span
              className={cn(
                "shrink-0 text-[9px] uppercase tracking-wider font-semibold",
                s.type === "agent" ? "text-violet-400/70" : "text-slate-400/70",
              )}
            >
              {s.type === "agent" ? "Agent" : "User"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
