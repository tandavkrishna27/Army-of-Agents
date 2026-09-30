// ui/src/components/workspace/transcript/TranscriptProgressBlock.tsx

import { useState } from "react";
import { cn } from "@/lib/utils";
import { ListChecks, ChevronRight, ChevronDown, Check, Circle, Loader2 } from "lucide-react";

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

interface TranscriptProgressBlockProps {
  todos: TodoItem[];
  className?: string;
}

export function TranscriptProgressBlock({ todos, className }: TranscriptProgressBlockProps) {
  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  const allDone = completed === total;
  const [expanded, setExpanded] = useState(!allDone);
  const pct = total > 0 ? (completed / total) * 100 : 0;

  return (
    <div className={cn("rounded-lg", className)}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 h-10 rounded-lg bg-muted/30 hover:bg-muted/50 text-left transition-colors"
      >
        <ListChecks className="h-4 w-4 text-muted-foreground" />
        <span className="text-[13px] text-foreground/80">
          Tasks · {completed}/{total} complete
        </span>
        <div className="flex-1 mx-2 h-[3px] bg-neutral-200 dark:bg-neutral-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-emerald-500 rounded-full transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        {expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
      </button>
      {expanded && (
        <div className="ml-4 mt-1 mb-2 space-y-0.5">
          {todos.map((todo, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-1 text-xs">
              {todo.status === "completed" && <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />}
              {todo.status === "in_progress" && <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />}
              {todo.status === "pending" && <Circle className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />}
              <span className={cn(
                "text-foreground/80",
                todo.status === "completed" && "text-muted-foreground",
              )}>
                {todo.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
