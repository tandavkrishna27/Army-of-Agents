import type { SidebarMode } from "../context/SidebarContext";

export function getRouteSidebarMode(pathname: string): SidebarMode | null {
  const section = pathname.split(/[/?#]/).filter(Boolean)[1]?.toLowerCase();
  if (section === "commander" || section === "discussions") return "hidden";
  if (["settings", "team", "inbox", "skills"].includes(section ?? "")) return "compact";
  return null;
}
