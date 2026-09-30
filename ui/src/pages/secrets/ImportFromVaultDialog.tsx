import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CompanySecretProviderConfig,
  RemoteSecretImportCandidate,
  RemoteSecretImportResult,
} from "@armyofagents/shared";
import { ArrowRight, Check, CloudDownload, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/StatusBadge";
import { secretsApi } from "@/api/secrets";
import { queryKeys } from "@/lib/queryKeys";
import { useToast } from "@/context/ToastContext";

export interface ImportFromVaultDialogProps {
  companyId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  providerConfigs: CompanySecretProviderConfig[];
  onImportCommitted?(): void;
}

function candidateKey(candidate: RemoteSecretImportCandidate) {
  return candidate.externalRef;
}

function statusVariant(status: RemoteSecretImportCandidate["status"]) {
  if (status === "ready") return "active";
  if (status === "conflict") return "pending";
  return "archived";
}

function canImportCandidate(candidate: RemoteSecretImportCandidate) {
  return candidate.status === "ready" || candidate.status === "conflict";
}

export function ImportFromVaultDialog({
  companyId,
  open,
  onOpenChange,
  providerConfigs,
  onImportCommitted,
}: ImportFromVaultDialogProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const importableConfigs = providerConfigs.filter(
    (config) => config.provider === "aws_secrets_manager" && config.status !== "disabled",
  );
  const [providerConfigId, setProviderConfigId] = useState(importableConfigs[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<RemoteSecretImportCandidate[]>([]);
  const [selectedRefs, setSelectedRefs] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<RemoteSecretImportResult | null>(null);
  const previewRequestIdRef = useRef(0);

  useEffect(() => {
    if (!providerConfigId && importableConfigs[0]) {
      setProviderConfigId(importableConfigs[0].id);
    }
  }, [importableConfigs, providerConfigId]);

  const selectedCandidates = useMemo(
    () => candidates.filter((candidate) => selectedRefs.has(candidateKey(candidate))),
    [candidates, selectedRefs],
  );

  const previewMutation = useMutation({
    mutationFn: ({
      providerConfigId,
      query,
      token,
    }: {
      requestId: number;
      providerConfigId: string;
      query: string | null;
      token: string | null;
    }) =>
      secretsApi.remoteImport.preview(companyId, {
        providerConfigId,
        query,
        nextToken: token,
        pageSize: 25,
      }),
    onSuccess: (preview, variables) => {
      if (variables.requestId !== previewRequestIdRef.current) return;
      setCandidates((current) => (variables.token ? [...current, ...preview.candidates] : preview.candidates));
      setNextToken(preview.nextToken);
      setResult(null);
      setSelectedRefs((current) => {
        const valid = new Set(preview.candidates.map(candidateKey));
        if (variables.token) {
          return current;
        }
        return new Set([...current].filter((ref) => valid.has(ref)));
      });
    },
    onError: (err, variables) => {
      if (variables.requestId !== previewRequestIdRef.current) return;
      pushToast({ title: "Preview failed", body: err instanceof Error ? err.message : "Could not list remote secrets.", tone: "error" });
    },
  });

  const importMutation = useMutation({
    mutationFn: () =>
      secretsApi.remoteImport.commit(companyId, {
        providerConfigId,
        secrets: selectedCandidates.map((candidate) => ({
          externalRef: candidate.externalRef,
          name: candidate.name,
          key: candidate.key,
          providerVersionRef: candidate.providerVersionRef,
          description: candidate.description,
        })),
      }),
    onSuccess: (importResult) => {
      setResult(importResult);
      setSelectedRefs(new Set());
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
      onImportCommitted?.();
      pushToast({ title: "Secrets imported", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Import failed", body: err instanceof Error ? err.message : "Could not import selected secrets.", tone: "error" });
    },
  });

  const resetPreviewState = () => {
    previewRequestIdRef.current += 1;
    setNextToken(null);
    setCandidates([]);
    setSelectedRefs(new Set());
    setResult(null);
    previewMutation.reset();
    importMutation.reset();
  };

  const runPreview = (token: string | null) => {
    const requestId = previewRequestIdRef.current + 1;
    previewRequestIdRef.current = requestId;
    previewMutation.mutate({
      requestId,
      providerConfigId,
      query: query.trim() || null,
      token,
    });
  };

  const toggleCandidate = (candidate: RemoteSecretImportCandidate, checked: boolean) => {
    const key = candidateKey(candidate);
    setSelectedRefs((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const resetAndClose = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setResult(null);
      setSelectedRefs(new Set());
    }
  };

  const resultCounts = useMemo(() => {
    if (!result) return null;
    return result.results.reduce(
      (counts, row) => {
        counts[row.status] += 1;
        return counts;
      },
      { imported: 0, skipped: 0, error: 0 },
    );
  }, [result]);

  return (
    <Dialog open={open} onOpenChange={resetAndClose}>
      <DialogContent className="max-w-3xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CloudDownload className="size-4" />
            Import from vault
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="rounded-md border border-border bg-accent/20 px-3 py-2 text-sm text-muted-foreground">
            Imports create external references by default. AoA stores the remote reference, not the secret value.
          </p>
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <Select
              value={providerConfigId}
              onValueChange={(value) => {
                setProviderConfigId(value);
                resetPreviewState();
              }}
            >
              <SelectTrigger aria-label="Provider vault">
                <SelectValue placeholder="Provider vault" />
              </SelectTrigger>
              <SelectContent>
                {importableConfigs.map((config) => (
                  <SelectItem key={config.id} value={config.id}>
                    {config.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                resetPreviewState();
              }}
              placeholder="Filter remote names"
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => runPreview(null)}
              disabled={!providerConfigId || previewMutation.isPending}
            >
              <RefreshCw className="size-4" />
              Preview remote secrets
            </Button>
          </div>

          <div className="max-h-[360px] overflow-auto rounded-md border border-border">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-accent/20 text-xs text-muted-foreground">
                <tr>
                  <th className="w-10 px-3 py-2" />
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">External reference</th>
                  <th className="px-3 py-2 font-medium">Version</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {candidates.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground">
                      {previewMutation.isPending ? "Loading..." : "No preview loaded"}
                    </td>
                  </tr>
                ) : (
                  candidates.map((candidate) => {
                    const disabled = !canImportCandidate(candidate);
                    const key = candidateKey(candidate);
                    return (
                      <tr key={key} className="border-t border-border">
                        <td className="px-3 py-2">
                          <Checkbox
                            checked={selectedRefs.has(key)}
                            disabled={disabled}
                            onCheckedChange={(checked) => toggleCandidate(candidate, checked === true)}
                            aria-label={`Select ${candidate.name}`}
                          />
                        </td>
                        <td className="max-w-[180px] px-3 py-2">
                          <div className="truncate font-medium">{candidate.name}</div>
                          {candidate.key && (
                            <div className="truncate text-xs text-muted-foreground">{candidate.key}</div>
                          )}
                        </td>
                        <td className="max-w-[240px] px-3 py-2 font-mono text-xs text-muted-foreground">
                          <span className="block truncate">{candidate.externalRef}</span>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {candidate.providerVersionRef ?? "latest"}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-col gap-1">
                            <Badge variant={statusVariant(candidate.status)}>{candidate.status}</Badge>
                            {candidate.reason && (
                              <span className="max-w-[160px] text-xs text-muted-foreground">
                                {candidate.reason}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {nextToken && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => runPreview(nextToken)}
              disabled={previewMutation.isPending}
            >
              <ArrowRight className="size-3.5" />
              More
            </Button>
          )}

          {result && (
            <div className="rounded-md border border-border">
              {resultCounts && (
                <div className="flex flex-wrap gap-2 border-b border-border bg-accent/20 px-3 py-2 text-xs text-muted-foreground">
                  <span>{resultCounts.imported} imported</span>
                  <span>{resultCounts.skipped} skipped</span>
                  <span>{resultCounts.error} error</span>
                </div>
              )}
              {result.results.map((row) => (
                <div
                  key={row.externalRef}
                  className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0"
                >
                  <Check className="size-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{row.name ?? row.externalRef}</span>
                  <StatusBadge status={row.status === "error" ? "failed" : row.status} />
                </div>
              ))}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => resetAndClose(false)}>
            {result ? "Done" : "Cancel"}
          </Button>
          <Button
            type="button"
            onClick={() => importMutation.mutate()}
            disabled={selectedCandidates.length === 0 || importMutation.isPending}
          >
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
