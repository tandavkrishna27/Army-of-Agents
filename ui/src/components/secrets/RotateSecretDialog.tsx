import { useEffect, useState, type FormEvent } from "react";
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
import { Label } from "@/components/ui/label";

interface RotateSecretDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  secret: CompanySecret | null;
  impactedBindingCount: number;
  onSubmit(input: { value: string }): void | Promise<unknown>;
  errorMessage?: string | null;
}

export function RotateSecretDialog({
  open,
  onOpenChange,
  secret,
  impactedBindingCount,
  onSubmit,
  errorMessage,
}: RotateSecretDialogProps) {
  const [value, setValue] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValue("");
    setIsSubmitting(false);
  }, [open, secret?.id]);

  if (!secret) return null;

  const nextVersion = secret.latestVersion + 1;
  const canSubmit = value.trim().length > 0;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onSubmit({ value });
      setValue("");
    } catch {
      // Parent mutation state renders the visible error; keep the dialog open.
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rotate secret</DialogTitle>
          <DialogDescription>Create a new version without revealing the current value.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <DialogBody className="space-y-4">
            <div className="rounded-md border border-border bg-card/40 p-3">
              <div className="text-sm font-semibold">{secret.name}</div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="rounded-md border border-border px-2 py-1">v{secret.latestVersion} latest</span>
                <span>{impactedBindingCount} bindings impacted</span>
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="rotate-secret-value">New value</Label>
              <Input
                id="rotate-secret-value"
                type="password"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                autoComplete="new-password"
              />
            </div>
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
            <Button type="submit" disabled={!canSubmit || isSubmitting}>
              Create v{nextVersion}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
