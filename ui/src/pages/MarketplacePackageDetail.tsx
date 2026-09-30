import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { BadgeCheck, ChevronLeft, Github, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LobbyShellMobileMenuButton } from "@/components/LobbyShell";
import { StackedIcon } from "@/components/marketplace/StackedIcon";
import { ProviderLogo } from "@/components/marketplace/ProviderLogo";
import { PackageInstallModal } from "@/components/marketplace/install/PackageInstallModal";
import { CatalogCard } from "@/components/marketplace/CatalogCard";
import {
  shortSource,
  authorFromSource,
  isAoaPackage,
} from "@/lib/marketplace-constants";
import { useMarketplaceSidebar } from "@/components/marketplace/useMarketplaceSidebar";
import { useCatalog } from "@/hooks/useCatalog";
import { usePackages } from "@/hooks/usePackages";
import type { MarketplaceCatalogItem } from "@armyofagents/shared";
import { useCompany } from "@/context/CompanyContext";
import { listCompanyPlugins, type InstalledPlugin } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";

export default function MarketplacePackageDetail() {
  const params = useParams<{ id: string; "*": string }>();
  const restPath = params["*"] ?? "";
  const fullPackageId = restPath ? `${params.id}/${restPath}` : params.id ?? "";

  const { data: catalog, isLoading: catalogLoading } = useCatalog();
  const { data: packages, isLoading: packagesLoading } = usePackages();
  const [installOpen, setInstallOpen] = useState(false);
  const { selectedCompanyId } = useCompany();
  const {
    data: installedPlugins,
    error: installedPluginsError,
    refetch: refetchInstalledPlugins,
  } = useQuery({
    queryKey: queryKeys.plugins.companyList(selectedCompanyId ?? ""),
    queryFn: () => listCompanyPlugins(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const installedByPackageName = useMemo(
    () =>
      new Map(
        (installedPlugins ?? []).map((plugin: InstalledPlugin) => [
          plugin.packageName,
          plugin,
        ])
      ),
    [installedPlugins]
  );
  const installedStateReady =
    !!selectedCompanyId && installedPlugins !== undefined;

  const pkg = useMemo(
    () => packages?.find((p) => p.id === fullPackageId) ?? null,
    [packages, fullPackageId]
  );

  useMarketplaceSidebar(pkg && isAoaPackage(pkg) ? "aoa" : "skill");

  const memberItems = useMemo<MarketplaceCatalogItem[]>(() => {
    if (!pkg || !catalog) return [];
    const idSet = new Set(pkg.memberItemIds);
    return catalog.items.filter((it) => idSet.has(it.id));
  }, [pkg, catalog]);

  const isLoading = catalogLoading || packagesLoading;

  return (
    <>
      <div className="mx-auto w-full max-w-[920px] px-4 py-6 sm:px-6 sm:py-7 md:px-10 md:py-9">
        <LobbyShellMobileMenuButton className="mb-4" />
        <Link
          to="/marketplace"
          className="mb-4 inline-flex items-center gap-1 text-[12px] text-very-dim hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" /> Marketplace
        </Link>

        {isLoading && <div className="text-sm text-dim">Loading…</div>}

        {!isLoading && !pkg && (
          <div className="rounded-xl border border-border bg-card p-6 text-sm text-dim text-center">
            Package not found.
          </div>
        )}

        {!isLoading && pkg && (
          <div className="space-y-7">
            {/* Hero */}
            <div className="rounded-2xl border border-border-strong bg-card p-6 relative overflow-hidden">
              <span
                aria-hidden
                className="absolute left-0 top-6 bottom-6 w-[3px] rounded-r bg-amber-500"
              />
              <span
                data-testid="package-hero-badge"
                className="absolute right-5 top-5 inline-flex items-center gap-1.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-1 uppercase text-[10px] tracking-[0.1em] font-semibold text-amber-400 leading-none"
              >
                <span>PACKAGE</span>
                <span className="h-3 w-px bg-amber-500/30" aria-hidden />
                <span
                  className="tracking-normal"
                  aria-label={`${pkg.count} items`}
                >
                  {pkg.count}
                </span>
              </span>
              <div className="flex flex-col sm:flex-row items-start gap-5 pl-2 sm:pr-36">
                {pkg.provider ? (
                  <ProviderLogo
                    provider={pkg.provider}
                    className="size-20 shrink-0 rounded-2xl"
                  />
                ) : (
                  <StackedIcon
                    icon={Sparkles}
                    tone="amber"
                    className="size-20 shrink-0"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h1 className="text-2xl font-bold tracking-tight">
                      {pkg.name}
                    </h1>
                    {pkg.verified && (
                      <BadgeCheck
                        data-testid="package-hero-verified"
                        className="size-5 shrink-0 text-[hsl(208_80%_60%)]"
                        aria-label="Verified"
                      />
                    )}
                  </div>
                  <div className="mt-1 text-[12.5px] text-dim">
                    by {pkg.provider?.name ?? authorFromSource(pkg.sourceUrl)}
                  </div>
                  <div className="mt-3 flex items-center gap-3 text-[12px] text-very-dim flex-wrap">
                    <a
                      href={pkg.sourceUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1.5 hover:text-foreground"
                    >
                      <Github className="size-3.5" />{" "}
                      {shortSource(pkg.sourceUrl, pkg.id)}
                    </a>
                  </div>
                </div>
              </div>
              <div className="mt-6 flex justify-end pl-2">
                <Button
                  size="default"
                  className="text-[13px] font-semibold inline-flex items-center gap-1.5"
                  onClick={(e) => {
                    e.preventDefault();
                    setInstallOpen(true);
                  }}
                >
                  <Plus className="size-4" /> Install all {pkg.count} items
                </Button>
              </div>
            </div>

            {/* Included items grid */}
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[0.95rem] font-semibold tracking-tight">
                  Included items{" "}
                  <span className="text-very-dim font-normal text-[0.85rem]">
                    · {pkg.count}
                  </span>
                </h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                {memberItems.map((item) => (
                  <CatalogCard
                    key={item.id}
                    item={item}
                    installedByPackageName={installedByPackageName}
                    installedStateReady={installedStateReady}
                    installedStateError={installedPluginsError != null}
                    onRetryInstalledState={() => void refetchInstalledPlugins()}
                  />
                ))}
              </div>
            </div>
            <PackageInstallModal
              pkg={pkg}
              memberItems={memberItems}
              open={installOpen}
              onOpenChange={setInstallOpen}
            />
          </div>
        )}
      </div>
    </>
  );
}
