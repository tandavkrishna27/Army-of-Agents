import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, EyeOff, KeyRound, MoreHorizontal, Pencil, Power, RefreshCw, Trash2, X } from "lucide-react";
import type { CompanySecret } from "@armyofagents/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatSecretDate, modeLabel, providerLabel } from "./secret-ui";

interface SecretInventoryTabProps {
  secrets: CompanySecret[];
  selectedSecret: CompanySecret | null;
  onSelectSecret(id: string): void;
  onEdit?(secret: CompanySecret): void;
  onRotate?(secret: CompanySecret): void;
  onDisable?(secret: CompanySecret): void;
  onEnable?(secret: CompanySecret): void;
  onDelete?(secret: CompanySecret): void;
  disablingSecretId?: string | null;
  enablingSecretId?: string | null;
}

function statusLabel(status: CompanySecret["status"]): string {
  if (status === "disabled") return "Disabled";
  if (status === "archived") return "Archived";
  return "Active";
}

function statusClassName(status: CompanySecret["status"]): string {
  if (status === "active") return "border-emerald-500/35 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  if (status === "disabled") return "border-amber-500/35 bg-amber-500/10 text-amber-600 dark:text-amber-400";
  return "border-muted-foreground/30 bg-muted text-muted-foreground";
}

function includesQuery(secret: CompanySecret, query: string): boolean {
  if (!query) return true;
  const searchable = [
    secret.name,
    secret.key,
    secret.description,
    secret.externalRef,
    providerLabel(secret.provider),
    modeLabel(secret.managedMode),
    secret.status,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return searchable.includes(query);
}

export function SecretInventoryTab({
  secrets,
  selectedSecret,
  onSelectSecret,
  onEdit,
  onRotate,
  onDisable,
  onEnable,
  onDelete,
  disablingSecretId,
  enablingSecretId,
}: SecretInventoryTabProps) {
  const [search, setSearch] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(Boolean(selectedSecret));
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);
  const copyStatusTimer = useRef<number | null>(null);
  const normalizedSearch = search.trim().toLowerCase();
  const filteredSecrets = useMemo(
    () => secrets.filter((secret) => includesQuery(secret, normalizedSearch)),
    [normalizedSearch, secrets],
  );
  const visibleSelectedSecret =
    selectedSecret && filteredSecrets.some((secret) => secret.id === selectedSecret.id) ? selectedSecret : null;
  const visibleSelectedSecretId = visibleSelectedSecret?.id ?? null;
  const previousSelectedSecretId = useRef<string | null>(visibleSelectedSecretId);
  const canRotateSelectedSecret =
    Boolean(onRotate) && visibleSelectedSecret?.managedMode === "aoa_managed" && visibleSelectedSecret.status === "active";
  const canDisableSelectedSecret = Boolean(onDisable) && visibleSelectedSecret?.status === "active";
  const canEnableSelectedSecret = Boolean(onEnable) && visibleSelectedSecret?.status === "disabled";
  const isDisablingSelectedSecret = Boolean(
    visibleSelectedSecret && disablingSecretId === visibleSelectedSecret.id,
  );
  const isEnablingSelectedSecret = Boolean(
    visibleSelectedSecret && enablingSecretId === visibleSelectedSecret.id,
  );
  const selectedReference = visibleSelectedSecret
    ? `{{secret:${visibleSelectedSecret.key ?? visibleSelectedSecret.id}}}`
    : "";
  const hasAdminActions = Boolean(onEdit || canDisableSelectedSecret || onDelete);

  useEffect(() => {
    if (visibleSelectedSecretId && previousSelectedSecretId.current !== visibleSelectedSecretId) {
      setDrawerOpen(true);
    }
    previousSelectedSecretId.current = visibleSelectedSecretId;
  }, [visibleSelectedSecretId]);

  useEffect(() => {
    return () => {
      if (copyStatusTimer.current) window.clearTimeout(copyStatusTimer.current);
    };
  }, []);

  async function copySelectedReference() {
    if (!selectedReference) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(selectedReference);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
    if (copyStatusTimer.current) window.clearTimeout(copyStatusTimer.current);
    copyStatusTimer.current = window.setTimeout(() => setCopyStatus(null), 1600);
  }

  return (
    <div
      className={cn(
        "grid min-h-[420px] gap-4",
        drawerOpen && visibleSelectedSecret ? "lg:grid-cols-[minmax(0,1fr)_380px]" : "grid-cols-1",
      )}
    >
      <section className="min-w-0 rounded-md border border-border bg-card">
        <div className="border-b border-border p-3">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name, key, department"
            aria-label="Search secrets"
            className="h-9"
          />
        </div>

        {filteredSecrets.length === 0 ? (
          <div className="flex min-h-[280px] flex-col items-center justify-center px-6 py-10 text-center">
            <KeyRound className="mb-3 size-8 text-muted-foreground/40" />
            <h3 className="text-sm font-semibold">No secrets match your search</h3>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              Try another name, key, department, provider, or status.
            </p>
          </div>
        ) : (
          <div className="space-y-3 p-3">
            {filteredSecrets.map((secret) => (
              <button
                key={secret.id}
                data-testid={`secret-card-${secret.id}`}
                type="button"
                aria-current={visibleSelectedSecret?.id === secret.id ? "true" : undefined}
                onClick={() => {
                  onSelectSecret(secret.id);
                  setDrawerOpen(true);
                }}
                className={cn(
                  "block w-full rounded-lg border border-border bg-background/70 px-4 py-3 text-left shadow-sm transition-colors hover:border-border-strong hover:bg-accent/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus-ring",
                  visibleSelectedSecret?.id === secret.id &&
                    "border-brand/55 bg-accent shadow-[inset_3px_0_0_theme(colors.brand.DEFAULT)]",
                )}
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-foreground">{secret.name}</div>
                    <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                      {secret.key ?? "No key assigned"}
                    </div>
                  </div>
                  <Badge variant="outline" className={cn("shrink-0 text-[10px]", statusClassName(secret.status))}>
                    {statusLabel(secret.status)}
                  </Badge>
                </div>
                {secret.description && (
                  <div className="mt-3 line-clamp-2 text-xs text-muted-foreground">{secret.description}</div>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{providerLabel(secret.provider)}</span>
                  <span aria-hidden="true">/</span>
                  <span>{modeLabel(secret.managedMode)}</span>
                  <span aria-hidden="true">/</span>
                  <span>v{secret.latestVersion}</span>
                  <span aria-hidden="true">/</span>
                  <span>Last read {formatSecretDate(secret.lastResolvedAt)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {drawerOpen && visibleSelectedSecret && (
        <aside
          role="complementary"
          aria-label="Secret preview"
          className="min-w-0 overflow-hidden rounded-xl border border-border bg-card shadow-lg"
        >
          <div className="flex h-full flex-col">
            <div className="flex items-start justify-between gap-3 border-b border-border p-4">
              <div className="min-w-0">
                <h3 className="truncate text-base font-semibold">{visibleSelectedSecret.name}</h3>
                <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  {visibleSelectedSecret.key ?? "No key assigned"}
                </div>
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <EyeOff className="size-3.5" />
                  <span>Value hidden after save</span>
                </div>
              </div>
              <div className="flex shrink-0 items-start gap-2">
                <Badge
                  variant="outline"
                  className={cn("shrink-0 text-[10px]", statusClassName(visibleSelectedSecret.status))}
                >
                  {statusLabel(visibleSelectedSecret.status)}
                </Badge>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Close preview"
                  onClick={() => setDrawerOpen(false)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            </div>

            <div className="border-b border-border p-4">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <div className="grid min-w-0 grid-cols-2 gap-2">
                  {canRotateSelectedSecret && (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => onRotate?.(visibleSelectedSecret)}
                    >
                      <RefreshCw className="size-3.5" />
                      Rotate value
                    </Button>
                  )}
                  {canEnableSelectedSecret && (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={isEnablingSelectedSecret}
                      onClick={() => onEnable?.(visibleSelectedSecret)}
                    >
                      {isEnablingSelectedSecret ? "Enabling..." : "Enable"}
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="outline" onClick={copySelectedReference}>
                    <Copy className="size-3.5" />
                    Copy ref
                  </Button>
                </div>
                {hasAdminActions && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" size="icon" variant="outline" aria-label="More actions" title="More actions">
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      {onEdit && (
                        <DropdownMenuItem onSelect={() => onEdit(visibleSelectedSecret)}>
                          <Pencil className="size-3.5" />
                          Edit metadata
                        </DropdownMenuItem>
                      )}
                      {canDisableSelectedSecret && (
                        <DropdownMenuItem
                          disabled={isDisablingSelectedSecret}
                          onSelect={() => onDisable?.(visibleSelectedSecret)}
                        >
                          <Power className="size-3.5" />
                          {isDisablingSelectedSecret ? "Disabling..." : "Disable"}
                        </DropdownMenuItem>
                      )}
                      {onDelete && (
                        <>
                          {(onEdit || canDisableSelectedSecret) && <DropdownMenuSeparator />}
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={() => onDelete(visibleSelectedSecret)}
                          >
                            <Trash2 className="size-3.5" />
                            Delete
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              {copyStatus && (
                <div role="status" className="mt-2 text-xs text-muted-foreground">
                  {copyStatus === "copied" ? "Copied ref" : "Copy failed"}
                </div>
              )}
              {canDisableSelectedSecret && isDisablingSelectedSecret && (
                <div role="status" className="mt-2 text-xs text-muted-foreground">
                  Disabling secret...
                </div>
              )}
            </div>

            <dl className="grid gap-3 p-4 text-sm sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Key</dt>
                <dd className="mt-1 truncate font-mono text-xs">{visibleSelectedSecret.key ?? "Not assigned"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Provider</dt>
                <dd className="mt-1">{providerLabel(visibleSelectedSecret.provider)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Managed mode</dt>
                <dd className="mt-1">{modeLabel(visibleSelectedSecret.managedMode)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Version</dt>
                <dd className="mt-1">v{visibleSelectedSecret.latestVersion}</dd>
              </div>
              <div className="sm:col-span-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                <dt className="text-xs font-medium text-muted-foreground">Version history</dt>
                <dd className="mt-1 text-xs leading-5 text-muted-foreground">
                  Current version is v{visibleSelectedSecret.latestVersion}. Previous versions are retained for audit and
                  recovery context.
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Last read</dt>
                <dd className="mt-1">{formatSecretDate(visibleSelectedSecret.lastResolvedAt)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Last rotated</dt>
                <dd className="mt-1">{formatSecretDate(visibleSelectedSecret.lastRotatedAt)}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Status</dt>
                <dd className="mt-1">{statusLabel(visibleSelectedSecret.status)}</dd>
              </div>
              {visibleSelectedSecret.description && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">Description</dt>
                  <dd className="mt-1 text-muted-foreground">{visibleSelectedSecret.description}</dd>
                </div>
              )}
              {visibleSelectedSecret.externalRef && (
                <div className="min-w-0 sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">External reference</dt>
                  <dd className="mt-1 truncate font-mono text-xs">{visibleSelectedSecret.externalRef}</dd>
                </div>
              )}
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Copy reference</dt>
                <dd className="mt-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs">
                  {selectedReference}
                </dd>
              </div>
            </dl>
          </div>
        </aside>
      )}
    </div>
  );
}
