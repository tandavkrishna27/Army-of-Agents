import { Cpu } from "lucide-react";
import { useLiveAgentCount } from "../../../hooks/useLiveAgentCount";
import { WidgetShell } from "./WidgetShell";
import { WidgetRowLink } from "./WidgetRowLink";
import type { WidgetProps } from "./types";

export function AgentsNowWidget({ editing }: WidgetProps) {
  const count = useLiveAgentCount();
  return (
    <WidgetShell title="Agents working now" icon={Cpu} to="/agents" editing={editing}>
      <WidgetRowLink to="/agents" editing={editing} className="flex items-center gap-3 rounded-md border border-border px-4 py-3 text-inherit no-underline transition-colors hover:bg-accent/50">
        <Cpu className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-2xl font-semibold leading-none tabular-nums">{count}</span>
        {count > 0 && <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />}
        <span className="text-sm text-muted-foreground">{count === 1 ? "agent" : "agents"} working now</span>
      </WidgetRowLink>
    </WidgetShell>
  );
}
