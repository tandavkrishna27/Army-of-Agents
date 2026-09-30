import { useCallback, useEffect, useState } from "react";
import { closeTab as closeTabHelper } from "../../lib/viewer-tabs";
import { HOME_TAB, type HubTab } from "./hubViewerModel";

/** Max open tabs INCLUDING the Home tab (Home + newest closeable are kept). */
export const HUB_TABS_MAX = 12;

const STORAGE_VERSION = 1;
const storageKey = (companyId: string) => `aoa:hub:tabs:${companyId}`;

interface PersistedBlob {
  version: number;
  tabs: HubTab[];
}

function isHubTab(value: unknown): value is HubTab {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as HubTab).key === "string" &&
    typeof (value as HubTab).kind === "string"
  );
}

/**
 * Canonical tab set: Home first + non-closeable, closeable tabs deduped by key
 * in order, capped to HUB_TABS_MAX by dropping the OLDEST closeable tabs.
 */
function normalize(tabs: HubTab[]): HubTab[] {
  const seen = new Set<string>();
  const closeables: HubTab[] = [];
  for (const tab of tabs) {
    if (!isHubTab(tab) || tab.key === HOME_TAB.key) continue;
    if (seen.has(tab.key)) continue;
    seen.add(tab.key);
    closeables.push(tab);
  }
  const capped = closeables.slice(Math.max(0, closeables.length - (HUB_TABS_MAX - 1)));
  return [HOME_TAB, ...capped];
}

function rehydrate(companyId: string | undefined): HubTab[] {
  if (!companyId) return [HOME_TAB];
  try {
    const raw = localStorage.getItem(storageKey(companyId));
    if (!raw) return [HOME_TAB];
    const blob = JSON.parse(raw) as PersistedBlob | null;
    if (!blob || blob.version !== STORAGE_VERSION || !Array.isArray(blob.tabs)) {
      return [HOME_TAB];
    }
    return normalize(blob.tabs);
  } catch {
    return [HOME_TAB];
  }
}

function persist(companyId: string | undefined, tabs: HubTab[]): void {
  if (!companyId) return;
  try {
    localStorage.setItem(
      storageKey(companyId),
      JSON.stringify({ version: STORAGE_VERSION, tabs } satisfies PersistedBlob),
    );
  } catch {
    // localStorage unavailable / quota exceeded — persistence is best-effort.
  }
}

function hubItemIdForTab(tab: HubTab): string | undefined {
  return (tab.payload as { hubItemId?: string } | undefined)?.hubItemId;
}

function upsertTab(tabs: HubTab[], tab: HubTab): HubTab[] {
  const index = tabs.findIndex((existing) => existing.key === tab.key);
  if (index === -1) return [...tabs, tab];
  if (!hubItemIdForTab(tab)) return tabs;
  return tabs.map((existing, existingIndex) => (existingIndex === index ? tab : existing));
}

/**
 * Tab manager for the Inbox hub (mirrors ThreadsWorkspace's tab state, hub-specific
 * re-activation). Home tab is always present + non-closeable; the open set persists
 * per company in localStorage (versioned, capped, corruption-safe).
 */
export function useHubTabs(companyId: string | undefined) {
  const [tabs, setTabs] = useState<HubTab[]>(() => rehydrate(companyId));
  const [activeKey, setActiveKey] = useState<string | null>(HOME_TAB.key);
  const [hydratedCompanyId, setHydratedCompanyId] = useState<string | undefined>(companyId);

  const openTab = useCallback((tab: HubTab) => {
    setTabs((current) => {
      const next = upsertTab(current, tab);
      return next.length > HUB_TABS_MAX ? normalize(next) : next;
    });
    setActiveKey(tab.key);
  }, []);

  const closeTab = useCallback((key: string) => {
    setTabs((current) => {
      const next = closeTabHelper(current, key);
      // Hub re-activation: the LAST remaining tab (not threads' first).
      setActiveKey((active) => (active !== key ? active : (next.at(-1)?.key ?? null)));
      return next;
    });
  }, []);

  const activateTab = useCallback((key: string) => setActiveKey(key), []);

  useEffect(() => {
    if (hydratedCompanyId === companyId) return;
    setTabs(rehydrate(companyId));
    setActiveKey(HOME_TAB.key);
    setHydratedCompanyId(companyId);
  }, [companyId, hydratedCompanyId]);

  useEffect(() => {
    if (hydratedCompanyId !== companyId) return;
    persist(companyId, tabs);
  }, [companyId, hydratedCompanyId, tabs]);

  return { tabs, activeKey, openTab, closeTab, activateTab };
}
