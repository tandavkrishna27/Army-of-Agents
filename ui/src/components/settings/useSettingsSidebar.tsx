import { useLayoutEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Database,
  FlaskConical,
  HeartPulse,
  Lock,
  Puzzle,
  Settings as SettingsIcon,
  Shield,
} from "lucide-react";
import { useNavigate, useOutletContext } from "@/lib/router";
import { SecondarySidebar, type SecondarySidebarItem } from "@/components/SecondarySidebar";
import type { LobbyOutletContext } from "@/components/LobbyLayout";
import { healthApi, type HealthStatus } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";

export type SettingsSidebarKey =
  | "general"
  | "health"
  | "privacy"
  | "backups"
  | "heartbeats"
  | "experimental"
  | "plugins"
  | "access";

const ITEMS: Array<{
  key: SettingsSidebarKey;
  label: string;
  icon: SecondarySidebarItem["icon"];
}> = [
  { key: "general", label: "General", icon: <SettingsIcon /> },
  { key: "health", label: "Health", icon: <HeartPulse /> },
  { key: "privacy", label: "Privacy", icon: <Shield /> },
  { key: "backups", label: "Backups", icon: <Database /> },
  { key: "heartbeats", label: "Heartbeats", icon: <Activity /> },
  { key: "experimental", label: "Experimental", icon: <FlaskConical /> },
  { key: "plugins", label: "Plugins", icon: <Puzzle /> },
  { key: "access", label: "Access", icon: <Lock /> },
];

const CLOUD_RESTRICTED_ITEMS: ReadonlySet<SettingsSidebarKey> = new Set(["heartbeats", "access"]);

export type SettingsDeploymentState = "loading" | "error" | "cloud" | "available";

export function settingsDeploymentState(input: {
  health?: HealthStatus;
  isLoading: boolean;
  isError: boolean;
}): SettingsDeploymentState {
  if (input.isLoading) return "loading";
  if (input.isError || !input.health) return "error";
  return input.health.deploymentMode === "cloud_auth" ? "cloud" : "available";
}

/**
 * Builds the Instance Settings secondary sidebar (with the "Settings" panel
 * header) and pushes it to the persistent LobbyLayout via the outlet context.
 * Shared by InstanceSettingsPage (tabs via `?tab=`) and InstanceAccessPage (a
 * dedicated route) so both surfaces show the same sidebar with consistent chrome.
 * Every section navigates by URL: `access` → `/instance/access`, the rest →
 * `/instance/settings?tab=<key>`. Returns `pillItems` for the mobile sub-nav.
 */
export function useSettingsSidebar(activeKey: SettingsSidebarKey): {
  pillItems: SecondarySidebarItem[];
  deploymentState: SettingsDeploymentState;
  deploymentMode: HealthStatus["deploymentMode"] | undefined;
  retryDeploymentStatus: () => void;
} {
  const { setSecondarySidebar } = useOutletContext<LobbyOutletContext>();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const deploymentState = settingsDeploymentState({
    health: healthQuery.data,
    isLoading: healthQuery.isLoading,
    isError: healthQuery.isError,
  });

  const pillItems = useMemo<SecondarySidebarItem[]>(() => {
    const go = (key: SettingsSidebarKey) => {
      if (key === "access") navigate("/instance/access");
      else navigate(`/instance/settings?tab=${key}`);
    };
    const visibleItems =
      deploymentState === "available"
        ? ITEMS
        : ITEMS.filter((item) => !CLOUD_RESTRICTED_ITEMS.has(item.key));
    return visibleItems.map((it) => ({
      id: it.key,
      label: it.label,
      icon: it.icon,
      active: activeKey === it.key,
      onClick: () => go(it.key),
    }));
  }, [activeKey, deploymentState, navigate]);

  useLayoutEffect(() => {
    setSecondarySidebar(
      <SecondarySidebar
        title="Settings"
        sections={[{ items: pillItems }]}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
        floating
      />,
    );
    return () => setSecondarySidebar(null);
  }, [setSecondarySidebar, pillItems, collapsed]);

  return {
    pillItems,
    deploymentState,
    deploymentMode: healthQuery.data?.deploymentMode,
    retryDeploymentStatus: () => {
      void healthQuery.refetch();
    },
  };
}
