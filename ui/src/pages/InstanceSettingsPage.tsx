import { useEffect, useRef, useState, type RefObject } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import type { PatchInstanceGeneralSettings } from "@armyofagents/shared";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import {
  useSettingsSidebar,
  type SettingsSidebarKey,
} from "@/components/settings/useSettingsSidebar";
import { PrivacyTab } from "@/components/settings/PrivacyTab";
import { BackupsTab } from "@/components/settings/BackupsTab";
import { HeartbeatsTab } from "@/components/settings/HeartbeatsTab";
import { InstanceHealthTab } from "@/components/settings/InstanceHealthTab";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { feedbackApi } from "@/api/feedback";
import { authApi } from "@/api/auth";
import { ApiError } from "@/api/client";
import { useCompany } from "@/context/CompanyContext";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { LobbyShellMobileMenuButton } from "@/components/LobbyShell";
import { SettingsUnavailableState } from "@/components/settings/SettingsUnavailableState";
import type { SecondarySidebarItem } from "@/components/SecondarySidebar";

function isForbiddenError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

// The app-level QueryClient keeps react-query's default retry (3 attempts with
// backoff), which would sit on "Loading..." for ~7s firing doomed 403s before
// the friendly access state can render. 4xx responses are deterministic —
// surface them immediately; keep the retry budget for transient 5xx/network.
function retryUnlessClientError(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 3;
}

function SettingsMobileNav({
  pillItems,
  activePillRef,
}: {
  pillItems: SecondarySidebarItem[];
  activePillRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="md:hidden mb-5 relative">
      <div className="overflow-x-auto -mx-4 px-4 pb-1 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        <div className="flex gap-1.5 w-max">
          {pillItems.map((item) => (
            <button
              key={item.id}
              ref={item.active ? activePillRef : undefined}
              type="button"
              data-active={item.active ? "true" : undefined}
              onClick={item.onClick}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-[12.5px] font-medium transition-colors border whitespace-nowrap shrink-0",
                item.active
                  ? "bg-brand/[0.08] text-[hsl(15_60%_75%)] border-brand/[0.25]"
                  : "bg-card border-border text-foreground/[0.78] hover:bg-card-2 hover:text-foreground",
              )}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute right-0 top-0 bottom-1 w-8 bg-gradient-to-l from-bg to-transparent"
      />
    </div>
  );
}

export function InstanceSettingsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { selectedCompany } = useCompany();
  const [searchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") ?? "general";
  const [actionError, setActionError] = useState<string | null>(null);

  // Shared settings sidebar (also used by InstanceAccessPage) — pushes the
  // "Settings" secondary sidebar to the persistent LobbyLayout shell.
  const { pillItems, deploymentState, deploymentMode, retryDeploymentStatus } = useSettingsSidebar(
    activeTab as SettingsSidebarKey,
  );

  const activePillRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // scrollIntoView is not available in JSDOM (test env) — optional-chain guards against that.
    activePillRef.current?.scrollIntoView?.({
      behavior: "smooth",
      inline: "center",
      block: "nearest",
    });
  }, [activeTab]);

  // ── General settings ──────────────────────────────────────────────────────

  const generalQuery = useQuery({
    queryKey: queryKeys.instanceSettings.general,
    queryFn: () => instanceSettingsApi.getGeneral(),
    retry: retryUnlessClientError,
  });

  const isLocalTrusted = deploymentMode === "local_trusted";

  const generalMutation = useMutation({
    mutationFn: async (patch: PatchInstanceGeneralSettings) =>
      instanceSettingsApi.updateGeneral(patch),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.instanceSettings.general,
      });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update general settings.");
    },
  });

  // ── Experimental settings ─────────────────────────────────────────────────

  const experimentalQuery = useQuery({
    queryKey: queryKeys.instanceSettings.experimental,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: retryUnlessClientError,
  });

  const experimentalMutation = useMutation({
    mutationFn: async (patch: {
      enableIsolatedWorkspaces?: boolean;
      autoRestartDevServerWhenIdle?: boolean;
      enableWorkspaceTtlSweeper?: boolean;
    }) => instanceSettingsApi.updateExperimental(patch),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.instanceSettings.experimental,
      });
    },
    onError: (error) => {
      setActionError(
        error instanceof Error ? error.message : "Failed to update experimental settings.",
      );
    },
  });

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to sign out.");
    },
  });

  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;
  const keyboardShortcuts = generalQuery.data?.keyboardShortcuts === true;
  const enableIsolatedWorkspaces = experimentalQuery.data?.enableIsolatedWorkspaces === true;
  const autoRestartDevServerWhenIdle =
    experimentalQuery.data?.autoRestartDevServerWhenIdle === true;
  const enableWorkspaceTtlSweeper = experimentalQuery.data?.enableWorkspaceTtlSweeper === true;

  if (activeTab === "heartbeats" && deploymentState !== "available") {
    return (
      <div className="mx-auto w-full max-w-[1080px] px-4 py-6 sm:px-6 sm:py-7 md:px-10 md:py-9">
        <LobbyShellMobileMenuButton className="mb-4" />
        <div className="mb-5">
          <h1 className="text-[1.55rem] font-bold tracking-tight">
            Instance settings<span className="text-brand">.</span>
          </h1>
        </div>
        <SettingsMobileNav pillItems={pillItems} activePillRef={activePillRef} />
        <SettingsUnavailableState
          sectionName="Heartbeats"
          deploymentState={deploymentState}
          onRetry={retryDeploymentStatus}
        />
      </div>
    );
  }

  // N2: a non-instance-admin who reaches this page (deep link, stale tab) gets
  // a purposeful state instead of "Failed to load general settings." — every
  // instance-settings query 403s for them, so a 403 on either query means the
  // whole page is off-limits. Non-403 failures keep the per-tab error copy.
  const accessDenied =
    isForbiddenError(generalQuery.error) || isForbiddenError(experimentalQuery.error);
  if (accessDenied) {
    const companySettingsPath = selectedCompany ? `/${selectedCompany.issuePrefix}/settings` : "/";
    return (
      <div className="mx-auto w-full max-w-[1080px] px-4 py-6 sm:px-6 sm:py-7 md:px-10 md:py-9">
        <LobbyShellMobileMenuButton className="mb-4" />
        <div className="mb-5">
          <h1 className="text-[1.55rem] font-bold tracking-tight">
            Instance settings<span className="text-brand">.</span>
          </h1>
        </div>
        <section className="max-w-xl rounded-xl border border-border bg-card p-6">
          <h2 className="text-base font-semibold">
            Instance settings require instance-admin access
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Looking for your organization's settings? Open your company and go to Settings there.
          </p>
          <Button className="mt-4" onClick={() => navigate(companySettingsPath)}>
            {selectedCompany ? "Open company settings" : "Back to Lobby"}
          </Button>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1080px] px-4 py-6 sm:px-6 sm:py-7 md:px-10 md:py-9">
      <LobbyShellMobileMenuButton className="mb-4" />

      {/* Page heading — no back button (sidebar handles navigation) */}
      <div className="mb-5">
        <h1 className="text-[1.55rem] font-bold tracking-tight">
          Instance settings<span className="text-brand">.</span>
        </h1>
      </div>

      {/* Mobile-only horizontal section nav (desktop uses the LobbyShell secondarySidebar slot) */}
      <SettingsMobileNav pillItems={pillItems} activePillRef={activePillRef} />

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <Tabs value={activeTab} className="mt-5">
        {/* ── General tab ──────────────────────────────────────────── */}
        <TabsContent value="general" className="mt-6 space-y-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">General</h2>
            <p className="text-sm text-muted-foreground">
              Instance-wide defaults that affect how operator-visible logs are displayed and how
              teammates interact with the app.
            </p>
          </div>

          {generalQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading...</div>
          ) : generalQuery.error ? (
            <div className="text-sm text-destructive">Failed to load general settings.</div>
          ) : (
            <>
              <ToggleCard
                title="Censor username in logs"
                description="Hide the username segment in home-directory paths and similar operator-visible log output. Standalone username mentions outside of paths are not yet masked in the live transcript view."
                checked={censorUsernameInLogs}
                disabled={generalMutation.isPending}
                onToggle={() =>
                  generalMutation.mutate({
                    censorUsernameInLogs: !censorUsernameInLogs,
                  })
                }
              />
              <ToggleCard
                title="Keyboard shortcuts"
                description="Enable app-wide keyboard shortcuts, including inbox navigation and global shortcuts like creating a task or toggling panels. Off by default. Individual key bindings are read-only for now."
                checked={keyboardShortcuts}
                disabled={generalMutation.isPending}
                onToggle={() =>
                  generalMutation.mutate({
                    keyboardShortcuts: !keyboardShortcuts,
                  })
                }
              />
            </>
          )}

          {!isLocalTrusted && (
            <section className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1.5">
                  <h2 className="text-sm font-semibold">Sign out</h2>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    Sign out of this AoA instance. You will be redirected to the login page.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={signOutMutation.isPending}
                  onClick={() => signOutMutation.mutate()}
                >
                  <LogOut className="size-4" />
                  {signOutMutation.isPending ? "Signing out..." : "Sign out"}
                </Button>
              </div>
            </section>
          )}
        </TabsContent>

        {/* ── Privacy tab ──────────────────────────────────────────── */}
        <TabsContent value="health" className="mt-6">
          <InstanceHealthTab />
        </TabsContent>

        <TabsContent value="privacy" className="mt-6">
          <PrivacyPanel
            generalQuery={generalQuery}
            onChange={(patch) => generalMutation.mutate(patch)}
            isSaving={generalMutation.isPending}
            isPrivacyActive={activeTab === "privacy"}
            deploymentMode={deploymentMode}
          />
        </TabsContent>

        {/* ── Backups tab ──────────────────────────────────────────── */}
        <TabsContent value="backups" className="mt-6">
          <BackupsTab
            settings={generalQuery.data}
            isLoading={generalQuery.isLoading}
            error={generalQuery.error}
            isSaving={generalMutation.isPending}
            onChange={(patch) => generalMutation.mutate(patch)}
          />
        </TabsContent>

        {/* ── Heartbeats tab ───────────────────────────────────────── */}
        <TabsContent value="heartbeats" className="mt-6">
          <HeartbeatsTab />
        </TabsContent>

        {/* ── Experimental tab ─────────────────────────────────────── */}
        <TabsContent value="experimental" className="mt-6 space-y-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">Experimental</h2>
            <p className="text-sm text-muted-foreground">
              Opt into features that are still being evaluated before they become default behavior.
            </p>
          </div>

          {experimentalQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading...</div>
          ) : experimentalQuery.error ? (
            <div className="text-sm text-destructive">Failed to load experimental settings.</div>
          ) : (
            <>
              <ToggleCard
                title="Enable Isolated Workspaces"
                description="Show execution workspace controls in project configuration and allow isolated workspace behavior for new and existing issue runs."
                checked={enableIsolatedWorkspaces}
                disabled={experimentalMutation.isPending}
                onToggle={() =>
                  experimentalMutation.mutate({
                    enableIsolatedWorkspaces: !enableIsolatedWorkspaces,
                  })
                }
              />
              <ToggleCard
                title="Auto-Restart Dev Server When Idle"
                description="In pnpm dev:once, wait for all queued and running local agent runs to finish, then restart the server automatically when backend changes or migrations make the current boot stale."
                checked={autoRestartDevServerWhenIdle}
                disabled={experimentalMutation.isPending}
                onToggle={() =>
                  experimentalMutation.mutate({
                    autoRestartDevServerWhenIdle: !autoRestartDevServerWhenIdle,
                  })
                }
              />
              <ToggleCard
                title="Workspace TTL Sweeper"
                description="Periodically mark inactive execution workspaces as cleanup-eligible once their project's TTL (days) expires. Does not archive automatically — it only stamps cleanupEligibleAt; the founder still confirms via the Archive dialog."
                checked={enableWorkspaceTtlSweeper}
                disabled={experimentalMutation.isPending}
                onToggle={() =>
                  experimentalMutation.mutate({
                    enableWorkspaceTtlSweeper: !enableWorkspaceTtlSweeper,
                  })
                }
              />
            </>
          )}
        </TabsContent>

        {/* ── Plugins tab ─────────────────────────────────────────── */}
        {/* Plugins tab — diagnostics only (M.4: management moved to Company Settings) */}
        <TabsContent value="plugins" className="mt-6">
          <div className="space-y-4">
            <div className="bg-indigo-950/30 border border-indigo-900/40 rounded-lg px-4 py-3 text-xs text-indigo-300">
              Plugin installation and configuration is available in each company's{" "}
              <strong>Settings → Plugins</strong> tab. Worker diagnostics are now in{" "}
              <strong>Instance settings → Health</strong>.
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Plugin diagnostics panel ──────────────────────────────────────────────────

// ── Privacy panel (wraps PrivacyTab + bundle-history fetch) ─────────────────

const BUNDLE_HISTORY_LIMIT = 3;

function PrivacyPanel({
  generalQuery,
  onChange,
  isSaving,
  isPrivacyActive,
  deploymentMode,
}: {
  generalQuery: ReturnType<
    typeof useQuery<Awaited<ReturnType<typeof instanceSettingsApi.getGeneral>>>
  >;
  onChange: (patch: PatchInstanceGeneralSettings) => void;
  isSaving: boolean;
  isPrivacyActive: boolean;
  deploymentMode: string | undefined;
}) {
  // Fetch bundle history only when the Privacy tab is actually being viewed —
  // avoids a request when the user lands on General and never visits Privacy.
  const exportsQuery = useQuery({
    queryKey: queryKeys.feedback.exports(BUNDLE_HISTORY_LIMIT),
    queryFn: () => feedbackApi.listExports(BUNDLE_HISTORY_LIMIT),
    enabled: isPrivacyActive && deploymentMode !== "cloud_auth",
  });

  return (
    <PrivacyTab
      settings={generalQuery.data}
      isLoading={generalQuery.isLoading}
      error={generalQuery.error}
      isSaving={isSaving}
      onChange={onChange}
      bundleHistory={exportsQuery.data}
      bundleHistoryLoading={exportsQuery.isLoading}
      bundleHistoryError={exportsQuery.error}
      showBundleHistory={deploymentMode !== "cloud_auth"}
    />
  );
}

// ── Reusable toggle card ──────────────────────────────────────────────────────

function ToggleCard({
  title,
  description,
  checked,
  disabled,
  onToggle,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
        </div>
        <button
          type="button"
          data-slot="toggle"
          aria-label={`Toggle ${title}`}
          disabled={disabled}
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
            checked ? "bg-green-600" : "bg-muted",
          )}
          onClick={onToggle}
        >
          <span
            className={cn(
              "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
              checked ? "translate-x-4.5" : "translate-x-0.5",
            )}
          />
        </button>
      </div>
    </section>
  );
}
