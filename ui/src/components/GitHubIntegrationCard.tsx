import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Github,
  KeyRound,
  Loader2,
} from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { githubIntegrationApi } from "../api/github-integration";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingsCard } from "@/components/settings/SettingsCard";

const PAT_DOCS_URL = "https://github.com/settings/tokens?type=beta";

/**
 * Settings → Integrations → GitHub card.
 *
 * Supports two auth modes that coexist:
 *   1. GitHub App — org-wide, tokens auto-rotate (recommended)
 *   2. Personal Access Token — fine-grained PAT fallback
 *
 * The PAT itself is never returned to the UI — the status endpoint only
 * echoes `{configured, githubUser, createdAt}`.
 */
export function GitHubIntegrationCard() {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [patInput, setPatInput] = useState("");
  const [inlineError, setInlineError] = useState<string | null>(null);

  // ── Queries ──────────────────────────────────────────────────────────────

  const statusQuery = useQuery({
    queryKey: queryKeys.github.patStatus(selectedCompanyId!),
    queryFn: () => githubIntegrationApi.status(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const appStatusQuery = useQuery({
    queryKey: ["github", "app-status", selectedCompanyId],
    queryFn: () => githubIntegrationApi.appStatus(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const installUrlQuery = useQuery({
    queryKey: ["github", "app-install-url", selectedCompanyId],
    queryFn: () => githubIntegrationApi.getAppInstallUrl(selectedCompanyId!),
    enabled: !!selectedCompanyId && appStatusQuery.data?.installed === false,
    staleTime: 5 * 60 * 1000,
  });

  const authorizedReposQuery = useQuery({
    queryKey: ["github", "authorized-repos", selectedCompanyId],
    queryFn: () => githubIntegrationApi.getAuthorizedRepos(selectedCompanyId!),
    enabled: !!selectedCompanyId && appStatusQuery.data?.installed === true,
    staleTime: 5 * 60 * 1000,
  });

  // ── Mutations ─────────────────────────────────────────────────────────────

  const invalidateAll = () => {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({
      queryKey: queryKeys.github.patStatus(selectedCompanyId),
    });
    queryClient.invalidateQueries({
      queryKey: ["github", "app-status", selectedCompanyId],
    });
  };

  const setPatMutation = useMutation({
    mutationFn: (pat: string) =>
      githubIntegrationApi.setPat(selectedCompanyId!, pat),
    onSuccess: (data) => {
      setPatInput("");
      setInlineError(null);
      invalidateAll();
      pushToast({
        title: `PAT connected as @${data.githubUser}`,
        tone: "success",
      });
    },
    onError: (err) => {
      const message =
        err instanceof Error ? err.message : "Failed to save GitHub PAT";
      setInlineError(message);
    },
  });

  const removePatMutation = useMutation({
    mutationFn: () => githubIntegrationApi.removePat(selectedCompanyId!),
    onSuccess: () => {
      setInlineError(null);
      invalidateAll();
      pushToast({ title: "PAT disconnected", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: err instanceof Error ? err.message : "Failed to disconnect",
        tone: "warn",
      });
    },
  });

  const disconnectAppMutation = useMutation({
    mutationFn: () => githubIntegrationApi.disconnectApp(selectedCompanyId!),
    onSuccess: () => {
      invalidateAll();
      pushToast({ title: "GitHub App disconnected", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: err instanceof Error ? err.message : "Failed to disconnect app",
        tone: "warn",
      });
    },
  });

  if (!selectedCompanyId) {
    return null;
  }

  const appInstalled = appStatusQuery.data?.installed === true;
  const patConnected = statusQuery.data?.configured === true;
  const isLoading = statusQuery.isLoading || appStatusQuery.isLoading;

  function handleConnectWithGitHub() {
    const url = installUrlQuery.data?.url;
    if (url) window.location.href = url;
  }

  function handleConnectPat() {
    const trimmed = patInput.trim();
    if (!trimmed) return;
    setInlineError(null);
    setPatMutation.mutate(trimmed);
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Connection status strip ────────────────────────────────────── */}
      <GitHubStatusStrip
        appInstalled={appInstalled}
        patConnected={patConnected}
        appLogin={appStatusQuery.data?.accountLogin ?? null}
        patUser={statusQuery.data?.githubUser ?? null}
      />

      {/* ── GitHub App card ────────────────────────────────────────────── */}
      <SettingsCard
        icon={Github}
        title="GitHub App"
        description="Org-wide access. Tokens auto-rotate. No manual PAT needed."
        headerAside={
          <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">
            Recommended
          </span>
        }
        bodyClassName="space-y-2"
      >
        {appInstalled ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm">
              <CheckCircle2
                className="h-4 w-4 text-emerald-500 shrink-0"
                aria-hidden="true"
              />
              <div className="flex-1 min-w-0">
                <span className="font-medium">
                  Connected to{" "}
                  <span className="font-mono">
                    @{appStatusQuery.data?.accountLogin}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground ml-1">
                  ({appStatusQuery.data?.accountType})
                </span>
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => disconnectAppMutation.mutate()}
                disabled={disconnectAppMutation.isPending}
                aria-label="Disconnect App"
              >
                {disconnectAppMutation.isPending
                  ? "Disconnecting…"
                  : "Disconnect App"}
              </Button>
            </div>
            {authorizedReposQuery.data && authorizedReposQuery.data.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <div className="text-xs font-medium text-muted-foreground">
                  Authorized repositories ({authorizedReposQuery.data.length})
                </div>
                <div className="space-y-1 max-h-36 overflow-y-auto rounded-md border border-border/50 px-2 py-1.5">
                  {authorizedReposQuery.data.map((repo) => (
                    <div key={repo.fullName} className="flex items-center gap-2 text-xs">
                      <span className="font-mono truncate flex-1 min-w-0">{repo.fullName}</span>
                      {repo.private && (
                        <span className="shrink-0 rounded px-1 py-0.5 text-[10px] bg-muted text-muted-foreground border border-border/60">
                          private
                        </span>
                      )}
                      <a
                        href={repo.url}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        aria-label={`Open ${repo.fullName} on GitHub`}
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {authorizedReposQuery.isLoading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground pt-1">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                Loading repositories…
              </div>
            )}
          </div>
        ) : (
          <Button
            size="sm"
            variant="default"
            className="gap-1.5"
            onClick={handleConnectWithGitHub}
            disabled={installUrlQuery.isLoading || installUrlQuery.isError}
          >
            {installUrlQuery.isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Github className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Connect with GitHub
          </Button>
        )}
      </SettingsCard>

      {/* Divider */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <div className="flex-1 h-px bg-border" />
        or
        <div className="flex-1 h-px bg-border" />
      </div>

      {/* ── Personal access token card ─────────────────────────────────── */}
      <SettingsCard
        icon={KeyRound}
        title="Personal access token"
        description="Fine-grained PAT fallback for repo + pull-request access."
        headerAside={
          appInstalled ? (
            <span className="text-[11px] text-muted-foreground/60">
              fallback — App is active
            </span>
          ) : null
        }
        bodyClassName="space-y-2"
      >
        {patConnected ? (
          <div className="space-y-2">
            <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm">
              <CheckCircle2
                className="mt-0.5 h-4 w-4 text-emerald-500"
                aria-hidden="true"
              />
              <div className="flex-1 min-w-0">
                <div className="font-medium">
                  Connected as{" "}
                  <span className="font-mono">
                    @{statusQuery.data?.githubUser ?? "unknown"}
                  </span>
                </div>
                {statusQuery.data?.createdAt && (
                  <div className="text-xs text-muted-foreground">
                    Saved {new Date(statusQuery.data.createdAt).toLocaleString()}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => removePatMutation.mutate()}
                disabled={removePatMutation.isPending}
              >
                {removePatMutation.isPending ? "Disconnecting…" : "Disconnect"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              Fine-grained PAT with <span className="font-mono">repo</span> and{" "}
              <span className="font-mono">pull_requests</span> permissions.
            </div>
            <div className="flex items-center gap-2">
              <input
                type="password"
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                value={patInput}
                onChange={(e) => {
                  setPatInput(e.target.value);
                  if (inlineError) setInlineError(null);
                }}
                placeholder="github_pat_…"
                aria-label="GitHub Personal Access Token"
                disabled={setPatMutation.isPending}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && patInput.trim()) {
                    e.preventDefault();
                    handleConnectPat();
                  }
                }}
              />
              <Button
                size="sm"
                onClick={handleConnectPat}
                disabled={!patInput.trim() || setPatMutation.isPending}
              >
                {setPatMutation.isPending ? "Connecting…" : "Connect"}
              </Button>
            </div>
            {inlineError && (
              <div className="flex items-start gap-2 text-sm text-destructive">
                <AlertCircle
                  className="mt-0.5 h-4 w-4"
                  aria-hidden="true"
                />
                <span>{inlineError}</span>
              </div>
            )}
            <a
              href={PAT_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Create a GitHub PAT
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          </div>
        )}
      </SettingsCard>
    </div>
  );
}

/** One-line connection summary above the App / PAT cards. Derived, not fetched. */
function GitHubStatusStrip({
  appInstalled,
  patConnected,
  appLogin,
  patUser,
}: {
  appInstalled: boolean;
  patConnected: boolean;
  appLogin: string | null;
  patUser: string | null;
}) {
  const connected = appInstalled || patConnected;
  const summary = appInstalled
    ? `Connected via GitHub App${appLogin ? ` — @${appLogin}` : ""}`
    : patConnected
      ? `Connected via personal access token${patUser ? ` — @${patUser}` : ""}`
      : "Not connected";
  return (
    <div
      data-testid="github-status-strip"
      className="flex items-center gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
    >
      <span
        data-testid="github-status-dot"
        className={cn(
          "size-2 shrink-0 rounded-full",
          connected ? "bg-emerald-500" : "bg-muted-foreground/50",
        )}
        aria-hidden="true"
      />
      <span className={connected ? "font-medium" : "text-muted-foreground"}>
        {summary}
      </span>
    </div>
  );
}
