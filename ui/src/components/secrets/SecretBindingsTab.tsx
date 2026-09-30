import { useState, type FormEvent } from "react";
import { Link2, Plus, Trash2, X } from "lucide-react";
import {
  SECRET_BINDING_TARGET_TYPES,
  type CompanySecret,
  type CompanySecretBinding,
  type SecretBindingTargetType,
} from "@armyofagents/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CreateSecretBindingInput } from "@/api/secrets";

interface SecretBindingsTabProps {
  bindings: CompanySecretBinding[];
  secrets: CompanySecret[];
  errorMessage?: string | null;
  actionErrorMessage?: string | null;
  isCreatingBinding?: boolean;
  removingBindingId?: string | null;
  onCreateBinding?(input: CreateSecretBindingInput): Promise<unknown> | unknown;
  onRemoveBinding?(binding: CompanySecretBinding): Promise<unknown> | unknown;
}

function targetLabel(targetType: CompanySecretBinding["targetType"]) {
  return targetType.replace(/_/g, " ");
}

function bindingTargetLabel(targetType: SecretBindingTargetType) {
  return targetType.replace(/_/g, " ");
}

export function SecretBindingsTab({
  bindings,
  secrets,
  errorMessage,
  actionErrorMessage,
  isCreatingBinding = false,
  removingBindingId = null,
  onCreateBinding,
  onRemoveBinding,
}: SecretBindingsTabProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [targetType, setTargetType] = useState<SecretBindingTargetType>("agent");
  const [targetId, setTargetId] = useState("");
  const [configPath, setConfigPath] = useState("");
  const [versionSelector, setVersionSelector] = useState("latest");
  const [required, setRequired] = useState(true);
  const [label, setLabel] = useState("");
  const secretNameById = new Map(secrets.map((secret) => [secret.id, secret.name]));
  const canSubmit = Boolean(onCreateBinding && targetId.trim() && configPath.trim() && !isCreatingBinding);

  function resetForm() {
    setTargetType("agent");
    setTargetId("");
    setConfigPath("");
    setVersionSelector("latest");
    setRequired(true);
    setLabel("");
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    const trimmedVersion = versionSelector.trim();
    const numericVersion = Number(trimmedVersion);
    await onCreateBinding?.({
      targetType,
      targetId: targetId.trim(),
      configPath: configPath.trim(),
      versionSelector: trimmedVersion && trimmedVersion !== "latest" && Number.isInteger(numericVersion)
        ? numericVersion
        : "latest",
      required,
      label: label.trim() || null,
    });
    resetForm();
    setFormOpen(false);
  }

  const addBindingButton = onCreateBinding ? (
    <Button type="button" size="sm" variant="outline" onClick={() => setFormOpen(true)}>
      <Plus className="size-3.5" />
      Add binding
    </Button>
  ) : null;

  const form = formOpen ? (
    <form onSubmit={handleCreate} className="rounded-md border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Add binding</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Connect this secret to an agent, environment, routine, or system config path.
          </p>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Cancel binding"
          onClick={() => {
            resetForm();
            setFormOpen(false);
          }}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="secret-binding-target-type">Target type</Label>
          <select
            id="secret-binding-target-type"
            value={targetType}
            onChange={(event) => setTargetType(event.target.value as SecretBindingTargetType)}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm"
          >
            {SECRET_BINDING_TARGET_TYPES.map((type) => (
              <option key={type} value={type}>
                {bindingTargetLabel(type)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="secret-binding-target-id">Target id</Label>
          <Input
            id="secret-binding-target-id"
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            autoComplete="off"
            className="font-mono text-xs"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="secret-binding-config-path">Config path</Label>
          <Input
            id="secret-binding-config-path"
            value={configPath}
            onChange={(event) => setConfigPath(event.target.value)}
            autoComplete="off"
            placeholder="env.OPENAI_API_KEY"
            className="font-mono text-xs"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="secret-binding-label">Label</Label>
          <Input
            id="secret-binding-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="secret-binding-version">Version selector</Label>
          <Input
            id="secret-binding-version"
            value={versionSelector}
            onChange={(event) => setVersionSelector(event.target.value)}
            autoComplete="off"
            className="font-mono text-xs"
          />
        </div>
        <label className="flex items-center gap-2 self-end text-sm">
          <input
            type="checkbox"
            checked={required}
            onChange={(event) => setRequired(event.target.checked)}
          />
          Required binding
        </label>
      </div>
      {actionErrorMessage && (
        <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionErrorMessage}
        </p>
      )}
      <div className="mt-4 flex justify-end">
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {isCreatingBinding ? "Creating..." : "Create binding"}
        </Button>
      </div>
    </form>
  ) : null;

  if (errorMessage) {
    return (
      <section className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        <p>Failed to load bindings for this secret.</p>
        <p className="mt-1 text-xs text-destructive/80">{errorMessage}</p>
      </section>
    );
  }

  if (bindings.length === 0) {
    return (
      <div className="space-y-3">
        {form}
        <section className="flex min-h-[280px] flex-col items-center justify-center rounded-md border border-border bg-card px-6 py-10 text-center">
          <Link2 className="mb-3 size-8 text-muted-foreground/40" />
          <h3 className="text-sm font-semibold">No bindings for this secret</h3>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            Bindings will appear here when agents, environments, routines, or other targets reference this secret.
          </p>
          {!formOpen && <div className="mt-4">{addBindingButton}</div>}
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Bindings</h3>
          <p className="mt-1 text-xs text-muted-foreground">Where this secret is injected or required.</p>
        </div>
        {!formOpen && addBindingButton}
      </div>
      {form}
      {actionErrorMessage && !formOpen && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionErrorMessage}
        </p>
      )}
      <section className="overflow-hidden rounded-md border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="border-b border-border bg-accent/20 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Target id</th>
                <th className="px-3 py-2 font-medium">Config path</th>
                <th className="px-3 py-2 font-medium">Secret</th>
                <th className="px-3 py-2 font-medium">Required</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {bindings.map((binding) => (
                <tr key={binding.id} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-2">
                    <Badge variant="outline" className="capitalize">
                      {targetLabel(binding.targetType)}
                    </Badge>
                  </td>
                  <td className="max-w-[190px] px-3 py-2">
                    <div className="truncate font-mono text-xs">{binding.targetId}</div>
                  </td>
                  <td className="max-w-[220px] px-3 py-2">
                    <div className="truncate font-mono text-xs">{binding.configPath}</div>
                  </td>
                  <td className="max-w-[180px] px-3 py-2">
                    <div className="truncate">{secretNameById.get(binding.secretId) ?? binding.secretId}</div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="outline">{binding.required ? "Required" : "Optional"}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    {onRemoveBinding && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove binding ${binding.targetId}`}
                        disabled={removingBindingId === binding.id}
                        onClick={() => void onRemoveBinding(binding)}
                      >
                        <Trash2 className="size-3.5" />
                        {removingBindingId === binding.id ? "Removing..." : "Remove"}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
