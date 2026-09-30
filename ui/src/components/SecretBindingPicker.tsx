import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanySecret, SecretBindingTargetType } from "@armyofagents/shared";
import { Check, KeyRound, Link2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatusBadge } from "@/components/StatusBadge";
import { secretsApi } from "@/api/secrets";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

export type SecretBindingPickerValue = {
  type: "secret_ref";
  secretId: string;
  version?: number | "latest";
} | null;

export interface SecretBindingPickerProps {
  companyId: string;
  value: SecretBindingPickerValue;
  onChange(value: SecretBindingPickerValue): void;
  configPath: string;
  targetType: SecretBindingTargetType;
  targetId: string;
  disabled?: boolean;
  secretsOverride?: CompanySecret[];
}

function secretLabel(secret: CompanySecret) {
  return secret.key || secret.name;
}

export function SecretBindingPicker({
  companyId,
  value,
  onChange,
  configPath,
  targetType,
  targetId,
  disabled,
  secretsOverride,
}: SecretBindingPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { data: secrets = [], isLoading } = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
    enabled: !!companyId && !secretsOverride,
  });
  const availableSecrets = secretsOverride ?? secrets;

  const selected = useMemo(
    () => availableSecrets.find((secret) => secret.id === value?.secretId) ?? null,
    [availableSecrets, value?.secretId],
  );
  const visibleSecrets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const active = availableSecrets.filter((secret) => secret.status === "active");
    if (!needle) return active;
    return active.filter((secret) =>
      [secret.name, secret.key, secret.description, secret.externalRef]
        .filter(Boolean)
        .some((part) => String(part).toLowerCase().includes(needle)),
    );
  }, [availableSecrets, query]);

  const selectSecret = (secret: CompanySecret) => {
    onChange({ type: "secret_ref", secretId: secret.id, version: "latest" });
    setOpen(false);
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            className="min-w-0 max-w-full justify-start"
            title={`${targetType}:${targetId} ${configPath}`}
          >
            <KeyRound className="size-3.5 shrink-0" />
            <span className="truncate">
              {selected ? secretLabel(selected) : "Bind secret"}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[360px] max-w-[calc(100vw-2rem)] p-2">
          <div className="space-y-2">
            <div className="flex items-center gap-2 rounded-md border border-border bg-field px-2">
              <Search className="size-3.5 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search secrets"
                className="h-7 border-0 bg-transparent px-0 focus-visible:ring-0"
              />
            </div>
            <div className="max-h-72 overflow-y-auto rounded-md border border-border">
              {isLoading ? (
                <div className="px-3 py-4 text-sm text-muted-foreground">Loading...</div>
              ) : visibleSecrets.length === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground">No active secrets</div>
              ) : (
                visibleSecrets.map((secret) => {
                  const isSelected = secret.id === value?.secretId;
                  return (
                    <button
                      key={secret.id}
                      type="button"
                      onClick={() => selectSecret(secret)}
                      className={cn(
                        "flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-accent/50",
                        isSelected && "bg-accent/60",
                      )}
                    >
                      <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{secretLabel(secret)}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {secret.provider} - v{secret.latestVersion}
                        </div>
                      </div>
                      <StatusBadge status={secret.status} />
                      {isSelected && <Check className="size-4 shrink-0 text-primary" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {selected && (
        <Badge variant="outline" className="hidden min-w-0 gap-1 sm:inline-flex">
          <span className="truncate">{configPath}</span>
        </Badge>
      )}
      {value && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          onClick={() => onChange(null)}
          title="Clear secret binding"
        >
          <X className="size-3.5" />
          <span className="sr-only">Clear secret binding</span>
        </Button>
      )}
    </div>
  );
}
