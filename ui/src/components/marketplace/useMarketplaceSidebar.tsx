import { useLayoutEffect, useMemo, useState } from "react";
import { Bot, Cable, Home, Puzzle, Sparkles, Users } from "lucide-react";
import type { MarketplaceItemType } from "@armyofagents/shared";
import { useNavigate, useOutletContext } from "@/lib/router";
import { useCatalog } from "@/hooks/useCatalog";
import { usePackages } from "@/hooks/usePackages";
import { deriveMarketplacePlacement } from "@/lib/marketplace-constants";
import {
  SecondarySidebar,
  type SecondarySidebarItem,
  type SecondarySidebarSection,
} from "@/components/SecondarySidebar";
import type { LobbyOutletContext } from "@/components/LobbyLayout";

/**
 * `"connector"` is a SIDEBAR key only — deliberately not a `MarketplaceItemType`.
 * Connectors are served by their own company-scoped endpoint and must never enter
 * `MarketplaceItemTypeSchema`: `catalog.json` is parsed with a whole-array
 * `z.enum`, so one unknown item type fails the whole parse and the sync failure
 * path preserves the stale cache — freezing skills and agents fleet-wide.
 */
export type MarketplaceSidebarKey = "home" | MarketplaceItemType | "aoa" | "connector";

/**
 * Builds the marketplace floating secondary sidebar (Home / Skills / Plugins /
 * Agents / Teams / Connectors | AoA), pushes it to the persistent LobbyLayout via the outlet
 * context, and returns `pillItems` for the mobile sub-nav (§8.6). Type counts
 * exclude AoA items; the AoA entry counts AoA-first-party items. Called by every
 * marketplace page so the sidebar chrome is consistent.
 */
export function useMarketplaceSidebar(activeKey: MarketplaceSidebarKey): {
  pillItems: SecondarySidebarItem[];
} {
  const { setSecondarySidebar } = useOutletContext<LobbyOutletContext>();
  const navigate = useNavigate();
  const { data: catalog } = useCatalog();
  const { data: packages } = usePackages();
  const [collapsed, setCollapsed] = useState(false);

  const counts = useMemo(() => {
    // Package membership is part of placement, not optional decoration. Until
    // both queries resolve, omit counts instead of temporarily counting AoA
    // package members in Home/Skills.
    if (!catalog || packages === undefined) return null;
    const placement = deriveMarketplacePlacement(catalog.items, packages);
    const main = placement.mainItems;
    return {
      home: main.length,
      skill: main.filter((i) => i.type === "skill").length,
      plugin: main.filter((i) => i.type === "plugin").length,
      agent: main.filter((i) => i.type === "agent").length,
      team: main.filter((i) => i.type === "team").length,
      aoa: placement.aoaItems.length + placement.aoaPackages.length,
    };
  }, [catalog, packages]);

  const pillItems = useMemo<SecondarySidebarItem[]>(() => {
    const go = (key: MarketplaceSidebarKey) => {
      if (key === "home") navigate("/marketplace");
      else if (key === "aoa") navigate("/marketplace?view=aoa");
      // Static path, not `?type=` — connectors are not catalog items, so they
      // never travel through the type query param or `pathToItemType()`.
      else if (key === "connector") navigate("/marketplace/connectors");
      else navigate(`/marketplace?type=${key}`);
    };
    const mk = (
      id: MarketplaceSidebarKey,
      label: string,
      icon: SecondarySidebarItem["icon"],
    ): SecondarySidebarItem => ({
      id,
      label,
      icon,
      // Connectors carry no count: their catalog is company-scoped AND
      // founder-only, so fetching it just to badge the rail would fire a
      // privileged request from every marketplace page, for every role.
      count:
        id === "connector"
          ? undefined
          : counts?.[id as keyof NonNullable<typeof counts>],
      active: activeKey === id,
      onClick: () => go(id),
    });
    return [
      mk("home", "Home", <Home />),
      mk("skill", "Skills", <Sparkles />),
      mk("plugin", "Plugins", <Puzzle />),
      mk("agent", "Agents", <Bot />),
      mk("team", "Teams", <Users />),
      mk("connector", "Connectors", <Cable />),
      mk("aoa", "AoA", <Sparkles className="text-brand" />),
    ];
  }, [counts, activeKey, navigate]);

  const sections = useMemo<SecondarySidebarSection[]>(
    () => [{ items: pillItems.slice(0, 6) }, { items: pillItems.slice(6) }],
    [pillItems],
  );

  useLayoutEffect(() => {
    setSecondarySidebar(
      <SecondarySidebar
        title="Marketplace"
        sections={sections}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
        floating
      />,
    );
    return () => setSecondarySidebar(null);
  }, [setSecondarySidebar, sections, collapsed]);

  return { pillItems };
}
