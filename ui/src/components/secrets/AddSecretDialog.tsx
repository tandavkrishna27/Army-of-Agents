import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { CompanySecretProviderConfig, SecretProvider } from "@armyofagents/shared";
import type { CreateSecretInput } from "@/api/secrets";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { looksSensitiveKey, providerConfigSummary, providerLabel } from "./secret-ui";

type ManagedMode = NonNullable<CreateSecretInput["managedMode"]>;

interface AddSecretDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onSubmit(input: CreateSecretInput): void | Promise<unknown>;
  providerConfigs?: CompanySecretProviderConfig[];
  errorMessage?: string | null;
}

const LOCAL_PROVIDER: SecretProvider = "local_encrypted";

export function AddSecretDialog({
  open,
  onOpenChange,
  onSubmit,
  providerConfigs = [],
  errorMessage,
}: AddSecretDialogProps) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [managedMode, setManagedMode] = useState<ManagedMode>("aoa_managed");
  const [selectedProvider, setSelectedProvider] = useState<SecretProvider>(LOCAL_PROVIDER);
  const [selectedProviderConfigId, setSelectedProviderConfigId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const externalProviderConfigs = useMemo(
    () => providerConfigs.filter((config) => config.provider !== LOCAL_PROVIDER),
    [providerConfigs],
  );
  const providerOptions = useMemo(() => {
    const providers = new Set<SecretProvider>([LOCAL_PROVIDER]);
    providerConfigs.forEach((config) => providers.add(config.provider));
    return Array.from(providers);
  }, [providerConfigs]);

  useEffect(() => {
    if (!open) return;
    setName("");
    setKey("");
    setValue("");
    setDescription("");
    setExternalRef("");
    setManagedMode("aoa_managed");
    setSelectedProvider(LOCAL_PROVIDER);
    setSelectedProviderConfigId(null);
    setIsSubmitting(false);
  }, [open]);

  useEffect(() => {
    if (managedMode !== "external_reference") return;
    const currentConfig = externalProviderConfigs.find((config) => config.id === selectedProviderConfigId);
    if (currentConfig) {
      if (selectedProvider !== currentConfig.provider) setSelectedProvider(currentConfig.provider);
      return;
    }

    const defaultConfig = externalProviderConfigs[0] ?? null;
    setSelectedProvider(defaultConfig?.provider ?? LOCAL_PROVIDER);
    setSelectedProviderConfigId(defaultConfig?.id ?? null);
  }, [externalProviderConfigs, managedMode, selectedProvider, selectedProviderConfigId]);

  const availableProviderConfigs = providerConfigs.filter((config) => config.provider === selectedProvider);
  const isExternalReference = managedMode === "external_reference";
  const effectiveExternalProviderConfig = isExternalReference
    ? externalProviderConfigs.find((config) => config.id === selectedProviderConfigId) ?? externalProviderConfigs[0] ?? null
    : null;
  const submitProvider = effectiveExternalProviderConfig?.provider ?? selectedProvider;
  const submitProviderConfigId = effectiveExternalProviderConfig?.id ?? selectedProviderConfigId;
  const missingExternalProvider = isExternalReference && externalProviderConfigs.length === 0;
  const sensitiveKey = looksSensitiveKey(key);
  const canSubmit =
    name.trim().length > 0 &&
    (isExternalReference
      ? externalRef.trim().length > 0 && submitProvider !== LOCAL_PROVIDER && Boolean(submitProviderConfigId)
      : value.length > 0);

  function selectManagedMode(next: ManagedMode) {
    setManagedMode(next);
    if (next === "external_reference") {
      const defaultConfig = externalProviderConfigs[0] ?? null;
      setSelectedProvider(defaultConfig?.provider ?? LOCAL_PROVIDER);
      setSelectedProviderConfigId(defaultConfig?.id ?? null);
      return;
    }

    setSelectedProvider(LOCAL_PROVIDER);
    setSelectedProviderConfigId(null);
  }

  async function submitSecret() {
    if (!canSubmit || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        key: key.trim() || null,
        value: managedMode === "aoa_managed" ? value : null,
        provider: submitProvider,
        providerConfigId: submitProviderConfigId,
        managedMode,
        description: description.trim() || null,
        externalRef: managedMode === "external_reference" ? externalRef.trim() : null,
      });
      setValue("");
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
          <DialogTitle>Add secret</DialogTitle>
          <DialogDescription>
            Store an encrypted value or track an external vault reference. Values are hidden after save.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <DialogBody className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="secret-name">Name</Label>
              <Input
                id="secret-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="off"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="secret-key">Key</Label>
              <Input
                id="secret-key"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                autoComplete="off"
                className="font-mono text-xs"
              />
              {sensitiveKey && (
                <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  This key name looks sensitive. AoA will store values encrypted and keep them hidden after submit.
                </p>
              )}
            </div>

            <div className="grid gap-2">
              <Label>Managed mode</Label>
              <RadioGroup
                value={managedMode}
                onValueChange={(next) => selectManagedMode(next as ManagedMode)}
                className="grid gap-2 sm:grid-cols-2"
              >
                <label
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-card/40 p-3 text-sm"
                  onClick={() => selectManagedMode("aoa_managed")}
                >
                  <RadioGroupItem
                    value="aoa_managed"
                    aria-label="AoA managed"
                    onClick={() => selectManagedMode("aoa_managed")}
                  />
                  <span>
                    <span className="block font-medium">AoA managed</span>
                    <span className="block text-xs text-muted-foreground">Encrypted locally by AoA.</span>
                  </span>
                </label>
                <label
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-card/40 p-3 text-sm"
                  onClick={() => selectManagedMode("external_reference")}
                >
                  <RadioGroupItem
                    value="external_reference"
                    aria-label="External reference"
                    onClick={() => selectManagedMode("external_reference")}
                  />
                  <span>
                    <span className="block font-medium">External reference</span>
                    <span className="block text-xs text-muted-foreground">Store only the vault reference.</span>
                  </span>
                </label>
              </RadioGroup>
              {missingExternalProvider && (
                <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  Configure an external vault provider before adding external references.
                </p>
              )}
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="secret-provider">Provider</Label>
                <Select
                  value={selectedProvider}
                  onValueChange={(next) => {
                    setSelectedProvider(next as SecretProvider);
                    setSelectedProviderConfigId(null);
                  }}
                >
                  <SelectTrigger id="secret-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {providerOptions.map((provider) => (
                      <SelectItem key={provider} value={provider}>
                        {providerLabel(provider)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="secret-provider-config">Provider config</Label>
                <Select
                  value={(isExternalReference ? effectiveExternalProviderConfig?.id : selectedProviderConfigId) ?? "none"}
                  onValueChange={(next) => setSelectedProviderConfigId(next === "none" ? null : next)}
                  disabled={availableProviderConfigs.length === 0}
                >
                  <SelectTrigger id="secret-provider-config">
                    <SelectValue placeholder="Default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Default</SelectItem>
                    {availableProviderConfigs.map((config) => (
                      <SelectItem key={config.id} value={config.id}>
                        {config.displayName} - {providerConfigSummary(config)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="secret-value">Secret value</Label>
              <Input
                id="secret-value"
                type="password"
                value={isExternalReference ? "" : value}
                onChange={(event) => setValue(event.target.value)}
                disabled={isExternalReference}
                autoComplete="new-password"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="secret-external-ref">External reference</Label>
              <Input
                id="secret-external-ref"
                value={externalRef}
                onChange={(event) => setExternalRef(event.target.value)}
                disabled={!isExternalReference}
                autoComplete="off"
                className="font-mono text-xs"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="secret-description">Description</Label>
              <Textarea
                id="secret-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
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
            <Button type="button" disabled={!canSubmit || isSubmitting} onClick={() => void submitSecret()}>
              Add secret
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
