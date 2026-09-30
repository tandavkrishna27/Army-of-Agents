import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { INBOUND_ROUTING_LEVELS } from "@armyofagents/shared";
import { internalAgentApi } from "../../api/internal-agent";
import { cn } from "../../lib/utils";
import { ChevronDown, Route } from "lucide-react";

interface RoutingDialControlProps {
  companyId: string;
  canEdit?: boolean;
  variant?: "inline" | "icon";
}

export function RoutingDialControl({ companyId, canEdit = true, variant = "inline" }: RoutingDialControlProps) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const queryKey = ["internal-agent-config", companyId];

  const { data: config } = useQuery({
    queryKey,
    queryFn: () => internalAgentApi.getConfig(companyId),
    enabled: !!companyId,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: (level: string) =>
      internalAgentApi.updateConfig(companyId, { inboundRoutingLevel: level }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const currentLevel = config?.inboundRoutingLevel ?? "off";
  const currentEntry = INBOUND_ROUTING_LEVELS.find((l) => l.value === currentLevel);
  const blurb = currentEntry?.blurb ?? "";

  const setLevel = (level: string) => {
    if (level !== currentLevel) {
      mutation.mutate(level);
    }
    setOpen(false);
  };

  if (variant === "icon") {
    return (
      <div className="relative">
        <button
          type="button"
          data-testid="routing-dial"
          title={blurb || "Inbound routing"}
          aria-label="Auto-routing"
          aria-expanded={open}
          disabled={!canEdit || mutation.isPending}
          onClick={() => setOpen((value) => !value)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Route className="size-3.5" aria-hidden />
          <span className="hidden sm:inline">{currentEntry?.name ?? "Routing"}</span>
          <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} aria-hidden />
        </button>
        {open && (
          <div className="absolute right-0 top-9 z-40 w-60 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
            {INBOUND_ROUTING_LEVELS.map((level) => (
              <button
                key={level.value}
                type="button"
                onClick={() => setLevel(level.value)}
                className={cn(
                  "flex w-full flex-col rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground",
                  currentLevel === level.value && "bg-accent text-accent-foreground",
                )}
              >
                <span className="text-xs font-medium">{level.name}</span>
                <span className="text-[11px] leading-snug text-muted-foreground">{level.blurb}</span>
              </button>
            ))}
            {mutation.isError && (
              <p className="px-2 py-1 text-xs text-destructive">Failed to save</p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor="routing-dial-select"
        className="text-xs font-medium text-muted-foreground whitespace-nowrap"
      >
        Auto-routing
      </label>
      <select
        id="routing-dial-select"
        data-testid="routing-dial"
        title={blurb}
        value={currentLevel}
        disabled={!canEdit || mutation.isPending}
        onChange={(e) => {
          setLevel(e.target.value);
        }}
        className="h-7 rounded-md border border-input bg-background px-2 py-0.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        {INBOUND_ROUTING_LEVELS.map((level) => (
          <option key={level.value} value={level.value}>
            {level.name}
          </option>
        ))}
      </select>
      {mutation.isError && (
        <span className="text-xs text-destructive">Failed to save</span>
      )}
    </div>
  );
}
