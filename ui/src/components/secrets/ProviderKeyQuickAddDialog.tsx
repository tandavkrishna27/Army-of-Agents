import { useEffect, useState } from "react";
import type { CreateRuntimeProviderKeyWithSecret } from "@armyofagents/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface ProviderKeyQuickAddDialogProps {
  open: boolean;
  errorMessage?: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: CreateRuntimeProviderKeyWithSecret) => Promise<unknown> | unknown;
}

/**
 * One-step "Add E2B key": paste a raw key, name it, done. Creates the company
 * secret AND its default provider key together via the combined endpoint. The
 * key input is masked and the value is never rendered back after submit.
 */
export function ProviderKeyQuickAddDialog({
  open,
  errorMessage,
  onOpenChange,
  onSubmit,
}: ProviderKeyQuickAddDialogProps) {
  const [displayName, setDisplayName] = useState("");
  const [value, setValue] = useState("");
  const [isDefault, setIsDefault] = useState(true);

  useEffect(() => {
    if (!open) return;
    setDisplayName("Default E2B");
    setValue("");
    setIsDefault(true);
  }, [open]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    await onSubmit({
      provider: "e2b",
      displayName: displayName.trim(),
      value,
      isDefault,
    });
    // Drop the pasted key from component memory as soon as it leaves the form.
    setValue("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add E2B key</DialogTitle>
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
            <label htmlFor="quick-provider-key-name" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Name
            </label>
            <Input
              id="quick-provider-key-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="quick-provider-key-value" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              API key
            </label>
            <Input
              id="quick-provider-key-value"
              type="password"
              autoComplete="off"
              placeholder="e2b_..."
              value={value}
              onChange={(event) => setValue(event.target.value)}
              required
            />
            <p className="text-[11px] text-muted-foreground">
              Stored as an encrypted company secret. It is never shown again after saving.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              checked={isDefault}
              onChange={(event) => setIsDefault(event.target.checked)}
            />
            Set as default for E2B
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!displayName.trim() || !value}>
              Add E2B key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
