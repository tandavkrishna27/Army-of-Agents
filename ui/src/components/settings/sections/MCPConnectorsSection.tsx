import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, PlugZap } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useTeamAccess } from "@/hooks/useTeamAccess";
import { healthApi } from "@/api/health";
import { agentsApi } from "@/api/agents";
import {
  mcpConnectorsApi,
  type ConnectorDeliverabilityReason,
  type McpConnector,
} from "@/api/mcpConnectors";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/EmptyState";
import { Link } from "@/lib/router";
import { NewConnectorDialog } from "../NewConnectorDialog";

const inputCls =
  "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-brand/50";

function TransportBadge({
  transport,
}: {
  transport: McpConnector["transport"];
}) {
  return (
    <Badge variant={transport === "http" ? "draft" : "idle"}>
      {transport === "http" ? "HTTP" : "stdio"}
    </Badge>
  );
}

/**
 * Every status must produce a visible badge — including one this build has never
 * heard of.
 *
 * This function used to end at `disabled`, with `needs_credentials` falling
 * through to the "Disabled" branch by accident of ordering (and, before the
 * union was widened, an unknown status rendering nothing at all). P3a-11 made
 * `needs_credentials` a production state — every catalog install with
 * `requiresSecret` lands there — so the miss was directly on the central
 * journey: install Notion, get a row with the wrong state and no next step.
 *
 * The fallback renders the RAW status rather than nothing, because a server that
 * grows a fifth status should degrade to an ugly badge, not an invisible one.
 */
export function StatusBadge({ status }: { status: McpConnector["status"] }) {
  if (status === "active") return <Badge variant="active">Active</Badge>;
  if (status === "pending_approval")
    return <Badge variant="pending">Pending approval</Badge>;
  if (status === "needs_credentials")
    return <Badge variant="draft">Needs setup</Badge>;
  if (status === "disabled") return <Badge variant="archived">Disabled</Badge>;
  return <Badge variant="idle">{status}</Badge>;
}

/**
 * Founder-facing copy for each delivery-skip reason (FU-1). Keyed by the
 * server's `ConnectorDeliverabilityReason` so the "why isn't this connector
 * working?" answer the founder reads is the one the delivery pipeline actually
 * computed — no client-side re-derivation that could drift.
 */
const DELIVERABILITY_REASON_COPY: Record<
  ConnectorDeliverabilityReason,
  string
> = {
  d7_blocked:
    "Local (stdio) connectors run a command on the host and aren't allowed in this deployment, so this connector reaches no agents.",
  unsafe_command:
    "This local connector's command isn't an allowed, version-pinned launcher (npx/uvx), so it's blocked from running and reaches no agents. Re-create it with a pinned package (e.g. name@1.2.3).",
  missing_url: "This HTTP connector has no URL, so it can't be reached.",
  missing_command: "This local connector has no command, so it can't start.",
  unknown_transport:
    "This connector's transport isn't recognized, so it can't be delivered.",
  malformed_row:
    "This connector's configuration is malformed, so it can't be delivered.",
  secret_unreachable:
    "the Codex CLI can't pass a local (stdio) connector's secret to the server, so it would authenticate as no-one",
  adapter_incapable: "this agent's runtime can't host MCP connectors",
  credential_inactive_or_missing:
    "This connector's secret is missing or disabled, so it can't authenticate and reaches no agents.",
};

/**
 * The delivery-health line for an ACTIVE connector (FU-1). Renders nothing when
 * the connector is healthy/deliverable or when deliverability is not applicable
 * (non-active — the StatusBadge speaks for it). Otherwise it is visually
 * distinct from the green "Active" badge: an amber warning that names the reason
 * and, for per-agent blocks, WHICH agent — so a connector never silently fails
 * to reach an agent. Shares the "why isn't this connector working?" surface with
 * the `needs_credentials` "Needs setup" affordance.
 */
function DeliverabilityWarning({ connector }: { connector: McpConnector }) {
  const d = connector.deliverability;
  if (!d || d.deliverable) return null;

  return (
    <div
      data-testid={`connector-delivery-warning-${connector.id}`}
      className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 space-y-1"
    >
      <div className="flex items-center gap-2">
        <Badge variant="pending">Not reaching agents</Badge>
      </div>
      {d.reason ? (
        <div className="text-xs text-muted-foreground">
          {DELIVERABILITY_REASON_COPY[d.reason]}
        </div>
      ) : (
        <ul className="text-xs text-muted-foreground space-y-0.5">
          {d.blockedAgents.map((b) => (
            <li key={b.agentId}>
              Not delivered to{" "}
              <span className="font-medium text-foreground">{b.agentName}</span>
              : {DELIVERABILITY_REASON_COPY[b.reason]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MCPConnectorsSection() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? null;

  const { role } = useTeamAccess(companyId);
  const isFounder = role === "founder";

  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
  });
  // Default to the safe (restrictive) assumption while health loads: treat as a
  // shared deployment so we never briefly offer stdio in an authenticated host.
  const isLocalTrusted = health?.deploymentMode === "local_trusted";

  const {
    data: connectors,
    isLoading: connectorsLoading,
    isError: connectorsError,
    refetch: refetchConnectors,
  } = useQuery({
    queryKey: companyId
      ? queryKeys.mcpConnectors.list(companyId)
      : ["mcp-connectors", "none"],
    queryFn: () => mcpConnectorsApi.list(companyId!),
    enabled: !!companyId,
  });

  // OAuth capability is part of the server-returned connector projection. This
  // manage-only surface never re-fetches the mutable catalog or infers identity
  // from serverName.

  const { data: agents } = useQuery({
    queryKey: companyId ? queryKeys.agents.list(companyId) : ["agents", "none"],
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });

  const invalidateCompany = (scopeCompanyId: string) =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.mcpConnectors.list(scopeCompanyId),
    });
  const invalidate = () => companyId && invalidateCompany(companyId);

  // stdio is host-executing → only offered on a local_trusted host (D7).
  // Passed down to NewConnectorDialog, which needs it for the same guard.
  const stdioAllowed = isLocalTrusted;

  // Inline surface for disable/enable/remove failures (previously swallowed
  // silently for disable/remove; enable follows the same pattern).
  const [actionError, setActionError] = useState<string | null>(null);
  const [showAddConnector, setShowAddConnector] = useState(false);
  const companyIdRef = useRef(companyId);
  companyIdRef.current = companyId;

  useEffect(() => {
    setActionError(null);
  }, [companyId]);

  type ConnectorAction = { companyId: string; connectorId: string };

  const disableMutation = useMutation({
    mutationFn: ({ companyId: scopeCompanyId, connectorId }: ConnectorAction) =>
      mcpConnectorsApi.update(scopeCompanyId, connectorId, { status: "disabled" }),
    onSuccess: (_result, variables) => {
      if (companyIdRef.current === variables.companyId) setActionError(null);
      invalidateCompany(variables.companyId);
    },
    onError: (err, variables) => {
      if (companyIdRef.current === variables.companyId)
        setActionError(
          err instanceof ApiError ? err.message : "Failed to disable connector"
        );
    },
  });

  // Mirrors disableMutation — the re-activation counterpart. A disabled
  // connector previously had no way back to active from this UI at all.
  const enableMutation = useMutation({
    mutationFn: ({ companyId: scopeCompanyId, connectorId }: ConnectorAction) =>
      mcpConnectorsApi.update(scopeCompanyId, connectorId, { status: "active" }),
    onSuccess: (_result, variables) => {
      if (companyIdRef.current === variables.companyId) setActionError(null);
      invalidateCompany(variables.companyId);
    },
    onError: (err, variables) => {
      if (companyIdRef.current === variables.companyId)
        setActionError(
          err instanceof ApiError ? err.message : "Failed to enable connector"
        );
    },
  });

  const removeMutation = useMutation({
    mutationFn: ({ companyId: scopeCompanyId, connectorId }: ConnectorAction) =>
      mcpConnectorsApi.remove(scopeCompanyId, connectorId),
    onSuccess: (_result, variables) => {
      if (companyIdRef.current === variables.companyId) setActionError(null);
      invalidateCompany(variables.companyId);
    },
    onError: (err, variables) => {
      if (companyIdRef.current === variables.companyId)
        setActionError(
          err instanceof ApiError ? err.message : "Failed to remove connector"
        );
    },
  });

  return (
    <div>
      {/* Section header — OUTBOUND direction, distinct from the inbound MCP API keys section. */}
      <div className="px-8 pt-6 pb-3 border-b border-border">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
          Settings · Operations
        </div>
        <h2 className="text-[1.4rem] font-bold tracking-tight mt-1">
          Connectors<span className="text-brand">.</span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage the external tools and data sources your agents can use: bind
          credentials, choose which agents get access, disable or remove. Browse
          and install new ones in Marketplace → Connectors. These are outbound —
          your agents reach out to remote MCP servers. Inbound API keys live
          under MCP API keys.
        </p>
      </div>

      <div className="p-8">
        {!companyId ? (
          <EmptyState
            icon={Cable}
            message="Select a company to manage connectors."
          />
        ) : (
          <div className="space-y-6">
            {/* Registered connectors — this section is the MANAGE half of the
                journey. Browsing and installing moved to Marketplace →
                Connectors, so connectors are acquired exactly where skills,
                agents, plugins and teams are. */}
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Registered connectors
                </div>
                <div className="flex items-center gap-3">
                  {isFounder && (
                    <Button size="sm" onClick={() => setShowAddConnector(true)}>
                      Add connector
                    </Button>
                  )}
                  {isFounder && (
                    <Link
                      to="/marketplace/connectors"
                      className="text-xs font-medium text-brand hover:underline"
                    >
                      Browse connectors →
                    </Link>
                  )}
                </div>
              </div>

              {/* Access-model note: Commander gets every active connector for
                  free — no assignment needed. Crew/org agents need explicit
                  per-connector assignment via "Agents" below. This is the
                  answer to "I added a connector, why can't my agent see it?" */}
              <div className="rounded-md border border-border px-4 py-3 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Commander</span>{" "}
                can use every active connector automatically. To let a specific{" "}
                <span className="font-medium text-foreground">
                  crew or org agent
                </span>{" "}
                use one, assign it with{" "}
                <span className="font-medium text-foreground">Agents</span> on
                that connector.
              </div>

              <div className="rounded-md border border-border px-4 py-4 space-y-3">
                {actionError && (
                  <div role="alert" className="text-sm text-destructive">{actionError}</div>
                )}
                {connectorsLoading ? (
                  <div role="status" aria-live="polite" className="py-8 text-center text-sm text-muted-foreground">
                    Loading registered connectors&hellip;
                  </div>
                ) : connectorsError ? (
                  <div role="alert" className="py-8 text-center text-sm text-muted-foreground">
                    <div>Could not load registered connectors.</div>
                    <Button size="sm" variant="outline" className="mt-3" onClick={() => void refetchConnectors()}>
                      Retry
                    </Button>
                  </div>
                ) : (connectors ?? []).length === 0 ? (
                  // Not a dead end: the one thing a founder with zero connectors
                  // needs is the way to get one, and that way is now a different
                  // route. Naming it (and linking it) is the whole reason this
                  // empty state exists.
                  <div data-testid="connectors-empty-state">
                    <EmptyState
                      icon={PlugZap}
                      message="No connectors yet"
                      description="Connectors give your agents access to external tools and data sources — like a hosted MCP server for docs, tickets, or search. Install one from the Marketplace, then come back here to bind its credential and choose which agents may use it."
                    />
                    {isFounder && (
                      <div className="-mt-8 flex justify-center pb-4">
                        <Link to="/marketplace/connectors">
                          <Button size="sm">
                            Browse connectors in Marketplace
                          </Button>
                        </Link>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {(connectors ?? []).map((c) => (
                      <ConnectorRow
                        key={`${companyId}:${c.id}`}
                        connector={c}
                        agents={agents ?? []}
                        isFounder={isFounder}
                        onDisable={() => disableMutation.mutate({ companyId, connectorId: c.id })}
                        onEnable={() => enableMutation.mutate({ companyId, connectorId: c.id })}
                        onRemove={() => removeMutation.mutate({ companyId, connectorId: c.id })}
                        disableBusy={disableMutation.isPending && disableMutation.variables?.companyId === companyId && disableMutation.variables.connectorId === c.id}
                        enableBusy={enableMutation.isPending && enableMutation.variables?.companyId === companyId && enableMutation.variables.connectorId === c.id}
                        removeBusy={removeMutation.isPending && removeMutation.variables?.companyId === companyId && removeMutation.variables.connectorId === c.id}
                        companyId={companyId}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            {isFounder ? (
              <NewConnectorDialog
                open={showAddConnector}
                onOpenChange={setShowAddConnector}
                companyId={companyId}
                stdioAllowed={stdioAllowed}
                onSuccess={invalidate}
              />
            ) : (
              <div className="rounded-md border border-border px-4 py-3 text-sm text-muted-foreground">
                Only founders can add or change connectors.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface ConnectorRowProps {
  connector: McpConnector;
  agents: { id: string; name: string; status?: string }[];
  isFounder: boolean;
  onDisable: () => void;
  onEnable: () => void;
  onRemove: () => void;
  disableBusy: boolean;
  enableBusy: boolean;
  removeBusy: boolean;
  companyId: string;
}

function ConnectorRow({
  connector,
  agents,
  isFounder,
  onDisable,
  onEnable,
  onRemove,
  disableBusy,
  enableBusy,
  removeBusy,
  companyId,
}: ConnectorRowProps) {
  const queryClient = useQueryClient();
  const [showAgents, setShowAgents] = useState(false);
  const [showCredential, setShowCredential] = useState(false);
  const [credentialRef, setCredentialRef] = useState("");
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [reauthorizeError, setReauthorizeError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const companyIdRef = useRef(companyId);
  companyIdRef.current = companyId;
  const redirectStartedRef = useRef(false);

  // "Installed but unusable": the catalog entry declared a credential and none
  // is bound. This is the state every `requiresSecret` catalog install lands in,
  // so it must carry its own next step rather than relying on the founder
  // guessing that a secret goes somewhere.
  const needsCredential = connector.requiresSecret && !connector.secretRef;
  const isOAuthConnector = connector.oauthEligibility !== "not_oauth";
  const canAuthorizeOAuth = connector.oauthEligibility === "supported";
  const isOAuthPolicyBlocked = connector.oauthEligibility === "policy_blocked";
  const expectedKeys = [
    ...Object.keys(connector.headerTemplate ?? {}),
    ...Object.keys(connector.envTemplate ?? {}),
  ];

  const bindCredentialMutation = useMutation({
    mutationFn: (secretRef: string) =>
      mcpConnectorsApi.bindCredentials(companyId, connector.id, secretRef),
    onSuccess: () => {
      setCredentialError(null);
      setShowCredential(false);
      setCredentialRef("");
      queryClient.invalidateQueries({
        queryKey: queryKeys.mcpConnectors.list(companyId),
      });
    },
    onError: (err) =>
      setCredentialError(
        err instanceof ApiError ? err.message : "Failed to bind credential"
      ),
  });

  // Re-authorize (Task 16): a needs_credentials connector whose catalog entry is
  // OAuth-type never got (or lost) its token bundle — the fix is redoing the
  // sign-in round trip, not pasting a secretRef, so this replaces "Add
  // credential" for that connector rather than sitting beside it.
  const oauthStartMutation = useMutation({
    mutationFn: ({ companyId: scopeCompanyId, connectorId }: { companyId: string; connectorId: string }) =>
      mcpConnectorsApi.oauthStart(scopeCompanyId, connectorId),
    onSuccess: ({ authorizeUrl }, variables) => {
      if (companyIdRef.current !== variables.companyId || redirectStartedRef.current) return;
      redirectStartedRef.current = true;
      setReauthorizeError(null);
      window.location.assign(authorizeUrl);
    },
    onError: (err, variables) => {
      if (companyIdRef.current === variables.companyId)
        setReauthorizeError(
          err instanceof ApiError
            ? err.message
            : "Failed to start re-authorization"
        );
    },
  });
  // Seeded from the connector's CURRENT enabled-agent set (A34). PUT …/agents
  // REPLACES the whole set, so starting empty would silently wipe agents the
  // founder didn't touch. Re-seeding on open (and after a save-driven refetch)
  // keeps the checkboxes an accurate mirror of server state.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(connector.enabledAgentIds)
  );
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentSaved, setAgentSaved] = useState(false);

  // Seed on the closed→open transition only (deps: [showAgents]). The effect
  // captures the current enabledAgentIds from render, so an open always reflects
  // fresh server state; it deliberately does NOT re-run on a mid-open refetch,
  // so a just-saved confirmation isn't flash-cleared.
  useEffect(() => {
    if (!showAgents) return;
    setSelected(new Set(connector.enabledAgentIds));
    setAgentSaved(false);
    setAgentError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAgents]);

  const setAgentsMutation = useMutation({
    mutationFn: (agentIds: string[]) =>
      mcpConnectorsApi.setAgents(companyId, connector.id, agentIds),
    onSuccess: () => {
      setAgentError(null);
      setAgentSaved(true);
      // Refetch so connector.enabledAgentIds reflects the just-saved set — the
      // seed-on-open effect then mirrors server state on the next open (A34).
      queryClient.invalidateQueries({
        queryKey: queryKeys.mcpConnectors.list(companyId),
      });
    },
    onError: (err) => {
      setAgentSaved(false);
      setAgentError(
        err instanceof ApiError ? err.message : "Failed to update agent access"
      );
    },
  });

  const toggle = (id: string) => {
    setAgentSaved(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Hide terminated agents from the assignable checkboxes (they can't run, so
  // offering them is noise). Note: an already-enabled terminated agent stays in
  // `selected` (seeded from the full enabledAgentIds) and is PRESERVED on Save —
  // we hide it from the UI but don't forcibly revoke the link. Agents whose
  // status the list doesn't expose are kept (fail-open on unknown).
  const sortedAgents = useMemo(
    () =>
      [...agents]
        .filter((a) => a.status !== "terminated")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [agents]
  );

  return (
    <div
      data-testid={`connector-row-${connector.id}`}
      className="rounded-md border border-border px-3 py-3 space-y-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate">
              {connector.displayName}
            </span>
            <TransportBadge transport={connector.transport} />
            {isOAuthPolicyBlocked ? (
              <Badge variant="pending">Unavailable</Badge>
            ) : (
              <StatusBadge status={connector.status} />
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 font-mono break-all">
            {connector.serverName}
            {connector.transport === "http" && connector.url
              ? ` · ${connector.url}`
              : ""}
            {connector.transport === "stdio" && connector.command
              ? ` · ${connector.command}`
              : ""}
          </div>
          {/* Who-can-use-this at a glance (b2): Commander always has access to
              every active connector for free (see the access-model note below);
              assigned crew/org agents come from `enabledAgentIds`. Scoped to
              `active` — a disabled/needs_credentials connector isn't reaching
              anyone regardless of assignment, and the status badge + Enable /
              Re-authorize / Add-credential affordances already own that story. */}
          {connector.status === "active" && !isOAuthPolicyBlocked && (
            <div
              data-testid={`connector-access-${connector.id}`}
              className="text-xs text-muted-foreground mt-0.5"
            >
              {connector.enabledAgentIds.length > 0
                ? `Used by Commander + ${
                    connector.enabledAgentIds.length
                  } agent${connector.enabledAgentIds.length === 1 ? "" : "s"}`
                : "Used by Commander only"}
            </div>
          )}
        </div>
        {isFounder && (
          <div className="flex items-center gap-1 shrink-0">
            {needsCredential && !isOAuthConnector && (
              <Button size="sm" onClick={() => setShowCredential((v) => !v)}>
                Add credential
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowAgents((v) => !v)}
            >
              Agents
            </Button>
            {connector.status === "disabled" ? (
              <Button size="sm" onClick={onEnable} disabled={enableBusy || isOAuthPolicyBlocked}>
                {isOAuthPolicyBlocked ? "Unavailable" : enableBusy ? "Enabling..." : "Enable"}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={onDisable}
                disabled={disableBusy}
              >
                Disable
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              onClick={() => setConfirmRemove(true)}
              disabled={removeBusy}
            >
              Remove
            </Button>
          </div>
        )}
      </div>

      {/* Remove is destructive (deletes the connector + unbinds its credential,
          and every agent assigned to it loses access) and used to fire
          immediately on click — this confirmation closes that gap. */}
      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove connector?</DialogTitle>
            <DialogDescription>
              This permanently removes <strong>{connector.displayName}</strong>{" "}
              and unbinds its credential. Agents will lose access. This
              can&rsquo;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmRemove(false)}
              disabled={removeBusy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setConfirmRemove(false);
                onRemove();
              }}
              disabled={removeBusy}
            >
              {removeBusy ? "Removing..." : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delivery health (FU-1) — an active connector that would be silently
          dropped at run time. Shown to every board member, not just founders:
          "why isn't my connector working?" is a read, and the reason may be a
          deployment-mode block a non-founder still needs to understand. */}
      <DeliverabilityWarning connector={connector} />

      {/* Re-authorize (Task 16) — the OAuth counterpart of the credential
          affordance below. A needs_credentials OAuth connector never got (or
          lost) its token bundle; the fix is re-running the sign-in round trip,
          so this replaces "Add credential" for that connector instead of
          sitting beside it.

          Final-review Fix 1: gated on `connector.status === "needs_credentials"`
          rather than `needsCredential` (`requiresSecret && !secretRef`). The
          runtime JIT-refresh-failure path sets status: "needs_credentials" while
          KEEPING the (now stale/expired) secretRef bound — the exact case this
          button exists for — so `needsCredential` is false there and the old
          condition never rendered it. Status is the correct signal: it is the
          server's own answer to "does this connector need attention right now?",
          independent of whether a (possibly stale) secretRef happens to still be
          set. */}
      {connector.status === "needs_credentials" && canAuthorizeOAuth && (
          <div
            data-testid={`connector-reauthorize-${connector.id}`}
            role="status"
            className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 flex items-center justify-between gap-3"
          >
            <div className="text-xs text-muted-foreground">
              This connector uses OAuth sign-in and needs authorization before
              agents can use it.
            </div>
            {isFounder && (
              <Button
                size="sm"
                onClick={() => {
                  if (oauthStartMutation.isPending || redirectStartedRef.current) return;
                  oauthStartMutation.mutate({ companyId, connectorId: connector.id });
                }}
                disabled={oauthStartMutation.isPending || redirectStartedRef.current}
              >
                {oauthStartMutation.isPending ? "Starting..." : "Re-authorize"}
              </Button>
            )}
          </div>
        )}
      {isFounder && reauthorizeError && (
        <div role="alert" className="text-sm text-destructive">{reauthorizeError}</div>
      )}

      {isOAuthPolicyBlocked && (
        <div
          data-testid={`connector-oauth-policy-blocked-${connector.id}`}
          role="status"
          className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted-foreground"
        >
          This connector is unavailable to agents.{" "}
          {connector.oauthUnavailableReason ??
            "OAuth is unavailable for this connector under the current server policy."}
        </div>
      )}

      {isFounder && needsCredential && !isOAuthConnector && !showCredential && (
        <div className="text-xs text-muted-foreground">
          This connector needs a credential before agents can use it.
        </div>
      )}

      {isFounder && showCredential && (
        <div className="rounded-md border border-border-soft bg-muted/20 px-3 py-3 space-y-2">
          <div className="text-xs text-muted-foreground">
            Point this connector at an existing company secret (Settings →
            Secrets). The <code>{"${TOKEN}"}</code> placeholder in its
            {expectedKeys.length > 0 ? (
              <>
                {" "}
                template keys (
                <span className="font-mono">{expectedKeys.join(", ")}</span>)
              </>
            ) : (
              " templates"
            )}{" "}
            resolves to the secret's value.
          </div>
          <label className="space-y-1 block">
            <div className="text-xs text-muted-foreground">
              Secret reference
            </div>
            <input
              className={inputCls}
              aria-label="Secret reference"
              value={credentialRef}
              onChange={(e) => setCredentialRef(e.target.value)}
              placeholder="mcp:notion"
            />
          </label>
          {credentialError && (
            <div role="alert" className="text-sm text-destructive">{credentialError}</div>
          )}
          <div className="flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowCredential(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() =>
                bindCredentialMutation.mutate(credentialRef.trim())
              }
              disabled={
                bindCredentialMutation.isPending || !credentialRef.trim()
              }
            >
              {bindCredentialMutation.isPending
                ? "Saving..."
                : "Save credential"}
            </Button>
          </div>
        </div>
      )}

      {isFounder && showAgents && (
        <div className="rounded-md border border-border-soft bg-muted/20 px-3 py-3 space-y-2">
          <div className="text-xs text-muted-foreground">
            Choose which agents may use this connector. Checkboxes reflect the
            current set; Save replaces this connector's enabled-agent set with
            your selection.
          </div>
          {sortedAgents.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No agents in this company yet. Create one on the{" "}
              <span className="font-medium text-foreground">Agents</span> page,
              then assign it here. Commander already has access to active
              connectors.
            </div>
          ) : (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {sortedAgents.map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(a.id)}
                    onChange={() => toggle(a.id)}
                  />
                  <span className="truncate">{a.name}</span>
                </label>
              ))}
            </div>
          )}
          {agentError && (
            <div role="alert" className="text-sm text-destructive">{agentError}</div>
          )}
          {agentSaved && !agentError && (
            <div role="status" aria-live="polite" className="text-xs text-emerald-500">
              Agent access updated.
            </div>
          )}
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => setAgentsMutation.mutate([...selected])}
              disabled={setAgentsMutation.isPending}
            >
              {setAgentsMutation.isPending ? "Saving..." : "Save agent access"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
