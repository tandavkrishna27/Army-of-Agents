import { Plus, RefreshCw, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface Props {
  skillCount: number;
  packageCount: number;
  standaloneCount: number;
  pendingUpdateCount: number;
  unsavedCount: number;
  filter: string;
  onFilterChange: (value: string) => void;
  onScan: () => void;
  onAddSkill: () => void;
  scanPending: boolean;
}

export function SkillsPageHeader({
  skillCount,
  packageCount,
  standaloneCount,
  pendingUpdateCount,
  unsavedCount,
  filter,
  onFilterChange,
  onScan,
  onAddSkill,
  scanPending,
}: Props) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
      <h1 className="text-sm font-semibold">Skills</h1>
      <span className="text-xs text-dim">
        · {skillCount} across {packageCount}{" "}
        {packageCount === 1 ? "package" : "packages"} · {standaloneCount} standalone
      </span>
      {pendingUpdateCount > 0 && (
        <span className="inline-flex items-center gap-1 rounded border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
          <RefreshCw className="size-3" />
          {pendingUpdateCount} {pendingUpdateCount === 1 ? "update" : "updates"}
        </span>
      )}
      {unsavedCount > 0 && (
        <span
          title="Editing in progress"
          className="inline-flex items-center gap-1 rounded border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500"
        >
          <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
          {unsavedCount} unsaved
        </span>
      )}
      <div className="flex-1" />
      <div className="relative w-56">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-dim" />
        <input
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="Filter skills…"
          className="h-7 w-full rounded-md border border-border bg-transparent pl-8 pr-2 text-xs outline-none placeholder:text-dim focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onScan}
        disabled={scanPending}
        className="h-7 gap-1.5 text-xs"
        title="Scan project workspaces for skills"
        aria-label="Scan"
      >
        <RefreshCw className={cn("size-3.5", scanPending && "animate-spin")} />
        Scan
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={onAddSkill}
        className="h-7 gap-1.5 text-xs"
        aria-label="Add skill"
      >
        <Plus className="size-3.5" />
        Add skill
      </Button>
    </header>
  );
}
