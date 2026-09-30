import { useCallback } from "react";
import { useSearchParams, useLocation } from "@/lib/router";
import {
  openOrActivate as openOrActivateReducer,
  closeTab as closeTabReducer,
  MEMORY_HOME_TAB,
  type MemoryTab,
  type MemoryTabKind,
  type TabKey,
  type TabsState,
} from "../lib/memoryTabs";

const TABS_PARAM = "tabs";
const ACTIVE_PARAM = "active";

const KINDS: ReadonlyArray<MemoryTabKind> = [
  "home",
  "memory_item",
  "asset",
  "graph",
  "open",
  "collection",
];

function isValidKind(value: string): value is MemoryTabKind {
  return (KINDS as readonly string[]).includes(value);
}

function encodeTab(tab: MemoryTab): string {
  return `${tab.kind}:${tab.id}:${encodeURIComponent(tab.title)}`;
}

function encodeKey(key: TabKey): string {
  return `${key.kind}:${key.id}`;
}

function decodeKey(value: string): TabKey | null {
  const idx = value.indexOf(":");
  if (idx < 0) return null;
  const kind = value.slice(0, idx);
  if (!isValidKind(kind)) return null;
  const id = value.slice(idx + 1);
  if (!id) return null;
  return { id, kind };
}

/**
 * Decode a single tab segment of the form `kind:id:title`. The segment is
 * already decoded (colons are literal). The title portion may still have
 * percent-encoded characters (e.g. %2C when the title contains a comma and
 * was stored via encodeURIComponent), which we decode here.
 */
function decodeTabDecoded(decoded: string): MemoryTab | null {
  const firstColon = decoded.indexOf(":");
  if (firstColon < 0) return null;
  const kind = decoded.slice(0, firstColon);
  if (!isValidKind(kind)) return null;
  const rest = decoded.slice(firstColon + 1);
  const secondColon = rest.indexOf(":");
  if (secondColon < 0) return null;
  const id = rest.slice(0, secondColon);
  if (!id) return null;
  try {
    const title = decodeURIComponent(rest.slice(secondColon + 1));
    return { id, kind, title };
  } catch {
    return null;
  }
}

function toActiveKey(tabs: MemoryTab[], candidate: TabKey | null): TabKey | null {
  if (candidate && tabs.some((t) => t.id === candidate.id && t.kind === candidate.kind)) {
    return candidate;
  }
  return tabs[0] ? { id: tabs[0].id, kind: tabs[0].kind } : null;
}

/**
 * Read tab state from the URLSearchParams object (as returned by
 * useSearchParams, or the `prev` argument in a setParams updater).
 *
 * `params.get(TABS_PARAM)` decodes the value once. For our own writes:
 * - Separator commas are decoded from %2C → literal `,`
 * - Title commas (originally encodeURIComponent'd to %2C, then stored via
 *   URLSearchParams.set which double-encodes to %252C) are decoded once to
 *   `%2C` — still percent-encoded, not a literal comma.
 * This means splitting by literal `,` correctly separates tabs, and the
 * remaining %2C in titles is decoded by decodeTabDecoded via decodeURIComponent.
 *
 * For initial-hydration URLs provided externally (e.g. MemoryRouter entries):
 * `params.get()` decodes %2C in title to a literal comma, which can't be
 * distinguished from the separator. That case is handled by readStateFromSearch.
 */
function readStateFromParams(params: URLSearchParams): TabsState {
  const raw = params.get(TABS_PARAM) ?? "";
  const tabs = raw
    ? raw
        .split(",")
        .map(decodeTabDecoded)
        .filter((t): t is MemoryTab => t !== null)
    : [];
  const rawActive = params.get(ACTIVE_PARAM);
  const candidate = rawActive ? decodeKey(rawActive) : null;
  return { tabs, activeKey: toActiveKey(tabs, candidate) };
}

/**
 * Extract a query param's raw (still percent-encoded) value from a raw search
 * string (e.g. `?tabs=foo%2Cbar&active=x`). Returns null when absent.
 * Reading the raw string (not URLSearchParams.get) avoids premature decoding
 * of %2C in title data before we split on the comma separator.
 */
function getRawParam(search: string, name: string): string | null {
  const qs = search.startsWith("?") ? search.slice(1) : search;
  for (const pair of qs.split("&")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 0) continue;
    try {
      const key = decodeURIComponent(pair.slice(0, eqIdx));
      if (key === name) return pair.slice(eqIdx + 1);
    } catch {
      // skip malformed pair
    }
  }
  return null;
}

/**
 * Split a raw tabs param value into individual tab segments.
 *
 * After URLSearchParams.set() writes the tabs value, the raw location.search
 * encodes BOTH the separator comma and internal commas as %2C. We detect this
 * case by checking whether the raw value contains %3A-encoded colons (our
 * own writes always encode colons), and if so split on %2C; otherwise the
 * string came from an external URL where the separator is a literal comma.
 */
function splitRawTabs(rawTabs: string): string[] {
  // If we see %3A (encoded colon), this was written by our setParams — split
  // on %2C as the tab separator. Each segment still has %3A colons inside.
  if (rawTabs.includes("%3A") || rawTabs.includes("%3a")) {
    return rawTabs.split("%2C").filter(Boolean).map(
      // Handle case-insensitivity of percent-encoding
      (s) => s.replace(/%2c/gi, "%2C"),
    );
  }
  // External URL — literal commas are tab separators.
  return rawTabs.split(",").filter(Boolean);
}

/**
 * Decode a single tab segment coming from the raw location.search.
 * The segment may be percent-encoded (from our setParams writes) or mostly
 * literal (from an externally-provided URL).
 */
function decodeTabFromRaw(rawSegment: string): MemoryTab | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawSegment);
  } catch {
    decoded = rawSegment;
  }
  return decodeTabDecoded(decoded);
}

/**
 * Read state from the raw location.search string. Used for the render path so
 * that initial hydration from an externally-supplied URL (e.g. MemoryRouter
 * initialEntries or a deep link) is parsed correctly — before URLSearchParams
 * has had a chance to double-encode values.
 */
function readStateFromSearch(search: string): TabsState {
  const rawTabs = getRawParam(search, TABS_PARAM);
  const tabs = rawTabs
    ? splitRawTabs(rawTabs)
        .map(decodeTabFromRaw)
        .filter((t): t is MemoryTab => t !== null)
    : [];

  const rawActive = getRawParam(search, ACTIVE_PARAM);
  const candidate = rawActive
    ? decodeKey(decodeURIComponent(rawActive))
    : null;
  return { tabs, activeKey: toActiveKey(tabs, candidate) };
}

function writeState(params: URLSearchParams, state: TabsState): URLSearchParams {
  if (state.tabs.length === 0) {
    params.delete(TABS_PARAM);
    params.delete(ACTIVE_PARAM);
  } else {
    params.set(TABS_PARAM, state.tabs.map(encodeTab).join(","));
    if (state.activeKey) {
      params.set(ACTIVE_PARAM, encodeKey(state.activeKey));
    } else {
      params.delete(ACTIVE_PARAM);
    }
  }
  return params;
}

export interface UseMemoryTabsResult {
  tabs: MemoryTab[];
  activeKey: TabKey | null;
  openOrActivate: (tab: MemoryTab) => void;
  openHome: () => void;
  close: (id: string, kind: MemoryTabKind) => void;
  setActive: (id: string, kind: MemoryTabKind) => void;
}

export function useMemoryTabs(): UseMemoryTabsResult {
  const [, setParams] = useSearchParams();
  const { search } = useLocation();

  // Render path: parse the raw location.search so that both externally-
  // supplied URLs (literal comma separators, %2C-encoded title commas) and
  // post-setParams URLs (%2C-encoded separators, %252C-encoded title commas)
  // are handled correctly.
  const state = readStateFromSearch(search);

  const openOrActivate = useCallback(
    (tab: MemoryTab) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        // Inside the updater `prev` was written by our writeState. Use
        // readStateFromParams (which uses params.get()) to correctly decode
        // the double-encoded values.
        const cur = readStateFromParams(next);
        const updated = openOrActivateReducer(cur, tab);
        return writeState(next, updated);
      });
    },
    [setParams],
  );

  const close = useCallback(
    (id: string, kind: MemoryTabKind) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        const cur = readStateFromParams(next);
        const updated = closeTabReducer(cur, id, kind);
        return writeState(next, updated);
      });
    },
    [setParams],
  );

  const setActive = useCallback(
    (id: string, kind: MemoryTabKind) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        const cur = readStateFromParams(next);
        const target: TabKey = { id, kind };
        const exists = cur.tabs.some((t) => t.id === id && t.kind === kind);
        if (!exists) return next; // no-op if the target tab isn't open
        return writeState(next, { tabs: cur.tabs, activeKey: target });
      });
    },
    [setParams],
  );

  const openHome = useCallback(() => {
    openOrActivate(MEMORY_HOME_TAB);
  }, [openOrActivate]);

  return {
    tabs: state.tabs,
    activeKey: state.activeKey,
    openOrActivate,
    openHome,
    close,
    setActive,
  };
}
