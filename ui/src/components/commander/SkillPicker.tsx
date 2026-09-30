import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Loader2, Wand2, X } from "lucide-react";
import type { CompanySkillListItem } from "@armyofagents/shared";
import { useCompany } from "../../context/CompanyContext";
import { internalAgentApi } from "../../api/internal-agent";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import { filterSkills } from "./skillPickerUtils";

interface SkillPickerProps {
  /** Whether the picker is visible. */
  open: boolean;
  /** Substring filter applied to skill name/key. Empty → show all. */
  query: string;
  /** Currently highlighted row (parent-owned for textarea keyboard nav). */
  activeIndex: number;
  /** Hover/keyboard moves the highlight. */
  onActiveIndexChange: (index: number) => void;
  /** A skill row was chosen (click or Enter). */
  onSelect: (skill: CompanySkillListItem) => void;
  /**
   * Reports the current filtered list up to the parent so its keydown
   * handler can clamp the active index and resolve the selected skill
   * without re-fetching or duplicating the filter logic.
   */
  onFilteredChange: (skills: CompanySkillListItem[]) => void;
  /** Close the picker (header × button). */
  onClose: () => void;
}

/** Max rows visible before the list scrolls (compact dropdown, not full-pane). */
const MAX_VISIBLE = 5;
const ROW_HEIGHT_PX = 56;

/**
 * Presentational popover for the Commander `/skill` picker. Fetches the
 * company skill list, filters by `query`, and renders selectable rows.
 * Keyboard navigation is owned by the parent (the textarea has focus);
 * this component only renders + handles mouse interaction.
 */
export function SkillPicker({
  open,
  query,
  activeIndex,
  onActiveIndexChange,
  onSelect,
  onFilteredChange,
  onClose,
}: SkillPickerProps) {
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const listRef = useRef<HTMLUListElement>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.commanderSkills(companyId),
    queryFn: () => internalAgentApi.listSkills(companyId),
    enabled: open && !!companyId,
  });

  const skills = data ?? [];
  const filtered = useMemo(() => filterSkills(skills, query), [skills, query]);

  // Keep the parent's view of the filtered list in sync (for keyboard nav +
  // selection resolution). Effect (not render-time call) to avoid setState
  // during the parent's render.
  useEffect(() => {
    if (open) onFilteredChange(filtered);
  }, [open, filtered, onFilteredChange]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  if (!open) return null;

  return (
    <div
      className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-20 w-[440px] max-w-[calc(100%-1rem)]"
      role="listbox"
      aria-label="Company skills"
    >
      <div className="rounded-lg border border-border bg-popover shadow-lg overflow-hidden">
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border text-xs font-medium text-muted-foreground">
          <Wand2 className="size-3.5" aria-hidden="true" />
          <span>Skills</span>
          <span className="ml-auto flex items-center gap-1.5">
            <kbd className="text-[10px] font-normal text-muted-foreground/60">Esc</kbd>
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onClose(); }}
              aria-label="Close skills"
              className="size-6 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </span>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading skills…
          </div>
        ) : isError ? (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
            <AlertCircle className="size-4 text-[color:var(--error,#ef4444)]" aria-hidden="true" />
            Couldn't load skills.
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            {skills.length === 0 ? "No skills available." : "No skills match."}
          </div>
        ) : (
          <ul
            ref={listRef}
            className="overflow-y-auto py-1"
            style={{ maxHeight: MAX_VISIBLE * ROW_HEIGHT_PX }}
          >
            {filtered.map((skill, i) => (
              <li key={skill.id} role="option" aria-selected={i === activeIndex}>
                <button
                  type="button"
                  // preventDefault keeps textarea focus so caret insertion
                  // happens against the live selection (mirrors SessionsSidebar
                  // search-clear pattern).
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect(skill);
                  }}
                  onMouseEnter={() => onActiveIndexChange(i)}
                  className={cn(
                    "w-full text-left px-3 py-2 flex flex-col gap-0.5 transition-colors",
                    i === activeIndex ? "bg-muted" : "hover:bg-muted/60",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-foreground truncate">
                      {skill.name}
                    </span>
                    <span className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground truncate max-w-[40%]">
                      {skill.key.replace(/^skill:/, "").split("/")[0]}
                    </span>
                  </div>
                  {skill.description && (
                    <span className="text-xs text-muted-foreground truncate">
                      {skill.description}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
