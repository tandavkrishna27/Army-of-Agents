import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Cable, Github } from "lucide-react";
import {
  mcpConnectorsApi,
  type McpConnector,
  type McpConnectorShelfEntry,
} from "@/api/mcpConnectors";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { isConsentFresh } from "./consentFreshness";
import { ConnectorInstallDialog, commandLine } from "./ConnectorInstallDialog";

/**
 * Last-resort copy only. The reason a card is unavailable comes from the SERVER
 * (`entry.unavailableReason`), sourced from the D7 gate's own thrown message, so
 * the founder always reads the refusal that actually happened rather than a
 * client-side guess that would go stale the moment the gate grows a second
 * refusal branch. This constant covers only the case where the field is missing.
 *
 * Rendering the reason (rather than hiding the card, or greying it silently) is
 * the point: a capability that disappears without explanation is indistinguishable
 * from a bug, and founders work around bugs by pasting credentials into the
 * manual form.
 */
const UNAVAILABLE_FALLBACK =
  "This connector cannot be installed in this deployment.";

function TrustPill({ tier }: { tier: string }) {
  if (tier === "verified") return null;
  return (
    <Badge variant="idle" className="text-[10px]">
      {tier === "unverified" ? "Unverified" : "Community"}
    </Badge>
  );
}

interface ShelfCardProps {
  entry: McpConnectorShelfEntry;
  installed: McpConnector | undefined;
  busy: boolean;
  onInstall: () => void;
  /** Install (if needed) then start the OAuth broker round trip and navigate to
   *  the provider's consent page. Only called for `entry.oauthRequired` cards. */
  onAuthorize: () => void;
}

/** Marketplace card chrome (design-system §9.13), minus the bits that only make
 *  sense for catalog items: no TypeChip (every card here is a connector) and no
 *  detail-page link (connectors have no detail route). */
function ShelfCard({
  entry,
  installed,
  busy,
  onInstall,
  onAuthorize,
}: ShelfCardProps) {
  const verified = entry.trust?.tier === "verified";
  const unavailable = !entry.installable;
  const canRetryOAuth =
    entry.oauthRequired &&
    installed?.oauthEligibility === "supported" &&
    installed.status === "needs_credentials";

  return (
    <div
      data-testid={`connector-shelf-card-${entry.id}`}
      className={cn(
        "relative rounded-xl border border-border-strong bg-card overflow-hidden p-4",
        unavailable ? "opacity-70" : "card-hover"
      )}
    >
      <div className="flex items-start gap-3">
        <div className="size-12 shrink-0 rounded-2xl border bg-blue-500/15 border-blue-500/30 text-blue-500 flex items-center justify-center">
          <Cable className="size-5" />
        </div>
        <div className="min-w-0 flex-1 mt-0.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h3 className="text-[1.05rem] font-semibold tracking-tight truncate">
              {entry.displayName}
            </h3>
            {verified && (
              <BadgeCheck
                data-testid="verified-check"
                className="size-4 shrink-0 text-[hsl(208_80%_60%)]"
                aria-label="Verified"
              />
            )}
            <TrustPill tier={entry.trust?.tier ?? "community"} />
            {entry.requiresOAuth && (
              <Badge
                data-testid="connector-oauth-tag"
                variant="idle"
                className="text-[10px]"
              >
                OAuth
              </Badge>
            )}
          </div>
          <div className="mt-0.5 text-[12px] text-very-dim truncate font-mono">
            {entry.transport === "http" ? entry.url : commandLine(entry)}
          </div>
        </div>
      </div>

      {entry.description && (
        <p className="mt-3 text-[12.5px] text-dim leading-relaxed line-clamp-2">
          {entry.description}
        </p>
      )}

      {entry.requiresSecret && (
        <div className="mt-2 text-[11.5px] text-very-dim">
          Needs a credential{entry.secretLabel ? `: ${entry.secretLabel}` : ""}
        </div>
      )}

      {unavailable && (
        <div
          data-testid="connector-unavailable-reason"
          className="mt-3 rounded-md border border-border bg-card-2 px-2.5 py-2 text-[11.5px] text-dim"
        >
          <span className="font-medium text-foreground">
            Unavailable in this deployment.{" "}
          </span>
          {entry.unavailableReason ?? UNAVAILABLE_FALLBACK}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0 text-[11.5px] text-very-dim">
          {entry.docsUrl ? (
            <a
              href={entry.docsUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 hover:text-foreground"
            >
              <Github className="size-3 shrink-0" />
              <span className="truncate">Docs</span>
            </a>
          ) : (
            <span className="truncate">
              {entry.transport === "http" ? "HTTP" : "Local (stdio)"}
            </span>
          )}
        </div>
        {installed && !canRetryOAuth ? (
          <Badge variant="active" className="h-7 px-2.5 shrink-0">
            Installed
          </Badge>
        ) : entry.oauthRequired ? (
          // The broker (Plan 4) handles OAuth entries: install-then-authorize,
          // not install-then-done. `unavailable` still applies (D7 can refuse an
          // OAuth entry's transport too), so a D7-refused OAuth card falls through
          // to the unavailable branch below rather than offering a dead button.
          unavailable ? null : (
            <Button
              size="sm"
              className="text-[11.5px] h-7 px-3 shrink-0"
              onClick={onAuthorize}
              disabled={busy}
              aria-label={`${
                canRetryOAuth ? "Retry authorization for" : "Authorize"
              } ${entry.displayName}`}
            >
              {busy ? "…" : canRetryOAuth ? "Retry authorization" : "Authorize"}
            </Button>
          )
        ) : unavailable ? null : (
          <Button
            size="sm"
            className="text-[11.5px] h-7 px-3 shrink-0"
            onClick={onInstall}
            disabled={busy}
            aria-label={`Install ${entry.displayName}`}
          >
            {busy ? "…" : "Install"}
          </Button>
        )}
      </div>
    </div>
  );
}

export interface ConnectorShelfProps {
  companyId: string;
  /** The company's already-registered connectors, used to mark installed cards.
   *  OAuth entries match on immutable `catalogEntryId`; `serverName` is never
   *  used as OAuth identity. Static legacy rows retain a display-only fallback.
   *  key the server enforces — installing a second time 409s. */
  installed: McpConnector[];
  /** Called after a successful install so the surface can point the founder at
   *  the credential step when the new connector landed unconfigured. */
  onInstalled: (connector: McpConnector) => void;
  /** Optional free-text filter over name/description/serverName. Filtering is
   *  presentational only — an entry hidden by search is still installable, and
   *  nothing about consent or availability is derived from it. */
  search?: string;
}

/**
 * The curated connector shelf — the BROWSE + INSTALL half of the connector
 * journey. It is mounted by the Marketplace connectors surface
 * (`pages/MarketplaceConnectors.tsx`), which is where every other installable
 * type (skills, agents, plugins, teams) is browsed and installed from.
 *
 * It used to live in Settings → Connectors. That placement invented a second
 * pattern: Settings is where you MANAGE what you already have, and a browsable
 * catalog hidden inside it is not discoverable as "the place you get things".
 * The two arguments for the old placement both resolved:
 *
 *  - "No company in context on the Marketplace" — false. The marketplace API is
 *    already company-scoped and the other types resolve their target through
 *    `CompanyContext.selectedCompanyId` + `CompanyPicker` (see
 *    `install/SnapshotInstallModal.tsx`). This surface follows that exact
 *    mechanism; the only difference is the picker is hoisted to the page,
 *    because the connector CATALOG fetch is itself company-scoped.
 *  - "The journey does not end at install" — true, and the reason this component
 *    hands its caller the created connector: the surface points the founder
 *    straight at Settings → Connectors for the credential/approval step, the
 *    same way a skill install toast points at the company's skills.
 *
 * This component owns NOTHING about placement. Everything security-critical —
 * the exact argv shown for unverified stdio, the consent-token freshness
 * refetch, greying with the SERVER's `unavailableReason` — is unchanged by the
 * move and must stay that way.
 */
export function ConnectorShelf({
  companyId,
  installed,
  onInstalled,
  search = "",
}: ConnectorShelfProps) {
  const queryClient = useQueryClient();
  const [dialogEntryId, setDialogEntryId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const companyIdRef = useRef(companyId);
  companyIdRef.current = companyId;
  const redirectStartedRef = useRef(false);

  useEffect(() => {
    setDialogEntryId(null);
    setPendingId(null);
    setError(null);
    redirectStartedRef.current = false;
  }, [companyId]);

  const catalogQuery = useQuery({
    queryKey: queryKeys.mcpConnectors.catalog(companyId),
    queryFn: () => mcpConnectorsApi.catalog(companyId),
  });

  const entries = catalogQuery.data?.entries ?? [];
  // Derived from LIVE query data, not captured at open time: when the freshness
  // check below refetches, the open dialog re-renders against the refreshed
  // entry (new token, and the command that token was minted for) automatically.
  const dialogEntry = entries.find((e) => e.id === dialogEntryId) ?? null;
  const connectorForEntry = (entry: McpConnectorShelfEntry) =>
    installed.find((connector) => connector.catalogEntryId === entry.id) ??
    // Static pre-identity rows keep the historical display-only fallback. OAuth
    // must be reinstalled/migrated and never receives this inference path.
    (!entry.oauthRequired
      ? installed.find((connector) => connector.serverName === entry.serverName)
      : undefined);

  // Search filters what is DRAWN, never what `dialogEntry` resolves against —
  // typing while the consent dialog is open must not silently unmount the
  // dialog (and with it the argv the founder is mid-way through reading).
  const q = search.trim().toLowerCase();
  const visibleEntries = q
    ? entries.filter(
        (e) =>
          e.displayName.toLowerCase().includes(q) ||
          e.serverName.toLowerCase().includes(q) ||
          (e.description ?? "").toLowerCase().includes(q)
      )
    : entries;

  const installMutation = useMutation({
    mutationFn: ({ companyId: scopeCompanyId, body }: { companyId: string; body: { entryId: string; consentToken?: string } }) =>
      mcpConnectorsApi.install(scopeCompanyId, body),
    onSuccess: (created, variables) => {
      if (companyIdRef.current === variables.companyId) {
        setError(null);
        setDialogEntryId(null);
        setPendingId(null);
        onInstalled(created);
      }
      // Invalidating the LIST key also invalidates the catalog (it is a prefix
      // of the catalog key), which re-mints consent tokens — cheap and correct.
      queryClient.invalidateQueries({
        queryKey: queryKeys.mcpConnectors.list(variables.companyId),
      });
    },
    onError: (err, variables) => {
      if (companyIdRef.current === variables.companyId) {
        setPendingId(null);
        setError(
          err instanceof ApiError ? err.message : "Failed to install connector"
        );
      }
    },
  });

  const authorizeMutation = useMutation({
    mutationFn: async ({ companyId: scopeCompanyId, entry, existingId }: { companyId: string; entry: McpConnectorShelfEntry; existingId?: string }) => {
      // Install first if this immutable catalog identity isn't registered, then start
      // the OAuth broker round trip and hand the browser off to the provider's
      // consent page. A re-authorize (already installed, dead token) skips
      // straight to oauth/start — no duplicate install POST.
      const installedNow = existingId === undefined;
      const connectorId =
        existingId ??
        (await mcpConnectorsApi.install(scopeCompanyId, { entryId: entry.id })).id;
      try {
        const { authorizeUrl } = await mcpConnectorsApi.oauthStart(
          scopeCompanyId,
          connectorId
        );
        return { authorizeUrl };
      } catch (error) {
        // Install and OAuth start are intentionally separate server operations.
        // If start fails, re-read the successfully installed row so retry uses
        // its immutable catalog identity instead of attempting a duplicate install.
        if (installedNow) {
          await queryClient.invalidateQueries({
            queryKey: queryKeys.mcpConnectors.list(scopeCompanyId),
            refetchType: "active",
          });
        }
        throw error;
      }
    },
    onSuccess: ({ authorizeUrl }, variables) => {
      if (companyIdRef.current === variables.companyId) setPendingId(null);
      // Mirrors installMutation: a fresh install needs the list re-fetched so a
      // second click on this shelf (before the redirect lands) sees it installed.
      queryClient.invalidateQueries({
        queryKey: queryKeys.mcpConnectors.list(variables.companyId),
      });
      if (companyIdRef.current === variables.companyId && !redirectStartedRef.current) {
        redirectStartedRef.current = true;
        window.location.assign(authorizeUrl);
      }
    },
    onError: (err, variables) => {
      if (companyIdRef.current === variables.companyId) {
        setPendingId(null);
        setError(
          err instanceof ApiError ? err.message : "Failed to start authorization"
        );
      }
    },
  });

  const handleAuthorize = (entry: McpConnectorShelfEntry) => {
    const currentAuthorizePending =
      authorizeMutation.isPending && authorizeMutation.variables?.companyId === companyId;
    if (currentAuthorizePending || redirectStartedRef.current) return;
    setError(null);
    setPendingId(entry.id);
    authorizeMutation.mutate({
      companyId,
      entry,
      existingId: connectorForEntry(entry)?.id,
    });
  };

  const handleInstall = async (entry: McpConnectorShelfEntry) => {
    setError(null);

    // Verified entries and every http entry install straight through: there is
    // no host command to consent to, and the server asks for no token.
    if (!entry.consentRequired) {
      setPendingId(entry.id);
      installMutation.mutate({ companyId, body: { entryId: entry.id } });
      return;
    }

    if (isConsentFresh(entry)) {
      setDialogEntryId(entry.id);
      return;
    }

    // Stale (or never-minted) token → refetch BEFORE showing the dialog, so the
    // founder never confirms a command bound to a token the server will reject.
    setPendingId(entry.id);
    const refreshed = await catalogQuery.refetch();
    if (companyIdRef.current !== companyId) return;
    setPendingId(null);
    const fresh = refreshed.data?.entries.find((e) => e.id === entry.id);
    if (!fresh) {
      setError(`"${entry.displayName}" is no longer in the connector catalog.`);
      return;
    }
    if (!fresh.installable) {
      setError(`"${entry.displayName}" is not installable in this deployment.`);
      return;
    }
    setDialogEntryId(entry.id);
  };

  if (catalogQuery.isLoading) {
    return (
      <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
        Loading connector catalog…
      </div>
    );
  }
  if (catalogQuery.isError) {
    return (
      <div role="alert" className="text-sm text-muted-foreground">
        Could not load the connector catalog. You can still add a connector by
        hand in Settings → Connectors.
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No curated connectors are available right now. You can add one by hand
        in Settings → Connectors.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {catalogQuery.data?.stale && (
        <div className="text-[11.5px] text-very-dim">
          Showing a cached catalog — the connector directory could not be
          refreshed.
        </div>
      )}
      {error && <div role="alert" className="text-sm text-destructive">{error}</div>}
      {visibleEntries.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-6 text-sm text-dim text-center">
          No matches.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {visibleEntries.map((entry) => (
            <ShelfCard
              key={entry.id}
              entry={entry}
              installed={connectorForEntry(entry)}
              busy={pendingId === entry.id}
              onInstall={() => void handleInstall(entry)}
              onAuthorize={() => handleAuthorize(entry)}
            />
          ))}
        </div>
      )}

      <ConnectorInstallDialog
        entry={dialogEntry}
        onClose={() => {
          setDialogEntryId(null);
          setError(null);
        }}
        onConfirm={(entry) =>
          installMutation.mutate({
            companyId,
            body: {
              entryId: entry.id,
              consentToken: entry.consentToken,
            },
          })
        }
        busy={installMutation.isPending}
        error={dialogEntryId ? error : null}
      />
    </div>
  );
}
