import { useEffect, useState, type FormEvent } from "react";
import type { CreateSecretProviderConfigInput } from "@/api/secrets";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

interface AwsVaultDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onSubmit(input: CreateSecretProviderConfigInput): void | Promise<unknown>;
  errorMessage?: string | null;
}

export function AwsVaultDialog({ open, onOpenChange, onSubmit, errorMessage }: AwsVaultDialogProps) {
  const [displayName, setDisplayName] = useState("Production AWS");
  const [region, setRegion] = useState("us-east-1");
  const [secretNamePrefix, setSecretNamePrefix] = useState("aoa/prod");
  const [kmsKeyId, setKmsKeyId] = useState("");
  const [ownerTag, setOwnerTag] = useState("");
  const [environmentTag, setEnvironmentTag] = useState("");
  const [isDefault, setIsDefault] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDisplayName("Production AWS");
    setRegion("us-east-1");
    setSecretNamePrefix("aoa/prod");
    setKmsKeyId("");
    setOwnerTag("");
    setEnvironmentTag("");
    setIsDefault(true);
    setIsSubmitting(false);
  }, [open]);

  const canSubmit = displayName.trim().length > 0 && region.trim().length > 0 && secretNamePrefix.trim().length > 0;

  async function submit() {
    if (!canSubmit || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onSubmit({
        provider: "aws_secrets_manager",
        displayName: displayName.trim(),
        isDefault,
        config: {
          region: region.trim(),
          secretNamePrefix: secretNamePrefix.trim(),
          kmsKeyId: kmsKeyId.trim() || null,
          ownerTag: ownerTag.trim() || null,
          environmentTag: environmentTag.trim() || null,
        },
      });
      onOpenChange(false);
    } catch {
      // Parent mutation state renders the visible error; keep the dialog open.
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>AWS Secrets Manager</DialogTitle>
          <DialogDescription>Configure an external vault for secret references and imports.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <DialogBody className="space-y-4">
            <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              AoA does not ask for AWS access keys here. The server should already have AWS permissions through IAM role,
              deployment environment, or AWS CLI/profile. Use Check connection after saving.
            </p>

            <div className="grid gap-2">
              <Label htmlFor="aws-vault-name">Display name</Label>
              <Input id="aws-vault-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="aws-vault-region">Region</Label>
                <Input id="aws-vault-region" value={region} onChange={(event) => setRegion(event.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="aws-vault-prefix">Secret name prefix</Label>
                <Input
                  id="aws-vault-prefix"
                  value={secretNamePrefix}
                  onChange={(event) => setSecretNamePrefix(event.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="aws-vault-kms">KMS key id</Label>
              <Input
                id="aws-vault-kms"
                value={kmsKeyId}
                onChange={(event) => setKmsKeyId(event.target.value)}
                placeholder="Optional"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="aws-vault-owner-tag">Owner tag</Label>
                <Input
                  id="aws-vault-owner-tag"
                  value={ownerTag}
                  onChange={(event) => setOwnerTag(event.target.value)}
                  placeholder="Optional"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="aws-vault-environment-tag">Environment tag</Label>
                <Input
                  id="aws-vault-environment-tag"
                  value={environmentTag}
                  onChange={(event) => setEnvironmentTag(event.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={isDefault} onCheckedChange={(checked) => setIsDefault(checked === true)} />
              Default vault
            </label>

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
              Save AWS vault
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
