import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { IdCard, Building2, Target, Zap, type LucideIcon } from "lucide-react";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "@/lib/utils";
import type { MemoryItem } from "@armyofagents/shared";
import { LAYER_LABELS } from "../../lib/memoryItemView";
import { MemoryChip } from "./MemoryChip";

interface LayerTilesPanelProps {
  companyId: string;
}

type LayerKey = "identity" | "domain" | "active_context" | "working";

interface LayerSpec {
  key: LayerKey;
  Icon: LucideIcon;
  tone: string;
  description: string;
}

const LAYERS: LayerSpec[] = [
  { key: "identity",       Icon: IdCard,    tone: "var(--data-indigo)",  description: "Permanent — always in agent context" },
  { key: "domain",         Icon: Building2, tone: "var(--data-teal)",    description: "Department-scoped knowledge" },
  { key: "active_context", Icon: Target,    tone: "var(--data-amber)",   description: "Goal-scoped, expires" },
  { key: "working",        Icon: Zap,       tone: "var(--data-magenta)", description: "Task-ephemeral, 7d auto-archive" },
];

export function LayerTilesPanel({ companyId }: LayerTilesPanelProps) {
  const navigate = useNavigate();
  const { selectedCompany } = useCompany();
  const companyPrefix =
    (selectedCompany as { issuePrefix?: string } | null)?.issuePrefix ?? "";

  const { data: _listResponse } = useQuery({
    queryKey: queryKeys.memory.list(companyId),
    queryFn: () => memoryApi.list(companyId, {}),
    enabled: Boolean(companyId),
  });
  const items = _listResponse?.items;

  const counts = useMemo(() => {
    const result: Record<LayerKey, { total: number; pending: number }> = {
      identity: { total: 0, pending: 0 },
      domain: { total: 0, pending: 0 },
      active_context: { total: 0, pending: 0 },
      working: { total: 0, pending: 0 },
    };
    for (const it of (items ?? []) as Array<MemoryItem & { layer?: string }>) {
      const layer = it.layer as LayerKey | undefined;
      if (!layer || !(layer in result)) continue;
      result[layer].total += 1;
      if (it.status === "pending") result[layer].pending += 1;
    }
    return result;
  }, [items]);

  function openLayer(layer: LayerKey) {
    navigate(`/${companyPrefix}/memory/explore?layer=${layer}`);
  }

  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3">
        Layers
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
        {LAYERS.map((layer) => {
          const c = counts[layer.key];
          const itemLabel = c.total === 1 ? "item" : "items";
          return (
            <button
              key={layer.key}
              onClick={() => openLayer(layer.key)}
              className={cn(
                "text-left p-4 rounded-md border border-border bg-card",
                "hover:border-border-strong hover:bg-card-2 transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <div className="flex items-center gap-2 mb-2">
                <span
                  className="size-7 rounded-lg flex items-center justify-center bg-white/[0.04]"
                >
                  <layer.Icon className="size-4" style={{ color: layer.tone }} />
                </span>
                <div className="font-medium text-sm">{LAYER_LABELS[layer.key]}</div>
              </div>
              <div className="text-[11px] text-muted-foreground">
                {c.total} {itemLabel}
              </div>
              {c.pending > 0 && (
                <MemoryChip label={`${c.pending} pending`} tone="amber" className="mt-1" />
              )}
              <div className="text-[10px] text-muted-foreground/60 mt-2 leading-snug">
                {layer.description}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
