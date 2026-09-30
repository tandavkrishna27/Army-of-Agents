import { useMemo } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { useCatalog } from "@/hooks/useCatalog";
import { usePackages } from "@/hooks/usePackages";
import { CatalogCard } from "@/components/marketplace/CatalogCard";
import { LobbyShellMobileMenuButton } from "@/components/LobbyShell";
import { useMarketplaceSidebar } from "@/components/marketplace/useMarketplaceSidebar";
import { searchItems, filterByCategory, groupByType } from "@/api/marketplace";
import {
  TYPE_LABELS_PLURAL,
  deriveMarketplacePlacement,
} from "@/lib/marketplace-constants";
import { listCompanyPlugins, type InstalledPlugin } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import type { MarketplaceItemType } from "@armyofagents/shared";
import { useCompany } from "@/context/CompanyContext";

const TYPES: MarketplaceItemType[] = ["plugin", "skill", "agent", "team"];

export default function MarketplaceSearch() {
  const [searchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const category = searchParams.get("category") ?? "";

  const { data: catalog, error: catalogError } = useCatalog();
  const { data: packages, error: packagesError } = usePackages();
  useMarketplaceSidebar("home");
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
        (installedPlugins ?? []).map((p: InstalledPlugin) => [p.packageName, p])
      ),
    [installedPlugins]
  );
  const installedStateReady =
    !!selectedCompanyId && installedPlugins !== undefined;

  const grouped = useMemo(() => {
    if (!catalog || packages === undefined) return null;
    let items = deriveMarketplacePlacement(catalog.items, packages).mainItems;
    if (category) items = filterByCategory(items, category);
    if (q.trim()) items = searchItems(items, q);
    return groupByType(items);
  }, [catalog, packages, q, category]);
  const placementError =
    (catalog === undefined ? catalogError : null) ??
    (packages === undefined ? packagesError : null);
  const placementLoading = grouped === null && placementError == null;

  const totalCount = grouped
    ? Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0)
    : 0;

  return (
    <>
      <div className="mx-auto w-full max-w-[1080px] px-4 py-6 sm:px-6 sm:py-7 md:px-10 md:py-9">
        <LobbyShellMobileMenuButton className="mb-4" />

        {placementLoading ? (
          <div className="space-y-6">
            <Skeleton className="h-8 w-64" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-40" />
              ))}
            </div>
          </div>
        ) : placementError ? (
          <div className="text-center py-12">
            <p className="text-lg font-medium">Could not load search results</p>
            <p className="text-sm text-muted-foreground mt-2">
              {placementError.message || "Unknown error"}
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            <div>
              <h1 className="text-2xl font-semibold">
                {q ? `Search: "${q}"` : "All items"}
                {category && (
                  <span className="text-muted-foreground">
                    {" "}
                    · category: {category}
                  </span>
                )}
              </h1>
              <p className="text-sm text-muted-foreground">
                {totalCount} {totalCount === 1 ? "result" : "results"}
              </p>
            </div>

            {totalCount === 0 ? (
              <div className="text-center py-12">
                <p className="text-muted-foreground">
                  No items match your search.
                </p>
                <Link
                  to="/marketplace"
                  className="text-sm text-primary hover:underline mt-2 inline-block"
                >
                  ← Back to marketplace
                </Link>
              </div>
            ) : (
              TYPES.map((type) => {
                const items = grouped![type];
                if (items.length === 0) return null;
                return (
                  <section key={type}>
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="text-lg font-semibold">
                        {TYPE_LABELS_PLURAL[type]}
                      </h2>
                      <Link
                        to={`/marketplace/${type}`}
                        className="text-xs text-primary hover:underline"
                      >
                        See all →
                      </Link>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {items.map((item) => (
                        <CatalogCard
                          key={item.id}
                          item={item}
                          installedByPackageName={installedByPackageName}
                          installedStateReady={installedStateReady}
                          installedStateError={installedPluginsError != null}
                          onRetryInstalledState={() =>
                            void refetchInstalledPlugins()
                          }
                        />
                      ))}
                    </div>
                  </section>
                );
              })
            )}
          </div>
        )}
      </div>
    </>
  );
}
