import { useMemo, useState } from "react";
import type { CompanySecret } from "@armyofagents/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface DeleteSecretDialogProps {
  open: boolean;
  secret: CompanySecret | null;
  errorMessage?: string | null;
  isDeleting?: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(secret: CompanySecret): Promise<void> | void;
}

export function DeleteSecretDialog({
  open,
  secret,
  errorMessage,
  isDeleting = false,
  onOpenChange,
  onConfirm,
}: DeleteSecretDialogProps) {
  const [typedValue, setTypedValue] = useState("");
  const confirmationText = useMemo(() => secret?.key || secret?.name || "", [secret]);
  const canDelete = Boolean(secret && confirmationText && typedValue === confirmationText && !isDeleting);

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) setTypedValue("");
    onOpenChange(nextOpen);
  }

  async function handleDelete() {
    if (!secret || !canDelete) return;
    await onConfirm(secret);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent aria-describedby="delete-secret-description" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete secret</DialogTitle>
          <DialogDescription id="delete-secret-description">
            This hides the secret from inventory. Agents or bindings that still reference it may fail until they are
            updated.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
            <div className="font-medium text-destructive">{secret?.name ?? "Selected secret"}</div>
            <div className="mt-1 font-mono text-xs text-muted-foreground">{confirmationText}</div>
          </div>
          <div className="space-y-2">
            <label htmlFor="delete-secret-confirmation" className="text-xs font-medium text-muted-foreground">
              Type {confirmationText} to confirm
            </label>
            <Input
              id="delete-secret-confirmation"
              value={typedValue}
              onChange={(event) => setTypedValue(event.target.value)}
              autoComplete="off"
            />
          </div>
          {errorMessage && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {errorMessage}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={isDeleting}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={!canDelete} onClick={handleDelete}>
            {isDeleting ? "Deleting..." : "Delete secret"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
