import { useState } from "react";
import { Cloud, CloudOff, ShieldCheck } from "lucide-react";
import type {
  CompanySecretProviderConfig,
  SecretProviderConfigHealthResponse,
  SecretProviderDescriptor,
} from "@armyofagents/shared";
import type { CreateSecretProviderConfigInput } from "@/api/secrets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AwsVaultDialog } from "./AwsVaultDialog";
import { formatSecretDate, providerConfigSummary, providerLabel } from "./secret-ui";

interface SecretVaultProvidersTabProps {
  providerConfigs: CompanySecretProviderConfig[];
  providers?: SecretProviderDescriptor[];
  onCreateAwsVault(input: CreateSecretProviderConfigInput): void | Promise<unknown>;
  onCheckVault(id: string): void | Promise<SecretProviderConfigHealthResponse | unknown>;
  createErrorMessage?: string | null;
  providersErrorMessage?: string | null;
  providerConfigsErrorMessage?: string | null;
  checkingVaultId?: string | null;
  onAwsDialogOpenChange?(open: boolean): void;
}

function statusClassName(status: string | null | undefined) {
  if (status === "ready" || status === "success") {
    return "border-emerald-500/35 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  }
  if (status === "error" || status === "failure") {
    return "border-destructive/35 bg-destructive/10 text-destructive";
  }
  if (status === "warning") {
    return "border-amber-500/35 bg-amber-500/10 text-amber-600 dark:text-amber-400";
  }
  if (status === "disabled") return "border-muted-foreground/30 bg-muted text-muted-foreground";
  return "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-300";
}

function statusLabel(status: string | null | undefined) {
  if (!status) return "Not checked";
  return status.replace(/_/g, " ");
}

export function SecretVaultProvidersTab({
  providerConfigs,
  providers = [],
  onCreateAwsVault,
  onCheckVault,
  createErrorMessage,
  providersErrorMessage,
  providerConfigsErrorMessage,
  checkingVaultId,
  onAwsDialogOpenChange,
}: SecretVaultProvidersTabProps) {
  const [awsOpen, setAwsOpen] = useState(false);
  const futureProviders = providers.filter(
    (provider) =>
      provider.id !== "local_encrypted" &&
      provider.id !== "aws_secrets_manager" &&
      !providerConfigs.some((config) => config.provider === provider.id),
  );

  function setAwsDialogOpen(open: boolean) {
    setAwsOpen(open);
    onAwsDialogOpenChange?.(open);
  }

  return (
    <div className="space-y-4">
      {(providersErrorMessage || providerConfigsErrorMessage) && (
        <section className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {providersErrorMessage && (
            <p>
              Failed to load provider descriptors.
              <span className="ml-1 text-xs text-destructive/80">{providersErrorMessage}</span>
            </p>
          )}
          {providerConfigsErrorMessage && (
            <p>
              Failed to load configured vaults.
              <span className="ml-1 text-xs text-destructive/80">{providerConfigsErrorMessage}</span>
            </p>
          )}
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-md border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">Local encrypted</h3>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                AoA-managed values are encrypted locally and hidden after save.
              </p>
            </div>
            <Badge variant="outline" className="shrink-0">
              Default vault
            </Badge>
          </div>
        </section>

        <section className="rounded-md border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Cloud className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">AWS Secrets Manager</h3>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Store external references and import existing AWS secrets without saving raw values in AoA.
              </p>
            </div>
            <Button type="button" size="sm" onClick={() => setAwsDialogOpen(true)}>
              Configure AWS vault
            </Button>
          </div>
        </section>
      </div>

      <section className="rounded-md border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">Configured vaults</h3>
          <Badge variant="outline">{providerConfigs.length}</Badge>
        </div>
        {providerConfigs.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">No external vaults configured.</div>
        ) : (
          <div className="divide-y divide-border">
            {providerConfigs.map((config) => {
              const status = config.healthStatus ?? config.status;
              return (
                <div key={config.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold">{config.displayName}</span>
                      <Badge variant="outline" className={cn("capitalize", statusClassName(status))}>
                        {statusLabel(status)}
                      </Badge>
                      {config.isDefault && <Badge variant="outline">Default</Badge>}
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {providerLabel(config.provider)} - {providerConfigSummary(config)}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Checked {formatSecretDate(config.healthCheckedAt)}
                      {config.healthMessage ? ` - ${config.healthMessage}` : ""}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onCheckVault(config.id)}
                    disabled={checkingVaultId === config.id}
                  >
                    Check
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {futureProviders.length > 0 && (
        <section className="grid gap-3 sm:grid-cols-2">
          {futureProviders.map((provider) => (
            <div key={provider.id} className="rounded-md border border-border bg-card/50 p-4 opacity-75">
              <div className="flex items-center gap-2">
                <CloudOff className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">{provider.label}</h3>
                <Badge variant="outline">Coming soon</Badge>
              </div>
            </div>
          ))}
        </section>
      )}

      <AwsVaultDialog
        open={awsOpen}
        onOpenChange={setAwsDialogOpen}
        onSubmit={onCreateAwsVault}
        errorMessage={createErrorMessage}
      />
    </div>
  );
}
