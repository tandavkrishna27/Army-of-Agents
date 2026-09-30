import { useEffect, useState, type FormEvent } from "react";
import type { CompanySecret } from "@armyofagents/shared";
import type { UpdateSecretInput } from "@/api/secrets";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { modeLabel, providerLabel } from "./secret-ui";

interface EditSecretDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  secret: CompanySecret | null;
  onSubmit(input: UpdateSecretInput): void | Promise<unknown>;
  errorMessage?: string | null;
}

export function EditSecretDialog({
  open,
  onOpenChange,
  secret,
  onSubmit,
  errorMessage,
}: EditSecretDialogProps) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !secret) return;

    setName(secret.name);
    setKey(secret.key ?? "");
    setDescription(secret.description ?? "");
    setExternalRef(secret.externalRef ?? "");
    setIsSubmitting(false);
  }, [open, secret]);

  if (!secret) return null;

  const canEditExternalRef = secret.managedMode === "external_reference";
  const canSubmit = name.trim().length > 0 && !isSubmitting;

  async function submitSecret() {
    if (!canSubmit) return;

    const input: UpdateSecretInput = {
      name: name.trim(),
      key: key.trim() || null,
      description: description.trim() || null,
    };
    if (canEditExternalRef) {
      input.externalRef = externalRef.trim() || null;
    }

    setIsSubmitting(true);
    try {
      await onSubmit(input);
    } catch {
      // Parent mutation state renders the visible error; keep the dialog open.
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitSecret();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit secret</DialogTitle>
          <DialogDescription>
            Update secret metadata. Value changes stay on the rotation path so version history remains intact.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <DialogBody className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="edit-secret-name">Name</Label>
                <Input
                  id="edit-secret-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="edit-secret-key">Key</Label>
                <Input
                  id="edit-secret-key"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  autoComplete="off"
                  className="font-mono text-xs"
                />
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="edit-secret-provider">Provider</Label>
                <Input id="edit-secret-provider" value={providerLabel(secret.provider)} disabled />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="edit-secret-managed-mode">Managed mode</Label>
                <Input id="edit-secret-managed-mode" value={modeLabel(secret.managedMode)} disabled />
              </div>
            </div>

            {canEditExternalRef && (
              <div className="grid gap-2">
                <Label htmlFor="edit-secret-external-ref">External reference</Label>
                <Input
                  id="edit-secret-external-ref"
                  value={externalRef}
                  onChange={(event) => setExternalRef(event.target.value)}
                  autoComplete="off"
                  className="font-mono text-xs"
                />
              </div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="edit-secret-description">Description</Label>
              <Textarea
                id="edit-secret-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
              />
            </div>

            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              Secret value is not editable here. Use Rotate value to create a new encrypted version.
            </p>

            {errorMessage && (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {errorMessage}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
