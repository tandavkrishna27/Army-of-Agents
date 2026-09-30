import { useMemo, useState } from "react";
import { CloudDownload, Plus } from "lucide-react";
import type { CompanySecret } from "@armyofagents/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  secretsApi,
  type CreateSecretInput,
  type CreateSecretBindingInput,
  type CreateSecretProviderConfigInput,
  type UpdateSecretInput,
} from "@/api/secrets";
import type { CreateRuntimeProviderKey, UpdateRuntimeProviderKey } from "@armyofagents/shared";
import { Button } from "@/components/ui/button";
import { ImportFromVaultDialog } from "@/pages/secrets/ImportFromVaultDialog";
import { queryKeys } from "@/lib/queryKeys";
import { useToast } from "@/context/ToastContext";
import { cn } from "@/lib/utils";
import { AddSecretDialog } from "./AddSecretDialog";
import { DeleteSecretDialog } from "./DeleteSecretDialog";
import { EditSecretDialog } from "./EditSecretDialog";
import { RotateSecretDialog } from "./RotateSecretDialog";
import { SecretAuditTab } from "./SecretAuditTab";
import { SecretBindingsTab } from "./SecretBindingsTab";
import { SecretEmptyState } from "./SecretEmptyState";
import { SecretInventoryTab } from "./SecretInventoryTab";
import { SecretVaultProvidersTab } from "./SecretVaultProvidersTab";
import { ProviderKeysTab } from "./ProviderKeysTab";

const TABS = [
  { id: "inventory", label: "Inventory" },
  { id: "bindings", label: "Bindings" },
  { id: "providerKeys", label: "Sandbox Providers" },
  { id: "vaults", label: "Vault providers" },
  { id: "audit", label: "Audit" },
] as const;
type SecretsTab = (typeof TABS)[number]["id"];

interface SecretsWorkspaceProps {
  companyId: string;
}

export function SecretsWorkspace({ companyId }: SecretsWorkspaceProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [activeTab, setActiveTab] = useState<SecretsTab>("inventory");
  const [selectedSecretId, setSelectedSecretId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [checkingVaultId, setCheckingVaultId] = useState<string | null>(null);
  const [rotateTarget, setRotateTarget] = useState<CompanySecret | null>(null);
  const [editTarget, setEditTarget] = useState<CompanySecret | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CompanySecret | null>(null);
  const secretsQuery = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
  });
  const providersQuery = useQuery({
    queryKey: queryKeys.secrets.providers(companyId),
    queryFn: () => secretsApi.providers(companyId),
  });
  const providerConfigsQuery = useQuery({
    queryKey: queryKeys.secrets.providerConfigs(companyId),
    queryFn: () => secretsApi.providerConfigs.list(companyId),
  });
  const runtimeProviderKeysQuery = useQuery({
    queryKey: queryKeys.secrets.runtimeProviderKeys(companyId),
    queryFn: () => secretsApi.runtimeProviderKeys.list(companyId),
  });
  const rotateBindingsQuery = useQuery({
    queryKey: rotateTarget ? queryKeys.secrets.bindings(rotateTarget.id) : ["secret-bindings", "__none__"],
    queryFn: () => secretsApi.bindings.list(rotateTarget!.id),
    enabled: Boolean(rotateTarget),
  });

  const selectedSecret = useMemo<CompanySecret | null>(() => {
    const secrets = secretsQuery.data ?? [];
    return secrets.find((secret) => secret.id === selectedSecretId) ?? secrets[0] ?? null;
  }, [secretsQuery.data, selectedSecretId]);

  const bindingsQuery = useQuery({
    queryKey: selectedSecret ? queryKeys.secrets.bindings(selectedSecret.id) : ["secret-bindings", "__none__"],
    queryFn: () => secretsApi.bindings.list(selectedSecret!.id),
    enabled: Boolean(selectedSecret && activeTab === "bindings"),
  });
  const accessEventsQuery = useQuery({
    queryKey: selectedSecret ? queryKeys.secrets.accessEvents(selectedSecret.id) : ["secret-access-events", "__none__"],
    queryFn: () => secretsApi.accessEvents(selectedSecret!.id),
    enabled: Boolean(selectedSecret && activeTab === "audit"),
  });

  const createSecret = useMutation({
    mutationFn: (input: CreateSecretInput) => secretsApi.create(companyId, input),
    onSuccess: (created) => {
      setSelectedSecretId(created.id);
      setAddOpen(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
    },
  });

  const createProviderConfig = useMutation({
    mutationFn: (input: CreateSecretProviderConfigInput) => secretsApi.providerConfigs.create(companyId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.providerConfigs(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.providers(companyId) });
      pushToast({ title: "Vault saved", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Vault save failed", body: err instanceof Error ? err.message : undefined, tone: "error" });
    },
  });

  const checkProviderConfig = useMutation({
    mutationFn: (id: string) => secretsApi.providerConfigs.check(id),
    onMutate: (id) => {
      setCheckingVaultId(id);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.providerConfigs(companyId) });
      pushToast({ title: "Vault checked", body: result.message ?? result.status, tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Vault check failed", body: err instanceof Error ? err.message : undefined, tone: "error" });
    },
    onSettled: () => {
      setCheckingVaultId(null);
    },
  });

  const rotateSecret = useMutation({
    mutationFn: ({ id, value }: { id: string; value: string }) => secretsApi.rotate(id, { value }),
    onSuccess: () => {
      setRotateTarget(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
    },
  });

  function patchSecretInCache(updated: CompanySecret) {
    queryClient.setQueryData<CompanySecret[]>(queryKeys.secrets.list(companyId), (current) =>
      current?.map((secret) => (secret.id === updated.id ? updated : secret)) ?? current,
    );
  }

  function removeSecretFromCache(secretId: string) {
    queryClient.setQueryData<CompanySecret[]>(queryKeys.secrets.list(companyId), (current) =>
      current?.filter((secret) => secret.id !== secretId) ?? current,
    );
  }

  const updateSecret = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateSecretInput }) => secretsApi.update(id, input),
    onSuccess: (updated) => {
      patchSecretInCache(updated);
      setSelectedSecretId(updated.id);
      setEditTarget(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
    },
  });

  const deleteSecret = useMutation({
    mutationFn: (id: string) => secretsApi.remove(id),
    onSuccess: (_result, id) => {
      removeSecretFromCache(id);
      setDeleteTarget(null);
      setSelectedSecretId(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
      pushToast({ title: "Secret deleted", tone: "success" });
    },
  });

  const createRuntimeProviderKey = useMutation({
    mutationFn: (input: CreateRuntimeProviderKey) => secretsApi.runtimeProviderKeys.create(companyId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.runtimeProviderKeys(companyId) });
      pushToast({ title: "Sandbox provider key saved", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Sandbox provider key save failed", body: err instanceof Error ? err.message : undefined, tone: "error" });
    },
  });

  const updateRuntimeProviderKey = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateRuntimeProviderKey }) =>
      secretsApi.runtimeProviderKeys.update(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.runtimeProviderKeys(companyId) });
      pushToast({ title: "Sandbox provider key updated", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Sandbox provider key update failed", body: err instanceof Error ? err.message : undefined, tone: "error" });
    },
  });

  const deleteRuntimeProviderKey = useMutation({
    mutationFn: (id: string) => secretsApi.runtimeProviderKeys.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.runtimeProviderKeys(companyId) });
      pushToast({ title: "Sandbox provider key deleted", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Sandbox provider key delete failed", body: err instanceof Error ? err.message : undefined, tone: "error" });
    },
  });

  const createBinding = useMutation({
    mutationFn: ({ secretId, input }: { secretId: string; input: CreateSecretBindingInput }) =>
      secretsApi.bindings.create(secretId, input),
    onSuccess: (_created, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.bindings(variables.secretId) });
      pushToast({ title: "Binding created", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Create binding failed", body: err instanceof Error ? err.message : undefined, tone: "error" });
    },
  });

  const removeBinding = useMutation({
    mutationFn: ({ bindingId }: { bindingId: string; secretId: string }) => secretsApi.bindings.remove(bindingId),
    onSuccess: (_removed, variables) => {
      queryClient.setQueryData(queryKeys.secrets.bindings(variables.secretId), (current: unknown) =>
        Array.isArray(current)
          ? current.filter((binding) => binding?.id !== variables.bindingId)
          : current,
        );
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.bindings(variables.secretId) });
      pushToast({ title: "Binding removed", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Remove binding failed", body: err instanceof Error ? err.message : undefined, tone: "error" });
    },
  });

  const secrets = secretsQuery.data ?? [];
  const providerConfigs = providerConfigsQuery.data ?? [];
  const importableProviderConfigs = providerConfigs.filter(
    (config) => config.provider === "aws_secrets_manager" && config.status !== "disabled",
  );
  const canImportFromVault = importableProviderConfigs.length > 0;
  const importButtonLabel = canImportFromVault ? "Import" : "Configure vault";
  const errorMessage = secretsQuery.error instanceof Error ? secretsQuery.error.message : null;
  const createErrorMessage = createSecret.error instanceof Error ? createSecret.error.message : null;
  const rotateErrorMessage = rotateSecret.error instanceof Error ? rotateSecret.error.message : null;
  const updateErrorMessage = updateSecret.error instanceof Error ? updateSecret.error.message : null;
  const bindingActionErrorMessage =
    createBinding.error instanceof Error
      ? createBinding.error.message
      : removeBinding.error instanceof Error
        ? removeBinding.error.message
        : null;
  const createProviderErrorMessage =
    createProviderConfig.error instanceof Error ? createProviderConfig.error.message : null;
  const providerKeyActionErrorMessage =
    createRuntimeProviderKey.error instanceof Error
      ? createRuntimeProviderKey.error.message
      : updateRuntimeProviderKey.error instanceof Error
        ? updateRuntimeProviderKey.error.message
        : deleteRuntimeProviderKey.error instanceof Error
          ? deleteRuntimeProviderKey.error.message
          : null;
  const statusUpdateSecretId =
    updateSecret.isPending &&
    (updateSecret.variables?.input.status === "active" || updateSecret.variables?.input.status === "disabled")
      ? updateSecret.variables.id
      : null;
  const disablingSecretId = updateSecret.variables?.input.status === "disabled" ? statusUpdateSecretId : null;
  const enablingSecretId = updateSecret.variables?.input.status === "active" ? statusUpdateSecretId : null;

  function openAddSecretDialog() {
    createSecret.reset();
    setAddOpen(true);
  }

  function renderSelectedSecretRequiredTab(tab: Exclude<SecretsTab, "inventory" | "vaults">) {
    if (!selectedSecret) {
      return (
        <section className="rounded-md border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
          Select a secret to view {tab === "bindings" ? "bindings" : "audit events"}.
        </section>
      );
    }

    if (tab === "bindings") {
      return (
        <SecretBindingsTab
          bindings={bindingsQuery.data ?? []}
          secrets={secrets}
          errorMessage={bindingsQuery.error instanceof Error ? bindingsQuery.error.message : null}
          actionErrorMessage={bindingActionErrorMessage}
          isCreatingBinding={createBinding.isPending}
          removingBindingId={removeBinding.isPending ? removeBinding.variables?.bindingId ?? null : null}
          onCreateBinding={(input) => {
            createBinding.reset();
            return createBinding.mutateAsync({ secretId: selectedSecret.id, input });
          }}
          onRemoveBinding={(binding) => {
            removeBinding.reset();
            return removeBinding.mutateAsync({ bindingId: binding.id, secretId: binding.secretId });
          }}
        />
      );
    }

    return (
      <SecretAuditTab
        events={accessEventsQuery.data ?? []}
        errorMessage={accessEventsQuery.error instanceof Error ? accessEventsQuery.error.message : null}
      />
    );
  }

  return (
    <div>
      <div className="border-b border-border px-8 pb-3 pt-6">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
          Settings - Operations
        </div>
        <div className="mt-1 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <h2 className="text-[1.4rem] font-bold tracking-tight">
              Secrets<span className="text-brand">.</span>
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Credentials and secret references used by agents, environments, departments, and integrations.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              title={
                canImportFromVault
                  ? "Import external references from a configured vault"
                  : "Configure an external vault provider before importing"
              }
              onClick={() => {
                if (canImportFromVault) {
                  setImportOpen(true);
                } else {
                  setActiveTab("vaults");
                }
              }}
            >
              <CloudDownload className="size-3.5" />
              {importButtonLabel}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={openAddSecretDialog}
            >
              <Plus className="size-3.5" />
              Add secret
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-8">
        <div
          role="tablist"
          aria-label="Secrets sections"
          className="inline-flex max-w-full flex-wrap gap-1 rounded-md border border-border bg-card p-1"
        >
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={cn(
                "h-[26px] rounded-[5px] px-2.5 text-xs font-semibold text-muted-foreground transition-colors",
                activeTab === tab.id && "bg-accent text-foreground",
              )}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {secretsQuery.isLoading ? (
          <div className="rounded-md border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
            Loading secrets...
          </div>
        ) : secretsQuery.isError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <p>Failed to load secrets. Please refresh and try again.</p>
            {errorMessage && <p className="mt-1 text-xs text-destructive/80">{errorMessage}</p>}
          </div>
        ) : activeTab === "inventory" && secrets.length === 0 ? (
          <SecretEmptyState
            onAddSecret={openAddSecretDialog}
            onImportFromVault={() => setImportOpen(true)}
            onConfigureVault={() => setActiveTab("vaults")}
            canImportFromVault={canImportFromVault}
            importDisabledReason="Configure an external vault provider before importing"
          />
        ) : activeTab === "inventory" ? (
          <SecretInventoryTab
            secrets={secrets}
            selectedSecret={selectedSecret}
            onSelectSecret={setSelectedSecretId}
            onEdit={(secret) => {
              updateSecret.reset();
              setEditTarget(secret);
            }}
            onRotate={(secret) => {
              rotateSecret.reset();
              setRotateTarget(secret);
            }}
            onDisable={(secret) => {
              updateSecret.reset();
              updateSecret.mutate(
                { id: secret.id, input: { status: "disabled" } },
                {
                  onSuccess: () => {
                    pushToast({ title: "Secret disabled", tone: "success" });
                  },
                  onError: (err) => {
                    pushToast({ title: "Disable failed", body: err instanceof Error ? err.message : undefined, tone: "error" });
                  },
                },
              );
            }}
            onEnable={(secret) => {
              updateSecret.reset();
              updateSecret.mutate(
                { id: secret.id, input: { status: "active" } },
                {
                  onSuccess: () => {
                    pushToast({ title: "Secret enabled", tone: "success" });
                  },
                  onError: (err) => {
                    pushToast({ title: "Enable failed", body: err instanceof Error ? err.message : undefined, tone: "error" });
                  },
                },
              );
            }}
            onDelete={(secret) => {
              deleteSecret.reset();
              setDeleteTarget(secret);
            }}
            disablingSecretId={disablingSecretId}
            enablingSecretId={enablingSecretId}
          />
        ) : activeTab === "bindings" ? (
          renderSelectedSecretRequiredTab("bindings")
        ) : activeTab === "providerKeys" ? (
          <ProviderKeysTab
            providerKeys={runtimeProviderKeysQuery.data ?? []}
            secrets={secrets}
            errorMessage={runtimeProviderKeysQuery.error instanceof Error ? runtimeProviderKeysQuery.error.message : null}
            actionErrorMessage={providerKeyActionErrorMessage}
            onCreate={(input) => createRuntimeProviderKey.mutateAsync(input)}
            onUpdate={(id, input) => updateRuntimeProviderKey.mutateAsync({ id, input })}
            onRemove={(id) => deleteRuntimeProviderKey.mutateAsync(id)}
          />
        ) : activeTab === "vaults" ? (
          <SecretVaultProvidersTab
            providers={providersQuery.data ?? []}
            providerConfigs={providerConfigs}
            onCreateAwsVault={(input) => createProviderConfig.mutateAsync(input)}
            onCheckVault={(id) => checkProviderConfig.mutateAsync(id)}
            createErrorMessage={createProviderErrorMessage}
            providersErrorMessage={providersQuery.error instanceof Error ? providersQuery.error.message : null}
            providerConfigsErrorMessage={
              providerConfigsQuery.error instanceof Error ? providerConfigsQuery.error.message : null
            }
            checkingVaultId={checkingVaultId}
            onAwsDialogOpenChange={() => createProviderConfig.reset()}
          />
        ) : activeTab === "audit" ? (
          renderSelectedSecretRequiredTab("audit")
        ) : (
          null
        )}
      </div>

      <AddSecretDialog
        open={addOpen}
        onOpenChange={(open) => {
          if (!open) createSecret.reset();
          setAddOpen(open);
        }}
        providerConfigs={providerConfigs}
        errorMessage={createErrorMessage}
        onSubmit={(input) => createSecret.mutateAsync(input)}
      />
      <EditSecretDialog
        open={Boolean(editTarget)}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
        secret={editTarget}
        errorMessage={updateErrorMessage}
        onSubmit={(input) => {
          if (!editTarget) return;
          return updateSecret.mutateAsync({ id: editTarget.id, input });
        }}
      />
      <RotateSecretDialog
        open={Boolean(rotateTarget)}
        onOpenChange={(open) => {
          if (!open) setRotateTarget(null);
        }}
        secret={rotateTarget}
        impactedBindingCount={rotateBindingsQuery.data?.length ?? 0}
        errorMessage={rotateErrorMessage}
        onSubmit={({ value }) => {
          if (!rotateTarget) return;
          return rotateSecret.mutateAsync({ id: rotateTarget.id, value });
        }}
      />
      <DeleteSecretDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) {
            deleteSecret.reset();
            setDeleteTarget(null);
          }
        }}
        secret={deleteTarget}
        errorMessage={deleteSecret.error instanceof Error ? deleteSecret.error.message : null}
        isDeleting={deleteSecret.isPending}
        onConfirm={async (secret) => {
          await deleteSecret.mutateAsync(secret.id);
        }}
      />
      <ImportFromVaultDialog
        companyId={companyId}
        open={importOpen}
        onOpenChange={setImportOpen}
        providerConfigs={providerConfigs}
        onImportCommitted={() => {
          queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
        }}
      />
    </div>
  );
}
