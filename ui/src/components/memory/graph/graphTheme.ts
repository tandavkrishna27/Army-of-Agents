import type { CompanyBrainNode } from "@armyofagents/shared";

export function graphCssColor(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

export function graphNodeColor(type: CompanyBrainNode["type"]): string {
  switch (type) {
    case "memory_item":
      return "var(--data-teal, #3fa8c7)";
    case "memory_folder":
      return "var(--entity-memory, #7e8aa8)";
    case "department":
    case "project":
      return "var(--data-indigo, #6470dc)";
    case "goal":
      return "var(--data-green, #4fb67e)";
    case "task":
      return "var(--data-amber, #d9a938)";
    case "agent":
    case "human":
      return "var(--data-magenta, #c25ba8)";
    case "artifact":
    case "memory_asset":
      return "var(--data-slate, #7e8aa8)";
    default:
      return "var(--data-slate, #7e8aa8)";
  }
}

export function graphNodeCanvasColor(type: CompanyBrainNode["type"]): string {
  switch (type) {
    case "memory_item":
      return graphCssColor("--data-teal", "#3fa8c7");
    case "memory_folder":
      return graphCssColor("--entity-memory", "#7e8aa8");
    case "department":
    case "project":
      return graphCssColor("--data-indigo", "#6470dc");
    case "goal":
      return graphCssColor("--data-green", "#4fb67e");
    case "task":
      return graphCssColor("--data-amber", "#d9a938");
    case "agent":
    case "human":
      return graphCssColor("--data-magenta", "#c25ba8");
    case "artifact":
    case "memory_asset":
      return graphCssColor("--data-slate", "#7e8aa8");
    default:
      return graphCssColor("--data-slate", "#7e8aa8");
  }
}

export function graphEdgeCanvasColor(sourceClass: string): string {
  if (sourceClass === "semantic") return "#3fa8c7";
  return "#6f7784";
}

export function graphEdgeColor(sourceClass: string): string {
  if (sourceClass === "semantic") {
    return "color-mix(in srgb, var(--data-teal, #3fa8c7) 62%, transparent)";
  }
  return "color-mix(in srgb, var(--border, #30343a) 82%, transparent)";
}
