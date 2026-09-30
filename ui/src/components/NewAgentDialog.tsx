import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { AGENT_ROLES } from "@armyofagents/shared";
import type { UnifiedOrgNode } from "@armyofagents/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Minimize2,
  Maximize2,
  Shield,
  DollarSign,
} from "lucide-react";
import { cn, agentUrl } from "../lib/utils";
import { roleLabels } from "./agent-config-primitives";
import { AgentConfigForm, type CreateConfigValues } from "./AgentConfigForm";
import { defaultCreateValues } from "./agent-config-defaults";
import { getUIAdapter } from "../adapters";
import { filesystemApi } from "../api/filesystem";
import { ReportsToSelect, flattenOrgTree } from "./team/ReportsToSelect";

export function NewAgentDialog() {
  const { newAgentOpen, closeNewAgent } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [expanded, setExpanded] = useState(true);

  // Identity
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [role, setRole] = useState("general");
  const [parentValue, setParentValue] = useState(""); // "agent:id" | "user:id" | ""
  const [budgetDollars, setBudgetDollars] = useState("");

  // Config values (managed by AgentConfigForm)
  const [configValues, setConfigValues] = useState<CreateConfigValues>(defaultCreateValues);

  // Popover states
  const [roleOpen, setRoleOpen] = useState(false);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && newAgentOpen,
  });

  const { data: orgTree = [] } = useQuery<UnifiedOrgNode[]>({
    queryKey: selectedCompanyId ? queryKeys.org.tree(selectedCompanyId) : ["org", "none", "tree"],
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId && newAgentOpen,
  });

  const {
    data: adapterModels,
    error: adapterModelsError,
    isLoading: adapterModelsLoading,
    isFetching: adapterModelsFetching,
  } = useQuery({
    queryKey:
      selectedCompanyId
        ? queryKeys.agents.adapterModels(selectedCompanyId, configValues.adapterType)
        : ["agents", "none", "adapter-models", configValues.adapterType],
    queryFn: () => agentsApi.adapterModels(selectedCompanyId!, configValues.adapterType),
    enabled: Boolean(selectedCompanyId) && newAgentOpen,
  });

  const isFirstAgent = !agents || agents.length === 0;
  // First agent in a company auto-promotes to CXO tier (apex Chief of Staff).
  // Was `"ceo"` before the role-enum cleanup.
  const effectiveRole = isFirstAgent ? "cxo" : role;
  const [formError, setFormError] = useState<string | null>(null);

  // Auto-fill the apex agent name for the first hire.
  useEffect(() => {
    if (newAgentOpen && isFirstAgent) {
      if (!name) setName("Director");
      if (!title) setTitle("Director");
    }
  }, [newAgentOpen, isFirstAgent]); // eslint-disable-line react-hooks/exhaustive-deps

  // The backend auto-parents the first/rootless org agent to the founder (the
  // human root). Mirror that in the picker: once the org tree loads, default the
  // first agent's reports-to to the founder so the UI matches what gets created.
  useEffect(() => {
    if (!newAgentOpen || !isFirstAgent || parentValue) return;
    const humans = flattenOrgTree(orgTree).filter(
      (node) => node.nodeType === "user",
    );
    const founder =
      humans.find((node) => node.userRole === "founder") ?? humans[0];
    if (founder) setParentValue(`user:${founder.id}`);
  }, [newAgentOpen, isFirstAgent, orgTree]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-suggest cwd from company rootFolder when name changes
  const [cwdManuallyEdited, setCwdManuallyEdited] = useState(false);
  const rootFolder = selectedCompany?.rootFolder;
  useEffect(() => {
    if (!rootFolder || !name.trim() || cwdManuallyEdited) return;
    const isLocal = ["claude_local", "codex_local", "opencode_local", "cursor", "hermes_local", "gemini_local"].includes(configValues.adapterType);
    if (!isLocal) return;
    const sep = rootFolder.includes("\\") ? "\\" : "/";
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const suggestedCwd = `${rootFolder}${sep}agents${sep}${slug}`;
    if (!configValues.cwd) {
      setConfigValues((prev) => ({ ...prev, cwd: suggestedCwd }));
    }
  }, [rootFolder, name, configValues.adapterType, cwdManuallyEdited]); // eslint-disable-line react-hooks/exhaustive-deps

  const createAgent = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      agentsApi.hire(selectedCompanyId!, data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.org.tree(selectedCompanyId!) });
      reset();
      closeNewAgent();
      if (result.warnings?.length) {
        // The server corrected the provider/model (e.g. an incompatible codex
        // model resolved to gpt-5.5). The dialog navigates away on success, so a
        // toast is the equivalent surface to AgentDetail's inline AgentSaveWarnings.
        pushToast({
          title: "Model adjusted",
          body: result.warnings.join(" "),
          tone: "warn",
        });
      }
      navigate(agentUrl(result.agent));
    },
    onError: (error) => {
      setFormError(error instanceof Error ? error.message : "Failed to create agent");
    },
  });

  function reset() {
    setName("");
    setTitle("");
    setRole("general");
    setParentValue("");
    setBudgetDollars("");
    setConfigValues(defaultCreateValues);
    setCwdManuallyEdited(false);
    setExpanded(true);
    setFormError(null);
  }

  function buildAdapterConfig() {
    const adapter = getUIAdapter(configValues.adapterType);
    return adapter.buildAdapterConfig(configValues);
  }

  function handleSubmit() {
    if (!selectedCompanyId || !name.trim()) return;
    setFormError(null);
    if (configValues.adapterType === "opencode_local") {
      const selectedModel = configValues.model.trim();
      if (!selectedModel) {
        setFormError("OpenCode requires an explicit model in provider/model format.");
        return;
      }
      if (adapterModelsError) {
        setFormError(
          adapterModelsError instanceof Error
            ? adapterModelsError.message
            : "Failed to load OpenCode models.",
        );
        return;
      }
      if (adapterModelsLoading || adapterModelsFetching) {
        setFormError("OpenCode models are still loading. Please wait and try again.");
        return;
      }
      const discovered = adapterModels ?? [];
      if (!discovered.some((entry) => entry.id === selectedModel)) {
        setFormError(
          discovered.length === 0
            ? "No OpenCode models discovered. Run `opencode models` and authenticate providers."
            : `Configured OpenCode model is unavailable: ${selectedModel}`,
        );
        return;
      }
    }

    // Parse parent value
    let parentType: string | null = null;
    let parentId: string | null = null;
    let reportsTo: string | null = null;
    if (parentValue) {
      const [pType, pId] = parentValue.split(":");
      parentType = pType;
      parentId = pId;
      if (pType === "agent") reportsTo = pId;
    }

    // Parse budget
    const budgetCents = budgetDollars ? Math.round(parseFloat(budgetDollars) * 100) : 0;

    // Auto-create agent workspace folder if cwd is set
    const agentCwd = configValues.cwd?.trim();
    if (agentCwd) {
      filesystemApi.mkdir(agentCwd).catch(() => {});
    }

    createAgent.mutate({
      name: name.trim(),
      role: effectiveRole,
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(parentType ? { parentType, parentId } : {}),
      ...(reportsTo ? { reportsTo } : {}),
      adapterType: configValues.adapterType,
      adapterConfig: buildAdapterConfig(),
      runtimeConfig: {
        heartbeat: {
          enabled: configValues.heartbeatEnabled,
          intervalSec: configValues.intervalSec,
          wakeOnDemand: true,
          cooldownSec: 10,
          maxConcurrentRuns: 1,
        },
      },
      budgetMonthlyCents: budgetCents,
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <Dialog
      open={newAgentOpen}
      onOpenChange={(open) => {
        if (!open) { reset(); closeNewAgent(); }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn("p-0 gap-0 overflow-hidden", expanded ? "sm:max-w-2xl" : "sm:max-w-lg")}
        onKeyDown={handleKeyDown}
      >
        <DialogTitle className="sr-only">New agent</DialogTitle>
        <DialogDescription className="sr-only">Configure a new agent to assign tasks</DialogDescription>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {selectedCompany && (
              <span className="bg-muted px-1.5 py-0.5 rounded text-xs font-medium">
                {selectedCompany.name.slice(0, 3).toUpperCase()}
              </span>
            )}
            <span className="text-muted-foreground/60">&rsaquo;</span>
            <span>New agent</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => setExpanded(!expanded)}
              aria-label={expanded ? "Collapse dialog" : "Expand dialog"}
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => { reset(); closeNewAgent(); }}
              aria-label="Close new agent dialog"
            >
              <span className="text-lg leading-none">&times;</span>
            </Button>
          </div>
        </div>

        <div className="overflow-y-auto max-h-[70vh]">
          {/* Name */}
          <div className="px-4 pt-4 pb-2 shrink-0">
            <input
              className="w-full text-lg font-semibold bg-transparent outline-none placeholder:text-muted-foreground/50"
              placeholder="Agent name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          {/* Title */}
          <div className="px-4 pb-2">
            <input
              className="w-full bg-transparent outline-none text-sm text-muted-foreground placeholder:text-muted-foreground/40"
              placeholder="Title (e.g. VP of Engineering)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          {/* Property chips: Role + Reports To + Budget */}
          <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border flex-wrap">
            {/* Role */}
            <Popover open={roleOpen} onOpenChange={setRoleOpen}>
              <PopoverTrigger asChild>
                <button
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors",
                    isFirstAgent && "opacity-60 cursor-not-allowed"
                  )}
                  disabled={isFirstAgent}
                >
                  <Shield className="h-3 w-3 text-muted-foreground" />
                  {roleLabels[effectiveRole] ?? effectiveRole}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-36 p-1" align="start">
                {AGENT_ROLES.map((r) => (
                  <button
                    key={r}
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                      r === role && "bg-accent"
                    )}
                    onClick={() => { setRole(r); setRoleOpen(false); }}
                  >
                    {roleLabels[r] ?? r}
                  </button>
                ))}
              </PopoverContent>
            </Popover>

            {/* Reports To — unified select (agents + humans) */}
            <div className="inline-flex">
              <ReportsToSelect
                orgTree={orgTree}
                currentEntityId="__new__"
                currentEntityType="agent"
                value={parentValue}
                onChange={setParentValue}
                className="h-7 text-xs"
              />
            </div>

            {/* Budget */}
            <div className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1">
              <DollarSign className="h-3 w-3 text-muted-foreground" />
              <input
                className="w-16 bg-transparent outline-none text-xs placeholder:text-muted-foreground/40"
                placeholder="Budget/mo"
                value={budgetDollars}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "" || /^\d*\.?\d{0,2}$/.test(v)) setBudgetDollars(v);
                }}
                type="text"
                inputMode="decimal"
              />
            </div>
          </div>

          {/* Config form (adapter + heartbeat) */}
          <AgentConfigForm
            mode="create"
            values={configValues}
            onChange={(patch) => {
              if ("cwd" in patch) setCwdManuallyEdited(true);
              setConfigValues((prev) => ({ ...prev, ...patch }));
            }}
            adapterModels={adapterModels}
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
          <span className="text-xs text-muted-foreground">
            {isFirstAgent ? "This will be the Director" : ""}
          </span>
        </div>
        {formError && (
          <div className="px-4 pb-2 text-xs text-destructive">{formError}</div>
        )}
        <div className="flex items-center justify-end px-4 pb-3">
          <Button
            size="sm"
            disabled={!name.trim() || createAgent.isPending}
            onClick={handleSubmit}
          >
            {createAgent.isPending ? "Creating\u2026" : "Create agent"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
