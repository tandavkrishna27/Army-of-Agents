import type { LobbySidebarItem } from "@/components/LobbySidebar";

/** Derive which lobby sidebar row is active from the current route path. */
export function lobbyActiveItem(pathname: string): LobbySidebarItem {
  const path = pathname.split("?")[0];
  if (path.startsWith("/marketplace")) return "marketplace";
  // Instance Access renders inside the Settings shell (shared secondary sidebar),
  // so it belongs to the Settings top-level nav section too.
  if (path.startsWith("/instance/settings") || path.startsWith("/instance/access"))
    return "settings";
  // "/" and everything else default to the organizations list.
  return "organizations";
}
