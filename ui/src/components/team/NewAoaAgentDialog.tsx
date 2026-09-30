import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { agentsApi } from "../../api/agents";
import { queryKeys } from "../../lib/queryKeys";
import { useToast } from "../../context/ToastContext";
import { AGENT_ADAPTER_TYPES } from "@armyofagents/shared";
import {
  DEFAULT_CODEX_LOCAL_MODEL,
} from "@armyofagents/adapter-codex-local";
import { ModelDropdown } from "../AgentConfigForm";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface NewAoaAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  onSuccess: () => void;
}

export function NewAoaAgentDialog({
  open,
  onOpenChange,
  companyId,
  onSuccess,
}: NewAoaAgentDialogProps) {
  const { pushToast } = useToast();
  const [name, setName] = useState("");
  const [adapterType, setAdapterType] = useState<string>("process");
  const [model, setModel] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const { data: adapterModels } = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, adapterType),
    queryFn: () => agentsApi.adapterModels(companyId, adapterType),
    enabled: open && Boolean(companyId),
  });
  const models = adapterModels ?? [];

  function reset() {
    setName("");
    setAdapterType("process");
    setModel("");
    setFormError(null);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  }

  const createAgent = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      agentsApi.create(companyId, data),
    onSuccess: (result) => {
      onSuccess();
      pushToast({ title: "AoA agent created", tone: "success" });
      if (result.warnings?.length) {
        // Server corrected the provider/model (e.g. an incompatible codex model
        // resolved to gpt-5.5). The dialog closes on success, so surface as a toast.
        pushToast({ title: "Model adjusted", body: result.warnings.join(" "), tone: "warn" });
      }
      handleOpenChange(false);
    },
    onError: (error) => {
      setFormError(error instanceof Error ? error.message : "Failed to create agent");
    },
  });

  function handleSubmit() {
    if (!name.trim()) return;
    setFormError(null);
    const trimmedModel = model.trim();
    createAgent.mutate({
      name: name.trim(),
      adapterType,
      kind: "aoa",
      ...(trimmedModel ? { adapterConfig: { model: trimmedModel } } : {}),
      runtimeConfig: { aoa: { role: "member" } },
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle>New AoA Agent</DialogTitle>
          <DialogDescription>
            Create a new agent for the Commander team. It will be created as a member agent.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Name */}
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="aoa-agent-name">
              Name
            </label>
            <input
              id="aoa-agent-name"
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/50 focus:ring-1 focus:ring-ring"
              placeholder="Agent name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          {/* Adapter type */}
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="aoa-agent-adapter">
              Adapter
            </label>
            <Select
              defaultValue={adapterType}
              onValueChange={(v) => {
                setAdapterType(v);
                // The old adapter's model id is meaningless for the new adapter.
                setModel("");
              }}
            >
              <SelectTrigger id="aoa-agent-adapter">
                <SelectValue placeholder="Select adapter" />
              </SelectTrigger>
              <SelectContent>
                {AGENT_ADAPTER_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Model — only when the selected adapter exposes models */}
          {models.length > 0 && (
            <ModelDropdown
              models={models}
              value={model}
              onChange={setModel}
              open={modelOpen}
              onOpenChange={setModelOpen}
              allowDefault={adapterType !== "opencode_local"}
              required={adapterType === "opencode_local"}
              groupByProvider={adapterType === "opencode_local"}
              defaultLabel={adapterType === "codex_local" ? `Default → ${DEFAULT_CODEX_LOCAL_MODEL}` : undefined}
              defaultValue={adapterType === "codex_local" ? DEFAULT_CODEX_LOCAL_MODEL : ""}
            />
          )}

          {formError && (
            <p className="text-xs text-destructive">{formError}</p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
            disabled={createAgent.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!name.trim() || createAgent.isPending}
            onClick={handleSubmit}
          >
            {createAgent.isPending ? "Creating…" : "Create agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
