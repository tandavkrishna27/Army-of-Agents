import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../../api/agents";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";

interface AoaTrigger {
  id: string;
  kind: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}

export function AoaTriggersTab({
  agentId,
  companyId,
}: {
  agentId: string;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [newKind, setNewKind] = useState<"outbox" | "manual">("outbox");
  const [newEnabled, setNewEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const { data: triggers, isLoading } = useQuery({
    queryKey: ["triggers", agentId, companyId],
    queryFn: () => agentsApi.listTriggers(agentId, companyId),
  });

  const toggleTrigger = useMutation({
    mutationFn: ({ triggerId, enabled }: { triggerId: string; enabled: boolean }) =>
      agentsApi.patchTrigger(agentId, triggerId, companyId, { enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["triggers", agentId, companyId] });
    },
  });

  async function handleAddTrigger() {
    setSubmitting(true);
    try {
      await agentsApi.createTrigger(agentId, companyId, { kind: newKind, enabled: newEnabled });
      void queryClient.invalidateQueries({ queryKey: ["triggers", agentId, companyId] });
      setAddOpen(false);
      setNewKind("outbox");
      setNewEnabled(true);
    } finally {
      setSubmitting(false);
    }
  }

  const triggerList = (triggers ?? []) as AoaTrigger[];

  if (isLoading) {
    return (
      <div className="space-y-2">
        <div className="h-12 bg-accent/20 rounded-lg animate-pulse" />
        <div className="h-12 bg-accent/20 rounded-lg animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Triggers</h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAddOpen((v) => !v)}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add trigger
        </Button>
      </div>

      {/* Add trigger inline form */}
      {addOpen && (
        <div className="border border-border rounded-lg p-4 space-y-3 bg-accent/10">
          <h4 className="text-xs font-medium text-muted-foreground">New trigger</h4>
          <div className="flex items-center gap-3">
            <label className="text-xs text-muted-foreground">Kind</label>
            <select
              className="text-sm border border-border rounded px-2 py-1 bg-background"
              value={newKind}
              onChange={(e) => setNewKind(e.target.value as "outbox" | "manual")}
            >
              <option value="outbox">outbox</option>
              <option value="manual">manual</option>
            </select>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-muted-foreground">Enabled</label>
            <input
              type="checkbox"
              checked={newEnabled}
              onChange={(e) => setNewEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={handleAddTrigger}
              disabled={submitting}
            >
              {submitting ? "Adding…" : "Add"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAddOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Trigger list */}
      {triggerList.length === 0 ? (
        <p className="text-sm text-muted-foreground">No triggers configured yet.</p>
      ) : (
        <div className="border border-border rounded-lg divide-y divide-border">
          {triggerList.map((trigger) => (
            <div
              key={trigger.id}
              className="flex items-center justify-between px-4 py-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className={cn(
                    "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                    trigger.kind === "outbox"
                      ? "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
                      : "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
                  )}
                >
                  {trigger.kind}
                </span>
                {trigger.config && Object.keys(trigger.config).length > 0 && (
                  <span className="text-xs text-muted-foreground font-mono truncate">
                    {Object.entries(trigger.config)
                      .map(([k, v]) => `${k}=${String(v)}`)
                      .join(" ")}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <input
                  type="checkbox"
                  checked={trigger.enabled}
                  onChange={(e) =>
                    toggleTrigger.mutate({ triggerId: trigger.id, enabled: e.target.checked })
                  }
                  disabled={toggleTrigger.isPending}
                  className="h-4 w-4 rounded border-border cursor-pointer"
                  aria-label={`Toggle ${trigger.kind} trigger`}
                />
                <span className="text-xs text-muted-foreground">
                  {trigger.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
