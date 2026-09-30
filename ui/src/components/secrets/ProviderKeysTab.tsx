import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import type { CompanySecret, RuntimeProviderKey } from "@armyofagents/shared";
import type { CreateRuntimeProviderKey, UpdateRuntimeProviderKey } from "@armyofagents/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ProviderKeyDialog } from "./ProviderKeyDialog";

interface ProviderKeysTabProps {
  providerKeys: RuntimeProviderKey[];
  secrets: CompanySecret[];
  errorMessage?: string | null;
  actionErrorMessage?: string | null;
  onCreate: (input: CreateRuntimeProviderKey) => Promise<unknown>;
  onUpdate: (id: string, input: UpdateRuntimeProviderKey) => Promise<unknown>;
  onRemove: (id: string) => Promise<unknown>;
}

export function ProviderKeysTab({
  providerKeys,
  secrets,
  errorMessage,
  actionErrorMessage,
  onCreate,
  onUpdate,
  onRemove,
}: ProviderKeysTabProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<RuntimeProviderKey | null>(null);
  const secretById = new Map(secrets.map((secret) => [secret.id, secret]));

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Sandbox Providers</h3>
          <p className="text-xs text-muted-foreground">
            Company-level credentials for sandbox runtimes. Not used for CLI or LLM provider authentication.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            setEditTarget(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="size-3.5" />
          Add key
        </Button>
      </div>

      {(errorMessage || actionErrorMessage) && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {errorMessage ?? actionErrorMessage}
        </div>
      )}

      {providerKeys.length === 0 ? (
        <div className="rounded-md border border-border bg-card px-4 py-8 text-center">
          <KeyRound className="mx-auto mb-3 size-7 text-muted-foreground/40" />
          <p className="text-sm font-medium">No sandbox provider keys yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Add an E2B provider key backed by an existing secret.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border bg-card">
          {providerKeys.map((key) => {
            const secret = secretById.get(key.secretId);
            return (
              <div key={key.id} className="flex items-center gap-3 px-4 py-3">
                <KeyRound className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span>{key.displayName}</span>
                    {key.isDefault && (
                      <span className="rounded-sm bg-accent px-1.5 py-0.5 text-[11px] font-semibold text-accent-foreground">
                        Default
                      </span>
                    )}
                    <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
                      {key.status}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    E2B Sandbox - {secret ? secret.name : "Secret unavailable"}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  title="Edit sandbox provider key"
                  onClick={() => {
                    setEditTarget(key);
                    setDialogOpen(true);
                  }}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  title="Delete sandbox provider key"
                  onClick={() => onRemove(key.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <ProviderKeyDialog
        open={dialogOpen}
        providerKey={editTarget}
        secrets={secrets}
        errorMessage={actionErrorMessage}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditTarget(null);
        }}
        onSubmit={async (input) => {
          if (editTarget) {
            await onUpdate(editTarget.id, input as UpdateRuntimeProviderKey);
          } else {
            await onCreate(input as CreateRuntimeProviderKey);
          }
          setDialogOpen(false);
          setEditTarget(null);
        }}
      />
    </section>
  );
}
