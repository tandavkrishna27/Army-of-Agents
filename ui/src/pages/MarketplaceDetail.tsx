import { useMemo, useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ChevronDown,
  ChevronUp,
  ChevronRight,
  ExternalLink,
  BadgeCheck,
  ChevronLeft,
  Layers,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useCatalog } from "@/hooks/useCatalog";
import { usePackages } from "@/hooks/usePackages";
import { packageDetailUrl } from "@/components/marketplace/PackageCard";
import { listCompanyPlugins, type InstalledPlugin } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { LobbyShellMobileMenuButton } from "@/components/LobbyShell";
import { TrustBadge } from "@/components/marketplace/TrustBadge";
import { TypeChip } from "@/components/marketplace/TypeChip";
import { ReadmeRender } from "@/components/marketplace/ReadmeRender";
import { ProviderLogo } from "@/components/marketplace/ProviderLogo";
import { PluginInstallModal } from "@/components/marketplace/install/PluginInstallModal";
import { SnapshotInstallModal } from "@/components/marketplace/install/SnapshotInstallModal";
import {
  TYPE_ICONS,
  TYPE_LABELS_PLURAL,
  deriveMarketplacePlacement,
  pathToItemType,
  shortSource,
} from "@/lib/marketplace-constants";
import { useMarketplaceSidebar } from "@/components/marketplace/useMarketplaceSidebar";
import type { MarketplaceItemType } from "@armyofagents/shared";
import { useCompany } from "@/context/CompanyContext";

const CAP_PREVIEW = 8;

const TYPE_AVATAR_BG: Record<MarketplaceItemType, string> = {
  plugin: "bg-violet-500/15 text-violet-400",
  skill: "bg-teal-500/15   text-teal-400",
  agent: "bg-blue-500/15   text-blue-400",
  team: "bg-amber-500/15  text-amber-400",
};

export interface MarketplaceDetailProps {
  fixedType?: MarketplaceItemType;
}

export default function MarketplaceDetail({
  fixedType,
}: MarketplaceDetailProps = {}) {
  const params = useParams<{ type: string; slug: string; "*": string }>();
  const itemType =
    fixedType ?? (params.type ? pathToItemType(params.type) : null);
  const slugSegment = params.slug ?? "";
  const restPath = params["*"] ?? "";
  const fullSlug = restPath ? `${slugSegment}/${restPath}` : slugSegment;
  const catalogItemId = itemType ? `${itemType}:${fullSlug}` : null;

  const { data: catalog, isLoading, error } = useCatalog();
  const { data: packages, error: packagesError } = usePackages();
  const [readmeText, setReadmeText] = useState<string | null>(null);
  const [readmeError, setReadmeError] = useState<string | null>(null);
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [showAllCaps, setShowAllCaps] = useState(false);
  const { selectedCompanyId } = useCompany();

  const {
    data: installedPlugins,
    error: installedPluginsError,
    refetch: refetchInstalledPlugins,
  } = useQuery<InstalledPlugin[]>({
    queryKey: queryKeys.plugins.companyList(selectedCompanyId ?? ""),
    queryFn: () => listCompanyPlugins(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const item = useMemo(() => {
    if (!catalog || !catalogItemId) return null;
    return catalog.items.find((i) => i.id === catalogItemId) ?? null;
  }, [catalog, catalogItemId]);

  const placement = useMemo(
    () => deriveMarketplacePlacement(catalog?.items ?? [], packages ?? []),
    [catalog, packages]
  );
  // Placement (AoA classification → back-link, sidebar, "Part of X") depends on the
  // packages query. Treat packages as part of load/error resolution so navigation is
  // never derived from an empty `packages ?? []` fallback while the query is still in
  // flight or has failed — otherwise an AoA-packaged item is mislabeled (permanently
  // and silently on failure). See AGENTS.md §10 "do not silently ignore API errors".
  const packagesResolved = packages !== undefined;
  const detailError = error ?? packagesError ?? null;
  // Show the skeleton until BOTH queries resolve — but never mask an error behind it:
  // once catalog OR packages has errored, surface the error state immediately rather
  // than waiting for the other query to settle.
  const detailLoading = detailError == null && (isLoading || !packagesResolved);
  const isAoa =
    item && packagesResolved
      ? placement.aoaRepresentedItemIds.has(item.id)
      : false;
  // Navigation (sidebar, breadcrumb, back-link) must reflect RESOLVED placement.
  // Until both the item and the packages query resolve, AoA-vs-type membership is
  // unknown, so neutralize nav to the generic marketplace target instead of
  // committing to a possibly-wrong type/AoA target while loading or after a
  // packages-load failure — otherwise an AoA package member flashes (or, on
  // failure, persistently shows) a wrong "Skills" back-link (Codex P3; AGENTS.md §10).
  const navResolved = item != null && packagesResolved;
  useMarketplaceSidebar(
    navResolved ? (isAoa ? "aoa" : itemType ?? "home") : "home"
  );
  const backTo = navResolved
    ? isAoa
      ? "/marketplace?view=aoa"
      : itemType
      ? `/marketplace?type=${itemType}`
      : "/marketplace"
    : "/marketplace";
  const backLabel = navResolved
    ? isAoa
      ? "AoA"
      : itemType
      ? TYPE_LABELS_PLURAL[itemType]
      : "marketplace"
    : "marketplace";

  const parentPackage = useMemo(() => {
    if (!item || !packages) return null;
    return packages.find((p) => p.memberItemIds.includes(item.id)) ?? null;
  }, [item, packages]);

  const installedByPackageName = useMemo(
    () => new Map((installedPlugins ?? []).map((p) => [p.packageName, p])),
    [installedPlugins]
  );

  const installedPlugin = item?.npm?.packageName
    ? installedByPackageName.get(item.npm.packageName)
    : undefined;
  const installedStateReady =
    !!selectedCompanyId && installedPlugins !== undefined;

  useEffect(() => {
    if (!item) return;
    if (item.content?.inline) {
      setReadmeText(item.content.inline);
      return;
    }
    if (!item.resourceUrl) {
      setReadmeText("(No README available)");
      return;
    }
    setReadmeText(null);
    setReadmeError(null);
    const controller = new AbortController();
    fetch(item.resourceUrl, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => setReadmeText(text))
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setReadmeError(err.message);
      });
    return () => controller.abort();
  }, [item]);

  const Icon = itemType ? TYPE_ICONS[itemType] : null;
  const caps = item?.capabilities ?? [];
  const visibleCaps = showAllCaps ? caps : caps.slice(0, CAP_PREVIEW);
  const hiddenCapsCount = caps.length - CAP_PREVIEW;
  const heroDescription =
    item && item.description.trim() && item.description.trim() !== ">"
      ? item.description
      : null;

  return (
    <>
      <div className="mx-auto w-full max-w-[920px] px-4 py-6 sm:px-6 sm:py-7 md:px-10 md:py-9">
        <LobbyShellMobileMenuButton className="mb-4" />
        <Link
          to={backTo}
          className="mb-4 inline-flex items-center gap-1 text-[12px] text-very-dim hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" /> Marketplace
          {backLabel !== "marketplace" ? ` · ${backLabel}` : ""}
        </Link>

        {!itemType && (
          <div className="text-center py-12">
            <p className="text-lg font-medium">Unknown item type</p>
            <Link
              to="/marketplace"
              className="text-sm text-primary hover:underline mt-2 inline-block"
            >
              ← Back to marketplace
            </Link>
          </div>
        )}

        {itemType && detailLoading && (
          <div className="space-y-6 max-w-4xl mx-auto">
            <Skeleton className="h-10 w-64" />
            <Skeleton className="h-4 w-96" />
            <Skeleton className="h-4 w-80" />
            <Separator />
            <Skeleton className="h-40 w-full" />
          </div>
        )}

        {itemType && !detailLoading && (detailError || !catalog) && (
          <div className="text-center py-12">
            <p className="text-lg font-medium">Could not load this item</p>
            <p className="text-sm text-muted-foreground mt-2">
              {detailError?.message ?? "Catalog unavailable"}
            </p>
            <Link
              to={backTo}
              className="text-sm text-primary hover:underline mt-3 inline-block"
            >
              ← Back to {backLabel}
            </Link>
          </div>
        )}

        {itemType && !detailLoading && !detailError && catalog && !item && (
          <div className="text-center py-12">
            <p className="text-lg font-medium">
              Item not found: {catalogItemId}
            </p>
            <Link
              to={backTo}
              className="text-sm text-primary hover:underline mt-2 inline-block"
            >
              ← Back to {backLabel}
            </Link>
          </div>
        )}

        {itemType && !detailLoading && !detailError && item && Icon && (
          <div className="max-w-4xl mx-auto space-y-8">
            {/* ── Hero ───────────────────────────────────────────────────────────── */}
            <div
              data-testid="marketplace-detail-hero-card"
              className="relative overflow-hidden rounded-2xl border border-border-strong bg-card p-6"
            >
              <span
                aria-hidden
                className={cn(
                  "absolute left-0 top-6 bottom-6 w-[3px] rounded-r",
                  item.type === "skill" && "bg-teal-500",
                  item.type === "plugin" && "bg-blue-500",
                  item.type === "agent" && "bg-blue-500",
                  item.type === "team" && "bg-amber-500"
                )}
              />
              <TypeChip
                type={item.type}
                data-testid="marketplace-detail-type-badge"
                className={cn(
                  "absolute right-5 top-5 inline-flex rounded-full border px-2 py-1",
                  item.type === "skill" &&
                    "border-teal-500/25 bg-teal-500/10 text-teal-400",
                  item.type === "agent" &&
                    "border-blue-500/25 bg-blue-500/10 text-blue-400",
                  item.type === "team" &&
                    "border-amber-500/25 bg-amber-500/10 text-amber-400"
                )}
              />
              <div className="flex flex-col gap-5 pl-2 sm:pr-24">
                {/* Left: avatar + info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start gap-4 mb-4">
                    {item.provider ? (
                      <ProviderLogo
                        provider={item.provider}
                        className="size-16 shrink-0 rounded-2xl"
                      />
                    ) : (
                      <div
                        className={cn(
                          "w-16 h-16 rounded-2xl flex items-center justify-center text-2xl font-bold shrink-0",
                          TYPE_AVATAR_BG[item.type]
                        )}
                      >
                        {item.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0 pt-1">
                      <div className="flex items-center gap-2">
                        <h1 className="text-2xl font-bold leading-tight">
                          {item.name}
                        </h1>
                        {item.trust.tier === "verified" && (
                          <BadgeCheck
                            data-testid="hero-verified"
                            className="size-5 shrink-0 text-[hsl(208_80%_60%)]"
                            aria-label="Verified"
                          />
                        )}
                      </div>
                      {item.provider && (
                        <div className="mt-1 text-[12.5px] text-dim">
                          by {item.provider.name}
                        </div>
                      )}
                      <div
                        data-testid="marketplace-detail-badges"
                        className="mt-3 flex flex-wrap items-center gap-2"
                      >
                        {parentPackage && (
                          <Link
                            to={packageDetailUrl(parentPackage)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/25 text-[11px] font-medium text-amber-400 hover:bg-amber-500/20 transition-colors w-fit"
                          >
                            <Layers className="size-3" />
                            Part of {parentPackage.name}
                            <ChevronRight className="size-3" />
                          </Link>
                        )}
                        <TrustBadge tier={item.trust.tier} />
                      </div>
                    </div>
                  </div>
                  {heroDescription && (
                    <p className="text-muted-foreground mb-4">
                      {heroDescription}
                    </p>
                  )}
                  <div className="flex items-center gap-2 flex-wrap">
                    {item.tags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="text-xs">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>

                {/* Details + install */}
                <div
                  data-testid="marketplace-detail-metadata"
                  className="grid grid-cols-1 gap-3 border-t border-border pt-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
                >
                  <div>
                    <p className="text-[10px] font-semibold tracking-widest uppercase text-muted-foreground mb-1">
                      Version
                    </p>
                    <p className="text-sm font-medium">v{item.version}</p>
                  </div>
                  {item.source.url && (
                    <div>
                      <p className="text-[10px] font-semibold tracking-widest uppercase text-muted-foreground mb-1">
                        Source
                      </p>
                      <a
                        href={item.source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-primary hover:underline inline-flex items-center gap-1"
                      >
                        {shortSource(item.source.url, item.source.locator)}{" "}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  )}
                  {installedPluginsError ? (
                    <Button
                      className="w-full"
                      variant="outline"
                      onClick={() => void refetchInstalledPlugins()}
                    >
                      Retry installation check
                    </Button>
                  ) : !installedStateReady ? (
                    <Button className="w-full" variant="outline" disabled>
                      Checking installationâ€¦
                    </Button>
                  ) : installedPlugin?.status === "ready" ? (
                    <div className="w-full flex items-center justify-center gap-2 bg-muted rounded-md px-4 py-2">
                      <span className="text-sm font-semibold text-green-400">
                        Installed
                      </span>
                      <span className="text-xs text-muted-foreground">
                        v{installedPlugin.version}
                      </span>
                    </div>
                  ) : installedPlugin ? (
                    <div className="w-full flex items-center justify-center gap-2 bg-muted rounded-md px-4 py-2">
                      <span className="text-sm font-semibold text-muted-foreground">
                        Pending
                      </span>
                      <span className="text-xs text-muted-foreground">
                        v{installedPlugin.version}
                      </span>
                    </div>
                  ) : (
                    <Button
                      className="w-full"
                      onClick={() => setInstallModalOpen(true)}
                    >
                      Install
                    </Button>
                  )}
                </div>
              </div>
            </div>

            <Separator />

            {/* ── Capabilities ───────────────────────────────────────────────────── */}
            {caps.length > 0 && (
              <section>
                <h2 className="text-lg font-semibold mb-3">
                  Capabilities
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    ({caps.length})
                  </span>
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {visibleCaps.map((cap) => (
                    <div
                      key={cap.id}
                      className="flex items-start gap-2 bg-muted/40 rounded-lg px-3 py-2.5"
                    >
                      <code className="text-[11px] bg-background border rounded px-1.5 py-0.5 shrink-0 mt-0.5 leading-snug">
                        {cap.id}
                      </code>
                      <span className="text-xs text-muted-foreground leading-relaxed">
                        {cap.description}
                      </span>
                    </div>
                  ))}
                </div>
                {hiddenCapsCount > 0 && (
                  <button
                    className="mt-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-border text-xs text-muted-foreground hover:text-foreground hover:border-muted-foreground transition-all"
                    onClick={() => setShowAllCaps(!showAllCaps)}
                  >
                    {showAllCaps ? (
                      <>
                        <ChevronUp className="h-3 w-3" /> Show less
                      </>
                    ) : (
                      <>
                        <ChevronDown className="h-3 w-3" /> Show{" "}
                        {hiddenCapsCount} more
                      </>
                    )}
                  </button>
                )}
              </section>
            )}

            {/* ── Dependencies ───────────────────────────────────────────────────── */}
            {item.requires && item.requires.length > 0 && (
              <section>
                <h2 className="text-lg font-semibold mb-3">Dependencies</h2>
                <ul className="space-y-1">
                  {item.requires.map((req) => (
                    <li key={req.id} className="text-sm">
                      <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                        {req.id}
                      </code>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* ── README ─────────────────────────────────────────────────────────── */}
            <section>
              <h2 className="text-lg font-semibold mb-3">README</h2>
              {readmeError ? (
                <p className="text-sm text-destructive">
                  Could not load README: {readmeError}
                </p>
              ) : readmeText === null ? (
                <p className="text-sm text-muted-foreground">Loading README…</p>
              ) : (
                <ReadmeRender source={readmeText} />
              )}
            </section>

            {item.type === "plugin" && (
              <PluginInstallModal
                item={item}
                open={installModalOpen}
                onOpenChange={setInstallModalOpen}
              />
            )}
            {item.type !== "plugin" && (
              <SnapshotInstallModal
                item={item}
                open={installModalOpen}
                onOpenChange={setInstallModalOpen}
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}
