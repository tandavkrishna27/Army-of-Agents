import { useSearchParams } from "@/lib/router";
import { cn } from "@/lib/utils";

const COMMANDER_SUB_TABS = [
  { id: "execution", label: "Execution & Model" },
  { id: "capabilities", label: "Capabilities" },
  { id: "budget", label: "Budget & Spend" },
  { id: "history", label: "Run History" },
  { id: "permissions", label: "Permissions" },
  { id: "trusted-actions", label: "Trusted Actions" },
] as const;

export type CommanderSubTabId = (typeof COMMANDER_SUB_TABS)[number]["id"];

export function useCommanderSubTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const subParam = searchParams.get("sub");
  const active: CommanderSubTabId =
    COMMANDER_SUB_TABS.find((t) => t.id === subParam)?.id ?? "execution";

  const setActive = (id: CommanderSubTabId) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("sub", id);
      return next;
    });
  };

  return { active, setActive };
}

interface CommanderSubTabsProps {
  active: CommanderSubTabId;
  onSelect: (id: CommanderSubTabId) => void;
}

export function CommanderSubTabs({ active, onSelect }: CommanderSubTabsProps) {
  return (
    <div
      role="tablist"
      className="px-8 flex items-end gap-1 border-b border-border-soft -mb-px"
    >
      {COMMANDER_SUB_TABS.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onSelect(t.id)}
          className={cn(
            "px-3.5 py-2 text-[12.5px] font-medium border-b-2 transition-colors",
            active === t.id
              ? "text-[hsl(15_60%_75%)] border-brand"
              : "text-muted-foreground border-transparent hover:text-foreground",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function CommanderSubTabsMobile({ active, onSelect }: CommanderSubTabsProps) {
  return (
    <div className="md:hidden border-b border-border-soft py-2 px-3 flex gap-2 overflow-x-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
      {COMMANDER_SUB_TABS.map((t) => (
        <button
          key={t.id}
          aria-pressed={active === t.id}
          onClick={() => onSelect(t.id)}
          className={cn(
            "shrink-0 px-3 py-1.5 rounded-full text-[12.5px] font-medium border whitespace-nowrap",
            active === t.id
              ? "bg-brand/[0.12] border-brand/40 text-[hsl(15_60%_75%)]"
              : "bg-card border-border text-muted-foreground",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
