import { useEffect, useMemo, useState } from "react";
import type { CompanySecret, RuntimeProviderKey } from "@armyofagents/shared";
import type { CreateRuntimeProviderKey, UpdateRuntimeProviderKey } from "@armyofagents/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface ProviderKeyDialogProps {
  open: boolean;
  providerKey?: RuntimeProviderKey | null;
  secrets: CompanySecret[];
  errorMessage?: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: CreateRuntimeProviderKey | UpdateRuntimeProviderKey) => Promise<unknown> | unknown;
}

export function ProviderKeyDialog({
  open,
  providerKey,
  secrets,
  errorMessage,
  onOpenChange,
  onSubmit,
}: ProviderKeyDialogProps) {
  const [displayName, setDisplayName] = useState("");
  const [secretId, setSecretId] = useState("");
  const [isDefault, setIsDefault] = useState(true);
  const activeSecrets = useMemo(
    () => secrets.filter((secret) => secret.status === "active" && !secret.deletedAt),
    [secrets],
  );

  useEffect(() => {
    if (!open) return;
    setDisplayName(providerKey?.displayName ?? "Default E2B");
    setSecretId(providerKey?.secretId ?? activeSecrets[0]?.id ?? "");
    setIsDefault(providerKey?.isDefault ?? true);
  }, [activeSecrets, open, providerKey]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const payload = providerKey
      ? { displayName, secretId, isDefault }
      : { provider: "e2b" as const, displayName, secretId, isDefault };
    await onSubmit(payload);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{providerKey ? "Edit Sandbox Provider Key" : "New Sandbox Provider Key"}</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          {errorMessage && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {errorMessage}
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Provider</label>
            <Input value="E2B Sandbox" disabled />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="provider-key-display-name" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Display Name
            </label>
            <Input
              id="provider-key-display-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="provider-key-secret" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Secret</label>
            <select
              id="provider-key-secret"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={secretId}
              onChange={(event) => setSecretId(event.target.value)}
              required
            >
              {activeSecrets.length === 0 ? (
                <option value="">No active secrets</option>
              ) : (
                activeSecrets.map((secret) => (
                  <option key={secret.id} value={secret.id}>
                    {secret.name}{secret.key ? ` (${secret.key})` : ""}
                  </option>
                ))
              )}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              checked={isDefault}
              onChange={(event) => setIsDefault(event.target.checked)}
            />
            Use as company default for E2B
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!displayName.trim() || !secretId}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
