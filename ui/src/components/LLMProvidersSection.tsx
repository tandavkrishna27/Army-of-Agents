import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { useTeamAccess } from "../hooks/useTeamAccess";
import { secretsApi } from "../api/secrets";
import { memoryApi } from "../api/memory";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, HintIcon } from "./agent-config-primitives";
import {
  Brain,
  Plus,
  RotateCw,
  Trash2,
  Eye,
  EyeOff,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { cn } from "../lib/utils";

/**
 * Embeddings provider definitions.
 *
 * Extraction is now CLI-only (no hosted key) — the only hosted key AoA reads
 * is the OpenAI embeddings key, used solely for semantic memory search.
 * Secret naming convention: `llm:<providerId>` (e.g. `llm:openai`).
 */
const LLM_PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI",
    secretName: "llm:openai",
    icon: Brain,
    placeholder: "sk-...",
    envVar: "OPENAI_API_KEY",
  },
] as const;

type ProviderId = (typeof LLM_PROVIDERS)[number]["id"];

function maskKey(name: string, latestVersion: number): string {
  // We never have the real key in the frontend — just show that it's set
  return `••••••••  (v${latestVersion})`;
}

export function LLMProvidersSection() {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const { role } = useTeamAccess(selectedCompanyId);
  const isFounder = role === "founder";

  const [addingProvider, setAddingProvider] = useState<ProviderId | null>(null);
  const [newKey, setNewKey] = useState("");
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotateKey, setRotateKey] = useState("");
  const [showRotateKey, setShowRotateKey] = useState(false);
  const [showNewKey, setShowNewKey] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ secretId: string; label: string } | null>(null);
  const [reindexConfirmOpen, setReindexConfirmOpen] = useState(false);

  const { data: allSecrets = [], isLoading } = useQuery({
    queryKey: queryKeys.secrets.list(selectedCompanyId!),
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Semantic-search status — bound to the memory list's semanticAvailable flag.
  const { data: memoryList } = useQuery({
    queryKey: queryKeys.memory.list(selectedCompanyId!),
    queryFn: () => memoryApi.list(selectedCompanyId!, {}),
    enabled: !!selectedCompanyId,
  });
  const semanticAvailable = memoryList?.semanticAvailable ?? false;
  const memoryItemCount = memoryList?.items.length ?? 0;

  // Filter to only LLM secrets (name starts with "llm:")
  const llmSecrets = useMemo(
    () => allSecrets.filter((s) => s.name.startsWith("llm:")),
    [allSecrets],
  );

  const configuredProviderNames = useMemo(
    () => new Set(llmSecrets.map((s) => s.name)),
    [llmSecrets],
  );

  const unconfiguredProviders = useMemo(
    () => LLM_PROVIDERS.filter((p) => !configuredProviderNames.has(p.secretName)),
    [configuredProviderNames],
  );

  function invalidateProviderState() {
    queryClient.invalidateQueries({
      queryKey: queryKeys.secrets.list(selectedCompanyId!),
    });
  }

  const createMutation = useMutation({
    mutationFn: (data: { name: string; value: string; description: string }) =>
      secretsApi.create(selectedCompanyId!, data),
    onSuccess: () => {
      invalidateProviderState();
      setAddingProvider(null);
      setNewKey("");
      setShowNewKey(false);
      pushToast({ title: "API key saved", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: err instanceof Error ? err.message : "Failed to save key",
        tone: "warn",
      });
    },
  });

  const rotateMutation = useMutation({
    mutationFn: ({ id, value }: { id: string; value: string }) =>
      secretsApi.rotate(id, { value }),
    onSuccess: () => {
      invalidateProviderState();
      setRotatingId(null);
      setRotateKey("");
      setShowRotateKey(false);
      pushToast({ title: "API key rotated", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: err instanceof Error ? err.message : "Failed to rotate key",
        tone: "warn",
      });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => secretsApi.remove(id),
    onSuccess: () => {
      invalidateProviderState();
      pushToast({ title: "API key removed", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: err instanceof Error ? err.message : "Failed to remove key",
        tone: "warn",
      });
    },
  });

  const reindexAllMutation = useMutation({
    mutationFn: () => memoryApi.reindexAll(selectedCompanyId!),
    onSuccess: ({ reindexed }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.memory.list(selectedCompanyId!),
      });
      pushToast({
        title:
          reindexed > 0
            ? `Re-indexing ${reindexed} memory ${reindexed === 1 ? "item" : "items"}…`
            : "Nothing to re-index — all items are up to date.",
        tone: "success",
      });
    },
    onError: (err) => {
      // 403 (non-founder) and any other failure surface a clear message.
      pushToast({
        title: err instanceof Error ? err.message : "Failed to start re-indexing",
        tone: "warn",
      });
    },
  });

  function handleAdd(provider: (typeof LLM_PROVIDERS)[number]) {
    if (!newKey.trim()) return;
    createMutation.mutate({
      name: provider.secretName,
      value: newKey.trim(),
      description: `${provider.label} API key`,
    });
  }

  function handleRotate(secretId: string) {
    if (!rotateKey.trim()) return;
    rotateMutation.mutate({ id: secretId, value: rotateKey.trim() });
  }

  function handleRemove(secretId: string, label: string) {
    setRemoveTarget({ secretId, label });
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading providers...
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-border px-4 py-4">
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-xs text-muted-foreground">
          API key for the embeddings model, used only for semantic memory search.
        </span>
        <HintIcon text="Keys are stored encrypted. Discussion extraction is CLI-only and never reads this key — it powers meaning-based memory recall only." />
      </div>

      {/* Semantic-search status + founder-only re-index */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/20 px-3 py-2">
        <div
          data-testid="semantic-search-status"
          className={cn(
            "flex items-center gap-2 text-xs",
            semanticAvailable ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {semanticAvailable ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          )}
          <span>
            Semantic search:{" "}
            <span className="font-medium text-foreground">
              {semanticAvailable ? "on" : "off"}
            </span>
          </span>
        </div>
        {isFounder && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={reindexAllMutation.isPending}
            onClick={() => setReindexConfirmOpen(true)}
          >
            <RefreshCw
              className={cn("h-3 w-3 mr-1.5", reindexAllMutation.isPending && "animate-spin")}
            />
            Re-index all
          </Button>
        )}
      </div>

      {/* Configured providers */}
      {llmSecrets.map((secret) => {
        const provider = LLM_PROVIDERS.find((p) => p.secretName === secret.name);
        const Icon = provider?.icon ?? Brain;
        const label = provider?.label ?? secret.name;
        const isRotating = rotatingId === secret.id;

        return (
          <div
            key={secret.id}
            className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 px-3 py-2.5"
          >
            <div className="flex items-center gap-3">
              <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground font-mono">
                  {maskKey(secret.name, secret.latestVersion)}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    if (isRotating) {
                      setRotatingId(null);
                      setRotateKey("");
                      setShowRotateKey(false);
                    } else {
                      setRotatingId(secret.id);
                      setRotateKey("");
                      setShowRotateKey(false);
                    }
                  }}
                >
                  <RotateCw className="h-3 w-3 mr-1" />
                  {isRotating ? "Cancel" : "Rotate"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                  disabled={removeMutation.isPending}
                  onClick={() => handleRemove(secret.id, label)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>

            {/* Rotate form */}
            {isRotating && (
              <div className="flex items-center gap-2 pt-1">
                <div className="relative flex-1">
                  <input
                    type={showRotateKey ? "text" : "password"}
                    className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 pr-8 text-sm font-mono outline-none focus:ring-1 focus:ring-ring"
                    placeholder={provider?.placeholder ?? "New API key..."}
                    value={rotateKey}
                    onChange={(e) => setRotateKey(e.target.value)}
                    autoFocus
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowRotateKey(!showRotateKey)}
                  >
                    {showRotateKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <Button
                  size="sm"
                  className="h-8"
                  disabled={!rotateKey.trim() || rotateMutation.isPending}
                  onClick={() => handleRotate(secret.id)}
                >
                  {rotateMutation.isPending ? "Saving..." : "Save"}
                </Button>
              </div>
            )}
          </div>
        );
      })}

      {/* Add provider form */}
      {addingProvider && (() => {
        const provider = LLM_PROVIDERS.find((p) => p.id === addingProvider);
        if (!provider) return null;
        const Icon = provider.icon;
        return (
          <div className="rounded-md border border-blue-200 bg-blue-50/30 dark:border-blue-800/30 dark:bg-blue-900/10 px-3 py-3 space-y-2">
            <div className="flex items-center gap-2">
              <Icon className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">{provider.label}</span>
            </div>
            <Field label="API key" hint={`Environment variable: ${provider.envVar}`}>
              <div className="relative">
                <input
                  type={showNewKey ? "text" : "password"}
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 pr-8 text-sm font-mono outline-none focus:ring-1 focus:ring-ring"
                  placeholder={provider.placeholder}
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  autoFocus
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowNewKey(!showNewKey)}
                >
                  {showNewKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </Field>
            <div className="flex items-center gap-2 justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setAddingProvider(null);
                  setNewKey("");
                  setShowNewKey(false);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!newKey.trim() || createMutation.isPending}
                onClick={() => handleAdd(provider)}
              >
                {createMutation.isPending ? "Saving..." : "Save key"}
              </Button>
            </div>
          </div>
        );
      })()}

      {/* Add provider buttons */}
      {!addingProvider && unconfiguredProviders.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {unconfiguredProviders.map((provider) => {
            const Icon = provider.icon;
            return (
              <button
                key={provider.id}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground",
                  "hover:border-foreground/30 hover:text-foreground transition-colors",
                )}
                onClick={() => {
                  setAddingProvider(provider.id);
                  setNewKey("");
                  setShowNewKey(false);
                }}
              >
                <Plus className="h-3 w-3" />
                <Icon className="h-3 w-3" />
                {provider.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {llmSecrets.length === 0 && !addingProvider && (
        <p className="text-xs text-muted-foreground py-1">
          No embeddings key configured yet. Add one above to turn on semantic memory search.
        </p>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title={removeTarget ? `Remove the ${removeTarget.label} API key?` : "Remove API key?"}
        description="Semantic memory search will turn off until a new key is added."
        confirmLabel="Remove"
        onConfirm={() => {
          if (!removeTarget) return;
          removeMutation.mutate(removeTarget.secretId);
          setRemoveTarget(null);
        }}
      />

      <ConfirmDialog
        open={reindexConfirmOpen}
        onOpenChange={setReindexConfirmOpen}
        title="Re-index all memory?"
        description={
          memoryItemCount > 0
            ? `Re-embed ${memoryItemCount} memory ${memoryItemCount === 1 ? "item" : "items"}? Runs in the background and may take a while.`
            : "Re-embed all memory items? Runs in the background and may take a while."
        }
        confirmLabel="Re-index all"
        destructive={false}
        disabled={reindexAllMutation.isPending}
        onConfirm={() => {
          reindexAllMutation.mutate();
          setReindexConfirmOpen(false);
        }}
      />
    </div>
  );
}
